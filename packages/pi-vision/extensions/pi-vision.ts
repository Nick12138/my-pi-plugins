/**
 * pi-vision — 让"文字型"模型看懂图片的插件。
 *
 * 只暴露一个工具 `see_image`：把图片（截图 / 照片 / 文件路径 / data URL）连同
 * 一个问题一起发给视觉模型，把视觉模型的回答作为工具结果返回。
 * 主要服务于不具备识图能力的模型——它们照常推理，需要看图时调这个工具即可。
 *
 * 模型选择（含自动回退）：
 *
 *   单次调用可用 model 参数临时指定（优先级最高，仅本次生效）
 *     ↓ 缺省
 *   PI_VISION_MODEL（默认视觉模型，格式 "provider/modelId"）
 *     ↓ 缺省
 *   auto：仅从"用户已配置且非 OAuth"的视觉模型中随机选择一个（见下），
 *         失败后自动尝试其他已配置的视觉模型
 *     ↓ 成功
 *   成功模型会提升为下一次自动调用的首选模型
 *   PI_VISION_FALLBACK_MODELS（显式默认模型时的回退模型，逗号分隔，按顺序尝试）
 *
 * auto 模式的候选范围：只认"用户已配置"的模型 —— provider 有可用认证
 * （models.json / auth.json / 运行时 key / 环境变量），且不是 OAuth 登录的
 * provider（如 openrouter、anthropic 等内置 OAuth 模型）。这样自动选择不会
 * 随机挑中用户根本没有配置过的 OAuth / 内置目录模型。显式配置（PI_VISION_MODEL、
 * 回退列表、model 参数）不受此限制，仍按用户填写的内容解析。
 *
 * 参照实现（致谢）：
 *   - pi-vision-tool    —— describe_image 工具形态（tool 委托视觉模型）
 *   - pi-image-fallback —— 通过 modelRegistry 解析模型、走 pi-ai 统一调用
 *
 * 配置（环境变量，通常由插件配置界面注入，见仓库根目录 plugins.json）：
 *   - PI_VISION_MODEL            : 默认视觉模型 "provider/modelId"（text）
 *   - PI_VISION_FALLBACK_MODELS  : 回退模型列表，英文逗号分隔（text）
 *   - PI_VISION_MAX_TOKENS       : 单次视觉调用最大输出 token，默认 4096
 *   - PI_VISION_TIMEOUT_MS       : 单次视觉调用超时毫秒，默认 90000
 *
 * 交互：
 *   - /vision 查看当前配置与解析结果
 *   - 工具运行时底部状态栏显示 👁 标记指向的视觉模型
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── 常量 ─────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TOKENS = 4096;

const VISION_SYSTEM_PROMPT = [
	"You are an expert vision analysis assistant.",
	"Examine the provided image(s) and respond to the user's request precisely.",
	"",
	"Guidelines:",
	"- Your reply is read by a text-only model that cannot see the image. Leave nothing important out.",
	"- If asked for a description, describe everything you see thoroughly.",
	"- If asked to read text, extract all visible text verbatim (code, errors, UI labels, tables).",
	"- If asked for coordinates, provide them in [x, y, width, height] format.",
	"- If asked about UI elements, describe their appearance, position, and state.",
	"- Be precise and factual. Do not invent details that are not in the image.",
].join("\n");

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
};

// ── 工具函数 ─────────────────────────────────────────────────────────────

interface ModelRef {
	provider: string;
	id: string;
}

/** 解析 "provider/modelId"（只在第一个 "/" 处分割，兼容 openrouter 的 "openai/gpt-4o" 形式）。 */
function parseModelRef(value: string | undefined): ModelRef | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** 解析回退列表：英文逗号分隔的 "provider/modelId"。忽略空项和格式错误的项。 */
function parseFallbackRefs(value: string | undefined): ModelRef[] {
	if (!value?.trim()) return [];
	return value
		.split(",")
		.map((part) => parseModelRef(part))
		.filter((ref): ref is ModelRef => ref !== undefined);
}

function envTimeoutMs(): number {
	const n = parseInt(process.env.PI_VISION_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : REQUEST_TIMEOUT_MS;
}

function envMaxTokens(): number {
	const n = parseInt(process.env.PI_VISION_MAX_TOKENS ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function toolError(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details, isError: true as const };
}

/** 读取图片：支持文件路径（相对路径按 cwd 解析）与 data URL。返回 base64 + mimeType。 */
async function loadImage(image: string, cwd: string): Promise<{ mimeType: string; data: string }> {
	const trimmed = image.trim();

	const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(trimmed);
	if (dataUrl) {
		return { mimeType: dataUrl[1], data: dataUrl[2].replace(/\s+/g, "") };
	}

	if (/^https?:\/\//i.test(trimmed)) {
		throw new Error("HTTP(S) 链接暂不支持，请先把图片保存为本地文件再调用。");
	}

	const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	const buffer = await readFile(path);
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return { mimeType: MIME_BY_EXT[ext] ?? "image/png", data: buffer.toString("base64") };
}

// ── 模型解析与调用 ───────────────────────────────────────────────────────

interface VisionCandidate {
	/** 展示用引用字符串，例如 "openai/gpt-4o-mini" 或 "auto" */
	ref: string;
	model: Model<Api> | undefined;
	/** 不可用原因（找到模型但有致命问题时填写，例如不支持图片输入） */
	unusable?: string;
}

// 自动模式只在当前插件进程内记住成功模型；显式配置模型不会改变它。
let autoPreferredModelRef: string | undefined;

/**
 * auto 模式只认可"用户已配置"的视觉模型：
 * - provider 有可用认证（models.json / auth.json / 运行时 key / 环境变量），且
 * - 不是 OAuth 登录的 provider（内置 OAuth 目录模型一律排除）。
 * 这样自动选择不会随机挑中用户根本没有配置过的 OAuth / 内置目录模型。
 */
function isUserConfiguredModel(ctx: ExtensionContext, model: Model<Api>): boolean {
	const status = ctx.modelRegistry.getProviderAuthStatus(model.provider);
	if (!status.configured) return false;
	if (ctx.modelRegistry.isUsingOAuth(model)) return false;
	return true;
}

function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** 按优先级组装候选列表：调用参数 > 默认模型（PI_VISION_MODEL / auto）> 回退列表。 */
function buildCandidates(ctx: ExtensionContext, overrideRef: string | undefined): VisionCandidate[] {
	const candidates: VisionCandidate[] = [];
	const seen = new Set<string>();

	const push = (ref: string, model: Model<Api> | undefined) => {
		if (!model) {
			candidates.push({ ref, model });
			return;
		}
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		const unusable = model.input?.includes("image")
			? undefined
			: "该模型未声明 image 输入（models.json 里的 input 数组需包含 \"image\"）";
		candidates.push({ ref, model, unusable });
	};

	// 1. 工具参数临时指定
	if (overrideRef) {
		const parsed = parseModelRef(overrideRef);
		push(overrideRef, parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined);
		return [...candidates, ...fallbacks(ctx)]; // 显式指定后仍然允许回退
	}

	// 2. 默认模型：env 指定，否则 auto 使用全部可用的视觉模型。
	const envRef = parseModelRef(process.env.PI_VISION_MODEL);
	if (envRef) {
		push(`${envRef.provider}/${envRef.id}`, ctx.modelRegistry.find(envRef.provider, envRef.id));
	} else {
		const autoModels = ctx.modelRegistry
			.getAll()
			.filter((m) => m.input?.includes("image"))
			.filter((m) => isUserConfiguredModel(ctx, m));
		let preferred = autoPreferredModelRef
			? autoModels.find((m) => modelRef(m) === autoPreferredModelRef)
			: undefined;
		if (!preferred && autoModels.length > 0) {
			preferred = autoModels[Math.floor(Math.random() * autoModels.length)];
			autoPreferredModelRef = modelRef(preferred);
		}
		const ordered = preferred
			? [preferred, ...autoModels.filter((m) => m !== preferred)]
			: autoModels;

		if (ordered.length === 0) {
			push("auto（无已配置的视觉模型）", undefined);
		} else {
			for (const model of ordered) push(modelRef(model), model);
		}
	}

	return [...candidates, ...fallbacks(ctx)];

	function fallbacks(c: ExtensionContext): VisionCandidate[] {
		return parseFallbackRefs(process.env.PI_VISION_FALLBACK_MODELS).map((ref) => ({
			ref: `${ref.provider}/${ref.id}`,
			model: c.modelRegistry.find(ref.provider, ref.id),
			unusable: undefined,
		})).map((cand) => {
			if (cand.model && !cand.model.input?.includes("image")) {
				return { ...cand, unusable: "该模型未声明 image 输入" };
			}
			return cand;
		}).filter((cand) => {
			if (!cand.model) return true;
			const key = `${cand.model.provider}/${cand.model.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
}

/** 单次视觉调用。成功返回文本；失败抛错（由调用方决定是否回退下一个候选）。 */
async function callVisionModel(
	ctx: ExtensionContext,
	model: Model<Api>,
	image: { mimeType: string; data: string },
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(`无法解析 ${model.provider} 的 API Key：${auth.error}`);
	}
	if (!auth.apiKey && !ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`模型 ${model.provider}/${model.id} 没有可用的 API Key`);
	}

	const res = await complete(
		model,
		{
			systemPrompt: VISION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					timestamp: Date.now(),
					content: [
						{ type: "image" as const, data: image.data, mimeType: image.mimeType },
						{ type: "text" as const, text: prompt },
					],
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: envMaxTokens(),
			temperature: 0,
			signal: requestSignal(signal, envTimeoutMs()),
		},
	);

	if (res.stopReason === "error" || res.stopReason === "aborted") {
		throw new Error(res.errorMessage?.trim() || `视觉调用结束于 ${res.stopReason}`);
	}

	const text = res.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (!text) throw new Error("视觉模型返回了空内容");
	return text;
}

function configSummary(ctx: ExtensionContext | ExtensionCommandContext): string {
	const envModel = process.env.PI_VISION_MODEL?.trim() || "（未设置 → auto）";
	const envFallbacks = process.env.PI_VISION_FALLBACK_MODELS?.trim() || "（未设置）";
	const lines = [
		"pi-vision 配置",
		`  默认视觉模型:    ${envModel}`,
		`  回退模型:        ${envFallbacks}`,
		`  max tokens:      ${envMaxTokens()}`,
		`  超时:            ${envTimeoutMs()}ms`,
		"",
		"候选解析（按尝试顺序）:",
		...buildCandidates(ctx, undefined).map((c, i) => {
			const name = c.model ? `${c.model.provider}/${c.model.id}` : "（注册表中未找到）";
			return `  ${i + 1}. [${c.ref}] ${name}${c.unusable ? ` — ${c.unusable}` : ""}`;
		}),
		"",
		"auto 模式说明: 只从'用户已配置且非 OAuth'的 provider 中选择视觉模型；",
		"  未配置 / OAuth 登录的 provider（如 openrouter、anthropic 内置目录）不会被自动选中。",
		"",
		"配置方式（环境变量，PiDeck 配置界面注入）:",
		"  PI_VISION_MODEL=provider/modelId            默认视觉模型",
		"  PI_VISION_FALLBACK_MODELS=a/x,b/y           回退模型，逗号分隔",
		"  或在调用 see_image 时传 model 参数临时指定。",
	];
	return lines.join("\n");
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	function updateStatus(ctx: ExtensionContext | ExtensionCommandContext, suffix?: string): void {
		const first = buildCandidates(ctx, undefined).find((c) => c.model && !c.unusable);
		ctx.ui.setStatus(
			"pi-vision",
			first?.model ? `👁 ${first.model.id}${suffix ? ` ${suffix}` : ""}` : undefined,
		);
	}

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.registerCommand("vision", {
		description: "查看 pi-vision 视觉模型配置与候选解析结果",
		handler: async (_args, ctx) => {
			ctx.ui.notify(configSummary(ctx), "info");
		},
	});

	pi.registerTool({
		name: "see_image",
		label: "See Image (Vision)",
		description:
			"用视觉模型理解一张图片（截图、照片、图片文件），返回文字分析结果。" +
			"适用于需要根据图片内容作答的任何场景：UI 截图、报错弹窗、图表、照片、扫描件等。" +
			"image 支持本地文件路径或 data:image/...;base64 形式的 data URL。" +
			"prompt 是你想从图片里得到什么，写得越具体越好。" +
			"可选 model 参数临时指定视觉模型（格式 provider/modelId，仅本次调用生效）；不指定则自动从已配置（非 OAuth）的视觉模型中首选，失败时自动按序尝试其他已配置模型。",
		promptSnippet: "用视觉模型解析图片内容（截图/照片/图片），支持默认模型 + 回退模型",
		promptGuidelines: [
			"需要看懂截图、报错弹窗、UI 界面、图表、照片等任何图片内容时，调用 see_image；在 prompt 里写明你具体要从图中获取什么。",
			"see_image 的 image 参数接受本地文件路径（如截图文件的绝对路径）或 data:image/...;base64 的 data URL。",
			"see_image 自动使用最近一次成功的视觉模型，失败会自动尝试其他可用模型并记住新的成功模型；仅在需要临时换模型时传 model 参数（provider/modelId）。",
		],
		parameters: Type.Object({
			image: Type.String({
				description:
					"图片位置：本地文件路径（相对路径按当前工作目录解析）或 data:image/png;base64,... 形式的 data URL",
			}),
			prompt: Type.String({
				description:
					"想让视觉模型从图中分析/提取的内容，越具体越好。例如：\"逐字提取图中所有文字\"、\"这个报错是什么意思？\"、\"描述页面布局与可交互元素\"、\"顶部导航栏是什么颜色？\"",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"临时指定视觉模型，格式 provider/modelId（仅本次调用生效，优先级最高）。不指定则走配置的默认视觉模型。",
				}),
			),
		}),

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("see_image"));
			const promptLine = theme.fg(
				"dim",
				`prompt: ${args.prompt.length > 120 ? args.prompt.slice(0, 117) + "..." : args.prompt}`,
			);
			const modelLine = args.model ? theme.fg("dim", `model: ${args.model}`) : undefined;
			return new Text(
				[title, `  ${promptLine}`, ...(modelLine ? [`  ${modelLine}`] : [])].join("\n"),
				0,
				0,
			);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// 读取图片（只读一次，回退时不必重复读盘）
			let image: { mimeType: string; data: string };
			try {
				image = await loadImage(params.image, ctx.cwd);
			} catch (err) {
				return toolError(`无法读取图片 "${params.image}"：${messageOf(err)}`, {
					error: "image_read_error",
				});
			}

			const candidates = buildCandidates(ctx, params.model);
			const attempts: string[] = [];
			const autoSelection = !params.model && !parseModelRef(process.env.PI_VISION_MODEL);

			for (const cand of candidates) {
				const refName = cand.model ? `${cand.model.provider}/${cand.model.id}` : cand.ref;

				if (!cand.model) {
					attempts.push(`${refName}：注册表中未找到该模型（确认 provider/modelId 是否已配置到 models.json）`);
					continue;
				}
				if (cand.unusable) {
					attempts.push(`${refName}：${cand.unusable}`);
					continue;
				}
				if (signal?.aborted) {
					return toolError("已取消。", { error: "aborted", attempts });
				}

				ctx.ui.setStatus("pi-vision", `👁 ${cand.model.id} …`);
				onUpdate?.({
					content: [{ type: "text", text: `正在用 ${refName} 分析图片…` }],
					details: { model: refName, status: "analyzing" },
				});

				try {
					const text = await callVisionModel(ctx, cand.model, image, params.prompt, signal);
					if (autoSelection) autoPreferredModelRef = modelRef(cand.model);
					const usedFallback = attempts.length > 0;
					const prefix = usedFallback
						? `（默认模型不可用，已由 ${refName} 回退完成。失败记录：${attempts.join("；")}）\n\n`
						: "";
					return toolResult(prefix + text, {
						model: refName,
						fallback: usedFallback,
						attempts,
						prompt: params.prompt,
					});
				} catch (err) {
					if (signal?.aborted) {
						return toolError("已取消。", { error: "aborted", attempts });
					}
					attempts.push(`${refName}：${messageOf(err)}`);
				} finally {
					updateStatus(ctx);
				}
			}

			return toolError(
				[
					"所有视觉模型候选均失败：",
					...attempts.map((a, i) => `  ${i + 1}. ${a}`),
					"",
					"请检查配置：",
					"  PI_VISION_MODEL=provider/modelId          默认视觉模型",
					"  PI_VISION_FALLBACK_MODELS=a/x,b/y         回退模型（逗号分隔）",
					"可用 /vision 查看当前配置与候选解析结果。",
				].join("\n"),
				{ error: "all_failed", attempts },
			);
		},
	});
}
