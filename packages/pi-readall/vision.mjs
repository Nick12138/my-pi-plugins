/**
 * vision.mjs — pi-readall 视觉兜底通道（模型路由 + 调用，移植自 pi-vision）。
 * 纯 JS（.mjs 由扩展进程直接 import，不经编译）；类型见 pi-vision 原实现。
 *
 * 与 pi-vision 的差异：
 *   - 在 pi-readall 里视觉模型是「WPS OCR 失败后的兜底通道」，不是主通道，
 *     因此没有能力探针与工具门控（readall 的 read 无论当前模型能否看图都可调用——
 *     批量 OCR 场景下即使主模型能看图，外包给视觉模型仍是正确的上下文经济学）。
 *   - 自动模式只认「用户已配置且非 OAuth」的视觉模型（继承 pi-vision 的关键约束），
 *     成功模型在本进程内提升为下一次首选。
 *
 * 配置（环境变量，由插件配置界面注入）：
 *   PI_VISION_MODEL            默认视觉模型 "provider/modelId"（留空 = auto）
 *   PI_VISION_FALLBACK_MODELS  回退模型列表，英文逗号分隔
 *   PI_VISION_MAX_TOKENS       单次视觉调用最大输出 token，默认 4096
 *   PI_VISION_TIMEOUT_MS       单次视觉调用超时毫秒，默认 120000
 *   PI_VISION_MAX_IMAGE_MB     单张图片体积上限 MB，默认 20
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";

// ── 常量 ─────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_IMAGE_MB = 20;

const VISION_SYSTEM_PROMPT = [
	"You are an expert OCR and document-vision assistant.",
	"Extract text from the provided image(s) faithfully.",
	"",
	"Guidelines:",
	"- Your reply is consumed by an agent pipeline, not a human viewer.",
	"- Extract ALL visible text verbatim: headings, body text, table cells, stamps, handwritten notes.",
	"- Preserve reading order (top-to-bottom, left-to-right) and paragraph breaks.",
	"- Reproduce numbers, dates, ID numbers, amounts EXACTLY as written; never normalize or invent digits.",
	"- Chinese Unified Social Credit Code (统一社会信用代码) is exactly 18 characters and has a check digit; if you cannot confirm every character, write (无法辨认) instead of guessing.",
	"- If a region is illegible, write (无法辨认) at that position instead of guessing.",
	"- Do not add commentary, analysis, or descriptions beyond the user's request.",
].join("\n");

const MIME_BY_EXT = {
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

export function messageOf(err) {
	return err instanceof Error ? err.message : String(err);
}

function parseModelRef(value) {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

function parseFallbackRefs(value) {
	if (!value?.trim()) return [];
	return value
		.split(",")
		.map((part) => parseModelRef(part))
		.filter(Boolean);
}

function envTimeoutMs() {
	const n = parseInt(process.env.PI_VISION_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : REQUEST_TIMEOUT_MS;
}

function envMaxTokens() {
	const n = parseInt(process.env.PI_VISION_MAX_TOKENS ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

function envMaxImageBytes() {
	const n = parseFloat(process.env.PI_VISION_MAX_IMAGE_MB ?? "");
	const mb = Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IMAGE_MB;
	return Math.round(mb * 1024 * 1024);
}

function requestSignal(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mimeFromPath(p) {
	const base = p.split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return undefined;
	return MIME_BY_EXT[base.slice(dot + 1).toLowerCase()];
}

// ── 图片读取（继承 pi-vision 的错误分类思路，精简版）────────────────────

export class ImageReadError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ImageReadError";
		this.code = code;
	}
}

/** 读取图片文件为 base64（相对路径按 cwd 解析；不支持 data URL / http）。 */
export async function loadImageFile(imagePath, cwd) {
	const trimmed = imagePath.trim();
	if (!trimmed) throw new ImageReadError("empty_ref", "图片路径为空。");
	if (/^data:/i.test(trimmed)) throw new ImageReadError("unsupported_ref", "视觉兜底只接受本地文件路径，不接受 data URL。");
	if (/^https?:\/\//i.test(trimmed)) throw new ImageReadError("unsupported_url", "HTTP(S) 链接不支持，请先保存为本地文件。");

	const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);

	let info;
	try {
		info = await stat(abs);
	} catch (err) {
		const code = err?.code;
		if (code === "ENOENT" || code === "ENOTDIR") throw new ImageReadError("not_found", `文件不存在: ${abs}`);
		if (code === "EACCES" || code === "EPERM") throw new ImageReadError("read_failed", `没有读取权限: ${abs}`);
		throw new ImageReadError("read_failed", messageOf(err));
	}
	if (info.isDirectory()) throw new ImageReadError("is_directory", `这是目录不是图片: ${abs}`);

	const mimeType = mimeFromPath(abs);
	if (!mimeType) throw new ImageReadError("unsupported_format", `不是受支持的图片格式: ${abs}（支持 ${Object.keys(MIME_BY_EXT).join(" / ")}）`);

	const maxBytes = envMaxImageBytes();
	if (info.size > maxBytes) throw new ImageReadError("too_large", `图片体积 ${formatBytes(info.size)} 超过上限 ${formatBytes(maxBytes)}（PI_VISION_MAX_IMAGE_MB 可调）`);
	if (info.size === 0) throw new ImageReadError("empty_file", `文件为空（0 字节）: ${abs}`);

	const buffer = await readFile(abs);
	return { mimeType, data: buffer.toString("base64") };
}

// ── 模型路由（继承 pi-vision 的候选构建 + 自动首选提升）──────────────────

let autoPreferredModelRef;

function modelRefOf(model) {
	return `${model.provider}/${model.id}`;
}

function isUserConfiguredModel(ctx, model) {
	const status = ctx.modelRegistry.getProviderAuthStatus(model.provider);
	if (!status.configured) return false;
	if (ctx.modelRegistry.isUsingOAuth(model)) return false;
	return true;
}

function buildCandidates(ctx, overrideRef) {
	const candidates = [];
	const seen = new Set();

	const push = (ref, model) => {
		if (!model) {
			candidates.push({ ref, model });
			return;
		}
		const key = modelRefOf(model);
		if (seen.has(key)) return;
		seen.add(key);
		const unusable = model.input?.includes("image") ? undefined : "该模型未声明 image 输入";
		candidates.push({ ref, model, unusable });
	};

	if (overrideRef) {
		const parsed = parseModelRef(overrideRef);
		push(overrideRef, parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined);
		return [...candidates, ...fallbacks(ctx)];
	}

	const envRef = parseModelRef(process.env.PI_VISION_MODEL);
	if (envRef) {
		push(`${envRef.provider}/${envRef.id}`, ctx.modelRegistry.find(envRef.provider, envRef.id));
	} else {
		// auto：仅从「已配置且非 OAuth」的视觉模型中选（pi-vision 的关键约束）
		const autoModels = ctx.modelRegistry
			.getAll()
			.filter((m) => m.input?.includes("image"))
			.filter((m) => isUserConfiguredModel(ctx, m));
		let preferred = autoPreferredModelRef
			? autoModels.find((m) => modelRefOf(m) === autoPreferredModelRef)
			: undefined;
		if (!preferred && autoModels.length > 0) {
			preferred = autoModels[Math.floor(Math.random() * autoModels.length)];
			autoPreferredModelRef = modelRefOf(preferred);
		}
		const ordered = preferred ? [preferred, ...autoModels.filter((m) => m !== preferred)] : autoModels;
		for (const model of ordered) push(modelRefOf(model), model);
	}

	return [...candidates, ...fallbacks(ctx)];

	function fallbacks(c) {
		return parseFallbackRefs(process.env.PI_VISION_FALLBACK_MODELS)
			.map((ref) => ({ ref: `${ref.provider}/${ref.id}`, model: c.modelRegistry.find(ref.provider, ref.id), unusable: undefined }))
			.filter((cand) => {
				if (!cand.model) return true;
				const key = modelRefOf(cand.model);
				if (seen.has(key)) return false;
				seen.add(key);
				if (!cand.model.input?.includes("image")) cand.unusable = "该模型未声明 image 输入";
				return true;
			});
	}
}

async function callVisionModel(ctx, model, images, prompt, signal) {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`无法解析 ${model.provider} 的 API Key：${auth.error}`);
	if (!auth.apiKey && !ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`模型 ${model.provider}/${model.id} 没有可用的 API Key`);
	}

	const res = await complete(
		model,
		{
			systemPrompt: VISION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					timestamp: Date.now(),
					content: [
						...images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
						{
							type: "text",
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
		.filter((c) => c.type === "text" && !!c.text)
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (!text) throw new Error("视觉模型返回了空内容");
	return text;
}

export function hasVisionCandidate(ctx) {
	return buildCandidates(ctx, undefined).some((c) => c.model && !c.unusable);
}

/**
 * 一次视觉识别（含模型回退循环）。成功返回 { text, model, attempts }；全部候选失败抛错。
 */
export async function runVisionOcr(ctx, opts, signal) {
	const candidates = buildCandidates(ctx, opts.modelOverride);
	const attempts = [];
	const autoSelection = !opts.modelOverride && !parseModelRef(process.env.PI_VISION_MODEL);

	for (const cand of candidates) {
		const refName = cand.model ? modelRefOf(cand.model) : cand.ref;
		if (!cand.model) {
			attempts.push(`${refName}：注册表中未找到该模型`);
			continue;
		}
		if (cand.unusable) {
			attempts.push(`${refName}：${cand.unusable}`);
			continue;
		}
		if (signal?.aborted) throw new Error("已取消");

		try {
			const text = await callVisionModel(ctx, cand.model, opts.images, opts.prompt, signal);
			if (autoSelection) autoPreferredModelRef = modelRefOf(cand.model);
			return { text, model: refName, attempts };
		} catch (err) {
			if (signal?.aborted) throw new Error("已取消");
			attempts.push(`${refName}：${messageOf(err)}`);
		}
	}

	throw new Error(`所有视觉模型候选均失败：\n${attempts.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}`);
}
