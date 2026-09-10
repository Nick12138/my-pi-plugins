/**
 * pi-vision — 让"文字型"模型看懂图片的插件。
 *
 * 只暴露三个工具：`see_image`（单图）、`see_images`（多图批量，单次上限
 * PI_VISION_MAX_BATCH，默认 5）与 `see_job`（异步看图任务队列，对标 pi-anytomd 的
 * anyjob）：把图片（截图 / 照片 / 文件路径 / data URL）连同一个问题一起发给视觉模型，
 * 把视觉模型的回答作为工具结果返回。
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
 * 异步批量（see_job）：
 *   大批量图片分析可提交后台任务队列，submit 立即返回 job-id 不阻塞当前回合，
 *   任务记录与结果落盘 ~/.pi/vision-jobs/（status/wait/cancel/list 跨会话可查）。
 *   与 pi-anytomd 的 anyjob 的差异：视觉调用依赖 pi 进程内的模型注册表（模型解析 /
 *   认证 / 回退），无法拆成独立 detached 进程，因此采用「进程内后台队列 + 磁盘持久
 *   化」——pi 退出后，排队/运行中的任务会在下次查询时被 stale 检测自动标记 failed。
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
 *   - PI_VISION_MAX_BATCH        : see_images 单次调用最多图片数，默认 5
 *   - PI_VISION_MAX_CONCURRENT   : see_job 后台分析并发数，默认 2（上限 8）
 *   - PI_VISION_JOBS_DIR         : see_job 任务库目录覆盖（测试用），默认 ~/.pi/vision-jobs
 *
 * 交互：
 *   - /vision 查看当前配置与解析结果
 *   - 工具运行时底部状态栏显示 👁 标记指向的视觉模型
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	cancelJob,
	createJob,
	HEARTBEAT_MS,
	JOBS_DIR,
	JOBS_ROOT,
	listJobs,
	redactImageRef,
	readJob,
	touchHeartbeat,
	updateJob,
	waitJob,
	writeJobResult,
} from "../vision-jobs.mjs";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── 常量 ─────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_BATCH = 5;

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

/** see_images 单次调用的图片上限；配置非法或小于 1 时回退默认值。 */
function envMaxBatch(): number {
	const n = parseInt(process.env.PI_VISION_MAX_BATCH ?? "", 10);
	return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_BATCH;
}

/** see_job 后台分析并发数；未配置或非法时回退 2，封顶 8。 */
function envMaxConcurrent(): number {
	const n = parseInt(process.env.PI_VISION_MAX_CONCURRENT ?? "", 10);
	return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2;
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
	images: ReadonlyArray<{ mimeType: string; data: string }>,
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
						...images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
						{
							type: "text" as const,
							text:
								images.length > 1
									? `用户提供了 ${images.length} 张图片，按传入顺序编号 1..${images.length}。\n\n${prompt}`
									: prompt,
						},
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

/**
 * 一次视觉分析（含模型回退循环）：see_image 传单图，see_images 传多图。
 * 返回 toolResult / toolError，由调用方直接透传。
 */
async function runVisionAnalysis(
	ctx: ExtensionContext,
	opts: {
		images: Array<{ mimeType: string; data: string }>;
		prompt: string;
		modelOverride?: string;
		/** 进度文案里的对象名词，如 "图片" / "3 张图片" */
		noun: string;
	},
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void) | undefined,
) {
	const candidates = buildCandidates(ctx, opts.modelOverride);
	const attempts: string[] = [];
	const autoSelection = !opts.modelOverride && !parseModelRef(process.env.PI_VISION_MODEL);

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
			return toolError("已取消。", { error: "aborted", attempts, imageCount: opts.images.length });
		}

		ctx.ui.setStatus("pi-vision", `👁 ${cand.model.id} …`);
		onUpdate?.({
			content: [{ type: "text", text: `正在用 ${refName} 分析${opts.noun}…` }],
			details: { model: refName, status: "analyzing" },
		});

		try {
			const text = await callVisionModel(ctx, cand.model, opts.images, opts.prompt, signal);
			if (autoSelection) autoPreferredModelRef = modelRef(cand.model);
			const usedFallback = attempts.length > 0;
			const prefix = usedFallback
				? `（默认模型不可用，已由 ${refName} 回退完成。失败记录：${attempts.join("；")}）\n\n`
				: "";
			return toolResult(prefix + text, {
				model: refName,
				fallback: usedFallback,
				attempts,
				prompt: opts.prompt,
				imageCount: opts.images.length,
			});
		} catch (err) {
			if (signal?.aborted) {
				return toolError("已取消。", { error: "aborted", attempts, imageCount: opts.images.length });
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
		{ error: "all_failed", attempts, imageCount: opts.images.length },
	);
}

// ── see_job：异步任务调度（进程内队列，对标 pi-anytomd 的 anyjob 习惯）────────

const MAX_SUBMIT_TASKS = 50;

interface QueuedVisionRequest {
	images: string[];
	prompt: string;
	model?: string;
	cwd: string;
	ctx: ExtensionContext;
}

/** 进程内任务登记表：jobId → 真实请求（磁盘上 data URL 已脱敏，原件只存在于这里）。 */
const queuedRequests = new Map<string, QueuedVisionRequest>();
const pendingJobIds: string[] = [];
const activeJobs = new Map<string, { controller: AbortController; timer: ReturnType<typeof setInterval> }>();

function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n\n\u2026（已截断，完整内容见 result.md）`;
}

/** 有空闲并发槽时依次取排队任务开跑。 */
function pumpVisionJobs(): void {
	while (activeJobs.size < envMaxConcurrent() && pendingJobIds.length > 0) {
		const jobId = pendingJobIds.shift()!;
		void startVisionJob(jobId);
	}
}

/** 后台执行一个排队任务：读图 → 复用 runVisionAnalysis（模型路由/回退与同步工具一致）→ 结果落盘。 */
async function startVisionJob(jobId: string): Promise<void> {
	const queued = queuedRequests.get(jobId);
	const job = readJob(jobId);
	if (!queued || !job || job.status !== "queued") {
		queuedRequests.delete(jobId);
		return;
	}

	const controller = new AbortController();
	const timer = setInterval(() => touchHeartbeat(jobId), HEARTBEAT_MS);
	(timer as { unref?: () => void }).unref?.(); // 不拖累进程退出；真正跑视觉调用时事件循环本来就被占住
	activeJobs.set(jobId, { controller, timer });
	updateJob(jobId, { status: "running", startedAt: new Date().toISOString(), pid: process.pid });
	touchHeartbeat(jobId);

	try {
		// 与 see_images 一致：逐张读取，任何一张读不了则整体失败并指出第几张
		const loaded: Array<{ mimeType: string; data: string }> = [];
		for (const [index, imageRef] of queued.images.entries()) {
			if (controller.signal.aborted) break;
			try {
				loaded.push(await loadImage(imageRef, queued.cwd));
			} catch (err) {
				const message = `无法读取第 ${index + 1} 张图片 "${imageRef}"：${messageOf(err)}`;
				writeJobResult(jobId, {
					details: { error: "image_read_error", index: index + 1, image: redactImageRef(imageRef) },
				});
				updateJob(jobId, { status: "failed", finishedAt: new Date().toISOString(), error: message });
				return;
			}
		}

		const res = await runVisionAnalysis(
			queued.ctx,
			{
				images: loaded,
				prompt: queued.prompt,
				modelOverride: queued.model,
				noun: loaded.length > 1 ? `${loaded.length} 张图片` : "图片",
			},
			controller.signal,
			undefined,
		);

		const text = res.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		const details = (res.details ?? {}) as Record<string, unknown>;

		if (controller.signal.aborted || details.error === "aborted") {
			// 磁盘状态已由 cancel 流程写为 cancelled（终态保护防覆盖），这里只补诊断
			writeJobResult(jobId, { details });
			return;
		}
		if (res.isError) {
			writeJobResult(jobId, { details });
			updateJob(jobId, { status: "failed", finishedAt: new Date().toISOString(), error: truncateText(text, 2000) });
			return;
		}

		writeJobResult(jobId, { text, details });
		updateJob(jobId, {
			status: "succeeded",
			finishedAt: new Date().toISOString(),
			resultPath: join(JOBS_DIR, jobId, "result.md"),
			model: typeof details.model === "string" ? details.model : undefined,
		});
	} catch (err) {
		// runVisionAnalysis 理论上不抛错；兜底防任务永远卡在 running
		updateJob(jobId, { status: "failed", finishedAt: new Date().toISOString(), error: messageOf(err) });
	} finally {
		clearInterval(timer);
		activeJobs.delete(jobId);
		queuedRequests.delete(jobId);
		pumpVisionJobs();
	}
}

/** 读取结果文件；不存在则返回空字符串。 */
async function readResultText(job: { id: string; resultPath?: string }): Promise<string> {
	try {
		return await readFile(job.resultPath ?? join(JOBS_DIR, job.id, "result.md"), "utf-8");
	} catch {
		return "";
	}
}

/** 组装并校验 submit 的任务。校验失败返回错误文案，成功返回规范化任务列表。 */
function normalizeSubmitTasks(params: {
	tasks?: Array<{ image?: string; images?: string[]; prompt?: string; model?: string }>;
	image?: string;
	images?: string[];
	prompt?: string;
	model?: string;
}): Array<{ images: string[]; prompt: string; model?: string }> | string {
	if (params.tasks && params.tasks.length > MAX_SUBMIT_TASKS) {
		return `一次最多提交 ${MAX_SUBMIT_TASKS} 个任务（当前 ${params.tasks.length} 个），请分批提交`;
	}

	const dedupe = (refs: Array<string | undefined>) =>
		[...new Set(refs.map((p) => p?.trim()).filter((p): p is string => Boolean(p)))];

	const limitError = (label: string, images: string[]) => {
		const max = envMaxBatch();
		return images.length > max
			? `${label}包含 ${images.length} 张图片，超出单任务上限 ${max}（PI_VISION_MAX_BATCH），请拆成多个任务`
			: null;
	};

	if (params.tasks?.length) {
		const tasks: Array<{ images: string[]; prompt: string; model?: string }> = [];
		for (const [i, task] of params.tasks.entries()) {
			const images = dedupe([...(task.images ?? []), task.image]);
			if (!images.length) return `第 ${i + 1} 个任务缺少图片（image / images）`;
			if (!task.prompt?.trim()) return `第 ${i + 1} 个任务缺少 prompt`;
			const err = limitError(`第 ${i + 1} 个任务`, images);
			if (err) return err;
			tasks.push({ images, prompt: task.prompt.trim(), model: task.model?.trim() || undefined });
		}
		return tasks;
	}

	const images = dedupe([...(params.images ?? []), params.image]);
	if (!images.length) return "缺少图片（image / images / tasks）";
	if (!params.prompt?.trim()) return "缺少 prompt";
	const err = limitError("该任务", images);
	if (err) return err;
	return [{ images, prompt: params.prompt.trim(), model: params.model?.trim() || undefined }];
}

/** see_job submit：建任务记录 → 入队 → pump；wait=true 时阻塞等本批全部到终态并内联结果。 */
async function submitVisionJobs(
	params: { wait?: boolean; timeoutSec?: number },
	ctx: ExtensionContext,
	tasks: Array<{ images: string[]; prompt: string; model?: string }>,
) {
	if (tasks.length > MAX_SUBMIT_TASKS) {
		return toolError(
			`一次最多提交 ${MAX_SUBMIT_TASKS} 个任务（当前 ${tasks.length} 个）。请分批提交。`,
			{ error: "too_many_tasks", max: MAX_SUBMIT_TASKS, count: tasks.length },
		);
	}

	// 前置检查：有任务没指定模型时，默认路由必须存在可用视觉模型，避免批量提交后整批失败
	const tasksNeedingDefault = tasks.filter((t) => !t.model).length;
	if (tasksNeedingDefault > 0 && !buildCandidates(ctx, undefined).some((c) => c.model && !c.unusable)) {
		return toolError(
			[
				"当前没有可用的视觉模型（存在未指定模型的任务，无法路由）。",
				"请先配置 PI_VISION_MODEL / PI_VISION_FALLBACK_MODELS，或在每个任务里显式传 model。",
				"可用 /vision 查看当前配置与候选解析。",
			].join("\n"),
			{ error: "no_vision_model", tasksNeedingDefault },
		);
	}

	const jobIds: string[] = [];
	for (const task of tasks) {
		const { jobId } = createJob({ images: task.images, prompt: task.prompt, model: task.model });
		queuedRequests.set(jobId, { images: task.images, prompt: task.prompt, model: task.model, cwd: ctx.cwd, ctx });
		pendingJobIds.push(jobId);
		jobIds.push(jobId);
	}
	pumpVisionJobs();

	if (params.wait === true) {
		const timeout = Math.max(0, params.timeoutSec ?? 600);
		const deadline = Date.now() + timeout * 1000;
		const lines: string[] = [`本批 ${jobIds.length} 个任务等待结束（上限 ${timeout} 秒）：`];
		let okCount = 0;
		for (const id of jobIds) {
			const remaining = Math.max(0, (deadline - Date.now()) / 1000);
			const res = await waitJob(id, remaining);
			const job = res.job ?? readJob(id);
			const status = job?.status ?? "unknown";
			if (status === "succeeded") okCount += 1;
			lines.push("", `## ${id} — ${status === "succeeded" ? "✅" : "⚠️"} ${status}`);
			if (status === "succeeded" && job) {
				const text = await readResultText(job);
				if (text) lines.push("", truncateText(text, 20_000));
			}
			if (job?.error) lines.push(`- 错误：${job.error}`);
		}
		lines.unshift(`（成功 ${okCount}/${jobIds.length}）`);
		return toolResult(lines.join("\n"), { jobIds, okCount, total: jobIds.length });
	}

	const first = jobIds[0]!;
	const lines = [
		`已提交 ${jobIds.length} 个后台看图任务（并发上限 ${envMaxConcurrent()}，当前排队 ${pendingJobIds.length} 个）：`,
		...jobIds.map((id, i) => `- [${i + 1}] ${id}`),
		``,
		`任务库：${JOBS_ROOT}`,
		``,
		`后续操作：`,
		`- 等完成并取全文: see_job({ action: "wait", id: "${first}" })`,
		`- 查状态/预览:    see_job({ action: "status", id: "${first}" })`,
		`- 取消:           see_job({ action: "cancel", id: "..." })`,
		`- 历史:           see_job({ action: "list" })`,
		``,
		`注意：任务在当前 pi 进程内运行（结果已落盘，跨会话可查）；请勿在任务完成前退出 pi。`,
	];
	return toolResult(lines.join("\n"), {
		jobIds,
		queued: pendingJobIds.length,
		concurrency: envMaxConcurrent(),
		jobsRoot: JOBS_ROOT,
	});
}

async function statusVisionJob(params: { id?: string }) {
	if (!params.id) return toolError("see_job status 失败：缺少 id 参数", { error: "missing_id" });
	const job = readJob(params.id);
	if (!job) return toolError(`未找到任务: ${params.id}`, { error: "not_found" });

	const queueNote =
		job.status === "queued" ? (pendingJobIds.includes(job.id) ? "（排队中）" : "（等待调度）") : "";
	const lines = [
		`## 任务 ${job.id}`,
		`- 状态: **${job.status}**${queueNote}`,
		`- 提交时间: ${job.createdAt}`,
		job.startedAt ? `- 开始时间: ${job.startedAt}` : "",
		job.finishedAt ? `- 完成时间: ${job.finishedAt}` : "",
		`- 图片数: ${job.request?.images?.length ?? "?"}${job.request?.model ? ` · 指定模型: ${job.request.model}` : ""}`,
		job.request?.prompt ? `- prompt: ${truncateText(job.request.prompt, 160)}` : "",
	];
	if (job.status === "succeeded") {
		lines.push(`- 结果文件: **${job.resultPath ?? join(JOBS_DIR, job.id, "result.md")}**`, "", "结果预览：", "");
		lines.push(truncateText(await readResultText(job), 2000));
	}
	if (job.error) lines.push(`- 错误: ${job.error}`);
	return toolResult(lines.filter(Boolean).join("\n"), { ...job });
}

async function waitVisionJob(params: { id?: string; timeoutSec?: number }) {
	if (!params.id) return toolError("see_job wait 失败：缺少 id 参数", { error: "missing_id" });
	const res = await waitJob(params.id, params.timeoutSec ?? 600);
	const job = res.job ?? readJob(params.id);
	if (!job) return toolError(res.error ?? `未找到任务: ${params.id}`, { error: "not_found" });

	const status = job.status;
	const lines = [
		status === "succeeded"
			? `✅ 任务 ${params.id} 完成`
			: `⚠️ 任务 ${params.id} 未成功（状态: ${status}${res.error ? `，${res.error}` : ""}）`,
	];
	if (status === "succeeded") {
		lines.push(`- 结果文件: **${job.resultPath ?? join(JOBS_DIR, params.id, "result.md")}**`, "");
		lines.push(truncateText(await readResultText(job), 50_000));
	}
	if (job.error) lines.push(`- 错误: ${job.error}`);
	return toolResult(lines.filter(Boolean).join("\n"), { ...job, ok: res.ok });
}

function cancelVisionJob(params: { id?: string }) {
	if (!params.id) return toolError("see_job cancel 失败：缺少 id 参数", { error: "missing_id" });
	const job = readJob(params.id);
	if (!job) return toolError(`未找到任务: ${params.id}`, { error: "not_found" });

	// 排队中的任务先从进程内队列摘除
	const queueIndex = pendingJobIds.indexOf(params.id);
	if (queueIndex >= 0) {
		pendingJobIds.splice(queueIndex, 1);
		queuedRequests.delete(params.id);
	}

	const res = cancelJob(params.id);
	if (!res.ok) return toolError(`取消失败: ${res.error}`, { error: "cancel_failed", detail: res.error });

	// 运行中的任务：中断并清理心跳（万一 vision 调用忽略 abort 悬挂，内存登记也要释放）
	const active = activeJobs.get(params.id);
	if (active) {
		clearInterval(active.timer);
		activeJobs.delete(params.id);
		queuedRequests.delete(params.id);
		active.controller.abort();
		// 即使底层 provider 忽略 AbortSignal，也立即释放并发槽并继续调度后续任务。
		pumpVisionJobs();
		return toolResult(`任务 ${params.id} 已标记取消，运行中的视觉调用正在中断。`, { id: params.id, status: "cancelled" });
	}
	return toolResult(`任务 ${params.id} 已取消${queueIndex >= 0 ? "（此前处于排队状态）" : ""}。`, { id: params.id, status: "cancelled" });
}

function listVisionJobs(params: { limit?: number; statusFilter?: string }) {
	const limit = Math.max(1, Math.min(100, params.limit ?? 20));
	const jobs = listJobs(limit, params.statusFilter ?? null);
	if (!jobs.length) return toolResult("暂无看图任务记录。", { count: 0, jobsRoot: JOBS_ROOT });

	const rows = jobs.map((j) => {
		const state =
			j.status === "succeeded"
				? "✅ succeeded"
				: j.status === "failed"
					? "❌ failed"
					: j.status === "cancelled"
						? "⏹️ cancelled"
						: `⏳ ${j.status}`;
		const images = j.request?.images?.length ?? "?";
		const tail = j.resultPath ? "result.md" : j.error ? j.error.slice(0, 40) : "-";
		return `| \`${j.id}\` | ${state} | ${images} | ${j.createdAt.slice(0, 19).replace("T", " ")} | ${tail} |`;
	});
	const table = [
		`## 最近看图任务（前 ${jobs.length} 条，任务库: \`${JOBS_ROOT}\`）`,
		"",
		"| Job ID | 状态 | 图片数 | 提交时间 | 结果/错误 |",
		"|---|---|---|---|---|",
		...rows,
	].join("\n");
	return toolResult(table, { count: jobs.length, jobs });
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
		`  批量上限:        ${envMaxBatch()}（see_images 单次最多图片数）`,
		`  异步并发:        ${envMaxConcurrent()}（see_job 后台任务，PI_VISION_MAX_CONCURRENT）`,
		`  任务库:          ${JOBS_ROOT}`,
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
		"  PI_VISION_MAX_BATCH=5                       see_images 单次最多图片数",
		"  PI_VISION_MAX_CONCURRENT=2                  see_job 后台分析并发数（1-8）",
		"  PI_VISION_JOBS_DIR=~/.pi/vision-jobs        see_job 任务库目录（可覆盖）",
		"  或在调用 see_image/see_images 时传 model 参数临时指定。",
	];
	return lines.join("\n");
}

/** 状态栏：显示下一个可用视觉模型；suffix 用于调用期间展示当前使用的模型。 */
function updateStatus(ctx: ExtensionContext | ExtensionCommandContext, suffix?: string): void {
	const first = buildCandidates(ctx, undefined).find((c) => c.model && !c.unusable);
	ctx.ui.setStatus(
		"pi-vision",
		first?.model ? `👁 ${first.model.id}${suffix ? ` ${suffix}` : ""}` : undefined,
	);
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
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
			"可选 model 参数临时指定视觉模型（格式 provider/modelId，仅本次调用生效）；不指定则自动从已配置（非 OAuth）的视觉模型中首选，失败时自动按序尝试其他已配置模型。" +
			"一次分析多张图片请用 see_images（批量）。",
		promptSnippet: "用视觉模型解析图片内容（截图/照片/图片），支持默认模型 + 回退模型",
		promptGuidelines: [
			"需要看懂截图、报错弹窗、UI 界面、图表、照片等任何图片内容时，调用 see_image；在 prompt 里写明你具体要从图中获取什么。",
			"需要对比或成组分析多张图片时，用 see_images 一次提交，不要逐张调用 see_image。",
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

			return runVisionAnalysis(
				ctx,
				{ images: [image], prompt: params.prompt, modelOverride: params.model, noun: "图片" },
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		name: "see_images",
		label: "See Images (Vision)",
		description:
			`用视觉模型一次分析多张图片（对比多张截图、审查一组 UI 图、逐页看扫描件等），返回覆盖全部图片的文字分析。` +
			`images 最多 ${envMaxBatch()} 张（PI_VISION_MAX_BATCH 可调），按传入顺序编号；prompt 是对所有图片的同一个分析要求，可用"第 N 张"指代具体图片。` +
			`模型选择与自动回退同 see_image。单张图片用 see_image 即可。`,
		promptSnippet: "一次视觉调用分析多张图片（对比/成组/多页），支持默认模型 + 回退模型",
		promptGuidelines: [
			"需要对比或成组分析多张图片时，用 see_images 一次提交，不要对每张图各调一次 see_image；单张图片仍用 see_image。",
			`images 上限 ${envMaxBatch()} 张（PI_VISION_MAX_BATCH 可调），更多时拆成多次调用；prompt 对所有图片生效，用"第 N 张"引用具体图片。`,
			"see_images 的模型选择/回退与 see_image 相同：默认自动，仅在需要临时换模型时传 model 参数（provider/modelId）。",
		],
		parameters: Type.Object({
			images: Type.Array(
				Type.String({
					description: "图片位置：本地文件路径（相对路径按当前工作目录解析）或 data:image/png;base64,... 形式的 data URL",
				}),
				{ description: `图片位置列表，按传入顺序编号，最多 ${envMaxBatch()} 张（PI_VISION_MAX_BATCH）` },
			),
			prompt: Type.String({
				description:
					'想让视觉模型对所有图片分析/提取的内容，越具体越好。例如："对比两张截图，列出 UI 差异"、"逐张提取每页的手写文字"。',
			}),
			model: Type.Optional(
				Type.String({
					description:
						"临时指定视觉模型，格式 provider/modelId（仅本次调用生效，优先级最高）。不指定则走与 see_image 相同的默认模型选择。",
				}),
			),
		}),

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("see_images"));
			const countLine = theme.fg("dim", `images: ${args.images.length} 张`);
			const promptLine = theme.fg(
				"dim",
				`prompt: ${args.prompt.length > 120 ? args.prompt.slice(0, 117) + "..." : args.prompt}`,
			);
			const modelLine = args.model ? theme.fg("dim", `model: ${args.model}`) : undefined;
			return new Text(
				[title, `  ${countLine}`, `  ${promptLine}`, ...(modelLine ? [`  ${modelLine}`] : [])].join("\n"),
				0,
				0,
			);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const images = [...new Set(params.images.map((p) => p.trim()).filter(Boolean))];
			if (!images.length) {
				return toolError("未提供任何图片路径。", { error: "empty_images" });
			}
			const max = envMaxBatch();
			if (images.length > max) {
				return toolError(
					`一次最多分析 ${max} 张图片（当前 ${images.length} 张，PI_VISION_MAX_BATCH=${max}）。请拆分成多次 see_images 调用，或在配置中调高 PI_VISION_MAX_BATCH。`,
					{ error: "too_many_images", max, count: images.length },
				);
			}

			// 逐张读取；任何一张读不了就整体失败并指出是哪张，避免模型对着缺图作答。
			const loaded: Array<{ mimeType: string; data: string }> = [];
			for (const [index, image] of images.entries()) {
				try {
					loaded.push(await loadImage(image, ctx.cwd));
				} catch (err) {
					return toolError(`无法读取第 ${index + 1} 张图片 "${image}"：${messageOf(err)}`, {
						error: "image_read_error",
						index: index + 1,
						image,
					});
				}
			}

			return runVisionAnalysis(
				ctx,
				{ images: loaded, prompt: params.prompt, modelOverride: params.model, noun: `${loaded.length} 张图片` },
				signal,
				onUpdate,
			);
		},
	});

	// =========================================================================
	// see_job（异步看图任务队列，对标 pi-anytomd 的 anyjob）
	// =========================================================================
	pi.registerTool({
		name: "see_job",
		label: "See Job (Vision Async)",
		description:
			"异步看图任务队列（对标 anytomd 的 anyjob）：把一批图片分析任务提交到后台，submit 立即返回 job-id，不阻塞当前回合。" +
			"Actions: submit（提交 1~50 个独立分析任务，每个任务=自己的图片组+自己的 prompt）/ status（状态+结果预览）/ wait（阻塞等到终态并返回分析全文）/ cancel（取消排队或运行中的任务）/ list（历史列表）。" +
			"结果落盘 ~/.pi/vision-jobs/jobs/<id>/result.md，跨会话可查询；并发数由 PI_VISION_MAX_CONCURRENT 控制（默认 2）。" +
			"注意：视觉分析在 pi 进程内运行（依赖模型注册表），pi 退出后排队/运行中的任务会在下次查询时被 stale 检测标记 failed。" +
			"单图即时问答用 see_image，交互式对比用 see_images；大批量/后台化才用 see_job。",
		promptSnippet:
			"异步看图任务队列：批量提交后台图片分析任务（submit/status/wait/cancel/list），结果落盘跨会话可查，标任务库 ~/.pi/vision-jobs",
		promptGuidelines: [
			"需要批量分析很多图片（批量 OCR/证书信息提取/逐页审阅）且不想阻塞当前回合时，用 see_job submit 一次提交多个 tasks（每个任务独立图片组+独立 prompt），之后用 wait/status 收结果。",
			"see_job 的 wait/status 对 succeeded 任务会直接返回分析文本（wait 返回全文，status 返回前 2000 字预览），无需再读文件；result.md 是完整产物。",
			"单图即时问答用 see_image，交互式对比分析用 see_images；只有大批量/后台化场景才用 see_job。",
			"see_job 提交后不要退出 pi 进程：排队/运行中的任务依赖当前进程，进程退出后的遗留任务会被 stale 检测标记为 failed。",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("submit"),
					Type.Literal("status"),
					Type.Literal("wait"),
					Type.Literal("cancel"),
					Type.Literal("list"),
				],
				{ description: "操作类型: submit(提交任务) | status(查状态) | wait(等待完成并返回全文) | cancel(取消) | list(列出历史)" },
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						image: Type.Optional(
							Type.String({ description: "单张图片（与 images 二选一，或并存合并去重）" }),
						),
						images: Type.Optional(
							Type.Array(Type.String(), {
								description: "多张图片（同一任务内合并分析，单任务上限同 see_images / PI_VISION_MAX_BATCH）",
							}),
						),
						prompt: Type.String({ description: "该任务的分析要求（越具体越好）" }),
						model: Type.Optional(
							Type.String({ description: "可选，该任务临时指定视觉模型 provider/modelId" }),
						),
					}),
					{ description: "submit 批量模式：每个元素是一个独立分析任务（一次最多 50 个）" },
				),
			),
			image: Type.Optional(Type.String({ description: "submit 单任务快捷方式：一张图片" })),
			images: Type.Optional(
				Type.Array(Type.String(), { description: "submit 单任务快捷方式：多张图片" }),
			),
			prompt: Type.Optional(Type.String({ description: "submit 单任务快捷方式：分析要求" })),
			model: Type.Optional(
				Type.String({ description: "submit 单任务快捷方式：临时指定视觉模型 provider/modelId" }),
			),
			id: Type.Optional(Type.String({ description: "任务 ID（status/wait/cancel 必填）" })),
			wait: Type.Optional(
				Type.Boolean({
					description: "submit 时设为 true 会阻塞等待本批任务全部到终态（默认 false 立即返回）",
					default: false,
				}),
			),
			timeoutSec: Type.Optional(
				Type.Number({ description: "wait / submit+wait 的超时秒数（默认 600 秒）", default: 600 }),
			),
			limit: Type.Optional(Type.Number({ description: "list 返回的最大记录数（默认 20）", default: 20 })),
			statusFilter: Type.Optional(
				Type.Union(
					[
						Type.Literal("queued"),
						Type.Literal("running"),
						Type.Literal("succeeded"),
						Type.Literal("failed"),
						Type.Literal("cancelled"),
					],
					{ description: "list 的状态过滤（可选）" },
				),
			),
		}),

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("see_job"));
			const detail =
				args.action === "submit"
					? `${args.tasks?.length ?? 1} 个任务`
					: (args.id ?? "");
			return new Text(
				[title, theme.fg("dim", `  ${args.action}${detail ? ` · ${detail}` : ""}`)].join("\n"),
				0,
				0,
			);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "submit": {
					const tasks = normalizeSubmitTasks(params);
					if (typeof tasks === "string") {
						return toolError(`see_job submit 失败：${tasks}`, { error: "invalid_params" });
					}
					try {
						return await submitVisionJobs(params, ctx, tasks);
					} catch (err) {
						return toolError(`see_job submit 失败：${messageOf(err)}`, { error: "submit_failed" });
					}
				}
				case "status":
					return statusVisionJob(params);
				case "wait":
					return waitVisionJob(params);
				case "cancel":
					return cancelVisionJob(params);
				case "list":
					return listVisionJobs(params);
				default:
					return toolError(`未知 action: ${params.action}`, { error: "invalid_action" });
			}
		},
	});
}
