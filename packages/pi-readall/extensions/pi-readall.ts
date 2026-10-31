/**
 * pi-readall — 统一读取层插件：OCR 主力 + 视觉兜底，Anything In / Text Out。
 *
 * 单工具 readall，按 action 分发：
 *   read   (默认) : 同步读取 → 文字。图片/扫描件走 WPS OCR（主力），
 *                   WPS 失败自动切页/分张交视觉模型兜底；文字版 PDF/Office 走
 *                   pdf2md/pandoc/officecli。
 *   submit / status / wait / cancel / list : 异步转换任务队列（分离进程，
 *                   跨会话存活；注意：分离进程无视觉兜底，WPS 失败即失败并指路）。
 *   setup  : 依赖体检（wpscli/pandoc/officecli）+ install=true 自动安装。
 *
 * 路由表（OCR 主力原则）：
 *   扫描件 PDF        → wpscli pdf2word(scanned) 整本 OCR → docx → 纯文字
 *                       ↓ 失败
 *                     pdf2photo 逐页切图 → 视觉模型队列逐页识别
 *   批量图片          → photo2word 分张 OCR（一张一个 docx，来源可追溯）
 *                       ↓ 失败
 *                     photo2pdf 合并 → pdf2word(scanned) → 仍失败则视觉模型并发逐张
 *   单张图片          → photo2word → 视觉模型识别兜底
 *   文字版 PDF        → wpscli pdf2md
 *   docx/xlsx/pptx    → officecli / pandoc → WPS 转 PDF 链路
 *   doc/xls/ppt/wps…  → WPS 转 PDF → pdf2md
 *   odt/epub/rtf/csv  → pandoc 原生
 *
 * 上下文保护：
 *   结果超过 PI_READALL_INLINE_CHARS（默认 20000 字符）时全文落盘
 *   （outputPath 或 Agent临时工作/output/），上下文里只回大纲+节选+路径。
 *
 * 视觉兜底配置（环境变量）：
 *   PI_VISION_MODEL / PI_VISION_FALLBACK_MODELS / PI_VISION_MAX_TOKENS /
 *   PI_VISION_TIMEOUT_MS / PI_VISION_MAX_IMAGE_MB / PI_READALL_VISION_CONCURRENCY
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	submitJob,
	readJob,
	waitJob,
	cancelJob,
	listJobs,
	JOBS_ROOT,
} from "../jobs.mjs";
import { appendUsccWarnings } from "../checks.mjs";
import {
	ImageReadError,
	hasVisionCandidate,
	loadImageFile,
	messageOf,
	runVisionOcr,
} from "../vision.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.resolve(__dirname, "..", "worker.mjs");

// ── 上下文保护 ───────────────────────────────────────────────────────────

const DEFAULT_INLINE_CHARS = 20_000;
const PREVIEW_CHARS = 3_000;

function envInlineChars(): number {
	const n = parseInt(process.env.PI_READALL_INLINE_CHARS ?? "", 10);
	return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INLINE_CHARS;
}

function envVisionConcurrency(): number {
	const n = parseInt(process.env.PI_READALL_VISION_CONCURRENCY ?? "", 10);
	return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2;
}

/** 同步 read 的单次 worker 超时（秒）。分批 OCR 后大 PDF 耗时更长，默认 1800s。 */
function envSyncTimeoutMs(): number {
	const n = parseInt(process.env.READALL_SYNC_TIMEOUT_SEC ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n * 1000 : 1800_000;
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function toolError(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details, isError: true as const };
}

/** 大结果落盘并返回「大纲 + 节选 + 路径」。 */
function spillToDisk(body: string, workspace: string, outputPath?: string): { text: string; savedTo?: string } {
	if (body.length <= envInlineChars()) return { text: body };

	const lines = body.split("\n");
	const outline = lines
		.filter((l) => /^#{1,3}\s/.test(l))
		.slice(0, 30)
		.join("\n");

	let savedTo: string | undefined;
	try {
		const out = outputPath
			? path.isAbsolute(outputPath)
				? outputPath
				: path.join(workspace, "Agent临时工作", "output", outputPath)
			: path.join(workspace, "Agent临时工作", "output", `readall-result-${Date.now()}.md`);
		mkdirSync(path.dirname(out), { recursive: true });
		writeFileSync(out, body, "utf-8");
		savedTo = out;
	} catch {
		// 落盘失败则退化为截断返回
	}

	if (savedTo) {
		return {
			text: [
				`结果共 ${body.length} 字符，超出内联阈值（${envInlineChars()}），全文已落盘：**${savedTo}**`,
				"",
				outline ? `## 大纲\n${outline}` : "",
				"",
				`## 开头节选（前 ${PREVIEW_CHARS} 字符）\n${body.slice(0, PREVIEW_CHARS)}…`,
				"",
				"需要更多内容请用 read 工具按偏移读取该文件。",
			]
				.filter(Boolean)
				.join("\n"),
			savedTo,
		};
	}
	return {
		text: `${body.slice(0, envInlineChars())}\n\n…（内容过长已截断，共 ${body.length} 字符；落盘失败，请传 outputPath 指定输出文件）`,
	};
}

// ── 视觉兜底执行（仅同步 read；并发队列逐张/逐页识别）──────────────────

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!, index);
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * 执行视觉兜底：把 worker 给出的 visionRequests（图片路径列表 + 原因）
 * 交给视觉模型并发识别，返回 markdown 段落。
 */
async function runVisionFallback(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	requests: Array<{ images: string[]; reason: string; label?: string }>,
	prompt: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ sections: string[]; models: string[]; errors: string[] }> {
	const sections: string[] = [];
	const models: string[] = [];
	const errors: string[] = [];

	for (const req of requests) {
		// 逐张读取；读不了的记录错误不阻塞其余
		const loaded: Array<{ path: string; img: { mimeType: string; data: string } }> = [];
		for (const p of req.images) {
			try {
				loaded.push({ path: p, img: await loadImageFile(p, ctx.cwd) });
			} catch (err) {
				const diag = err instanceof ImageReadError ? `${messageOf(err)} [${err.code}]` : messageOf(err);
				errors.push(`无法读取图片 ${p}：${diag}`);
			}
		}
		if (!loaded.length) {
			errors.push(`「${req.reason}」的 ${req.images.length} 张图片全部读取失败`);
			continue;
		}

		const visionPrompt =
			prompt?.trim() ||
			"逐字提取图片中的全部文字（OCR）。保持阅读顺序与段落结构；数字、日期、证号、金额必须逐字照抄，不得改写或遗漏。";

		// 并发逐张识别（每张独立调用，单张失败不拖累整批）
		const outcomes = await mapWithConcurrency(loaded, envVisionConcurrency(), async (item) => {
			try {
				const r = await runVisionOcr(ctx, { images: [item.img], prompt: visionPrompt }, signal);
				return { label: path.basename(item.path), ok: true as const, text: r.text, model: r.model };
			} catch (err) {
				return { label: path.basename(item.path), ok: false as const, error: messageOf(err) };
			}
		});

		const parts = outcomes.map((o, i) =>
			o.ok
				? `### ${i + 1}. ${o.label}\n\n${o.text}`
				: `### ${i + 1}. ${o.label}\n\n(视觉识别失败) ${o.error}`,
		);
		sections.push(
			`> 视觉兜底识别（${outcomes.filter((o) => o.ok).length}/${outcomes.length} 张成功；原因：${req.reason}）\n\n${parts.join("\n\n")}`,
		);
		for (const o of outcomes) {
			if (o.ok && !models.includes(o.model)) models.push(o.model);
			if (!o.ok) errors.push(`${o.label}: ${o.error}`);
		}
	}

	return { sections, models, errors };
}

// ── worker 调用 ──────────────────────────────────────────────────────────

async function callWorkerSpec(spec: Record<string, unknown>, password?: string, signal?: AbortSignal) {
	const tmpSpec = path.join(
		os.tmpdir(),
		`readall-spec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(tmpSpec, JSON.stringify(spec, null, 2), "utf-8");

	const childEnv: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	if (password) childEnv.READALL_PASSWORD = password;

	try {
		const { stdout } = await execFileAsync(process.execPath, [WORKER_SCRIPT, "--spec", tmpSpec], {
			timeout: envSyncTimeoutMs(),
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			signal,
			env: childEnv,
			encoding: "utf-8",
		});
		return JSON.parse(stdout.trim());
	} finally {
		rmSync(tmpSpec, { force: true });
	}
}

async function callWorkerDeps(): Promise<{ deps: Array<{ name: string; ok: boolean; version: string; path: string; detail: string }>; allOk: boolean }> {
	const { stdout } = await execFileAsync(process.execPath, [WORKER_SCRIPT, "--deps"], {
		timeout: 30_000,
		windowsHide: true,
		encoding: "utf-8",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	return JSON.parse(stdout.trim());
}

async function callWorkerInstall(signal?: AbortSignal) {
	const { stdout } = await execFileAsync(process.execPath, [WORKER_SCRIPT, "--install"], {
		timeout: 900_000,
		windowsHide: true,
		signal,
		encoding: "utf-8",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	return JSON.parse(stdout.trim());
}

function formatDepsReport(deps: Array<{ name: string; ok: boolean; version: string; path: string; detail: string }>): string {
	const rows = deps.map((s) => {
		const state = s.ok ? "✅" : "❌";
		// wpscli 的 --version 输出是一整句（wpscli version 1.1.0, skill version 2.1.0），只取首个版本号
		const semver = s.version.match(/\d+\.\d+[\w.\-]*/)?.[0] ?? "";
		const ver = semver ? `v${semver}` : "";
		const loc = s.path || s.detail;
		return `| ${state} | ${s.name} | ${ver} | ${loc.replace(/\|/g, "\\|")} |`;
	});
	return [
		"## 依赖体检报告",
		"",
		"| 状态 | 依赖 | 版本 | 位置/说明 |",
		"|---|---|---|---|---|",
		...rows,
		"",
		deps.find((d) => d.name === "wpscli")?.ok
			? "wpscli 就绪——OCR 主力通道可用。"
			: "wpscli 缺失——图片/扫描件将全部依赖视觉模型兜底（PI_VISION_MODEL 或已配置的视觉模型）。",
	].join("\n");
}

// ── 单工具 readall ───────────────────────────────────────────────────────

const READALL_ACTIONS = ["read", "submit", "status", "wait", "cancel", "list", "setup"] as const;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "readall",
		label: "ReadAll 万物可读",
		description:
			"本地文档/图片转文字总入口（OCR 主力 + 视觉兜底）。action=read（默认）同步读取：图片、扫描件 PDF（WPS OCR 整本识别）、文字版 PDF、Office（docx/xlsx/pptx/doc/xls/ppt/wps/et/dps）、odt/epub/rtf/csv；WPS OCR 失败自动切页交给视觉模型兜底。action=submit/status/wait/cancel/list 异步任务队列（大文件后台跑、跨会话查；分离进程无视觉兜底）。action=setup 依赖体检/安装。加密文档传 password；大结果自动落盘只回大纲+节选。",
		promptSnippet: "本地文件感知（OCR 读图/读文档，视觉兜底）",
		promptGuidelines: [
			"读本地文件（PDF/Office/图片/扫描件…）一律用 readall(action:\"read\")，不要用 cat 或自己解析。",
			"批量图片、几十页扫描件识别文字用 readall：WPS OCR 整本转，比逐张视觉调用快且省。",
			"readall 结果超过内联阈值会自动落盘并返回大纲+节选+文件路径，用 read 按需读全文。",
			"缺依赖报错用 action:\"setup\"：先无参体检，用户同意后才加 install:true。",
			"特别大的文件用 action:\"submit\" 后台转换（注意：后台任务没有视觉兜底，WPS 失败即失败）。",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("read"),
						Type.Literal("submit"),
						Type.Literal("status"),
						Type.Literal("wait"),
						Type.Literal("cancel"),
						Type.Literal("list"),
						Type.Literal("setup"),
					],
					{
						description: "read=同步读取（默认）；submit/status/wait/cancel/list=异步任务队列；setup=依赖体检/安装",
						default: "read",
					},
				),
			),
			paths: Type.Array(Type.String({ description: "本地文件路径（绝对或相对）" }), {
				description: "待读取文件（read/submit 用；可多个，多张图片合并 OCR）",
			}),
			id: Type.Optional(Type.String({ description: "任务 id（status/wait/cancel 必填）" })),
			outputPath: Type.Optional(
				Type.String({ description: "结果另存为 .md（不覆盖同名）；相对路径落在 Agent临时工作/output/" }),
			),
			prompt: Type.Optional(
				Type.String({
					description:
						"视觉兜底时的识别要求（可选）。默认逐字 OCR 提取全部文字；也可给结构化指令，如\"提取每张身份证的姓名、身份证号、住址，逐字勿漏\"。",
				}),
			),
			password: Type.Optional(
				Type.String({ description: "加密文档打开密码（只在内存中临时使用，绝不落盘持久化）" }),
			),
			method: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("wps"), Type.Literal("vision")], {
					description: "auto=WPS OCR 优先、失败视觉兜底；wps=只走 WPS；vision=强制视觉模型。默认 auto",
					default: "auto",
				}),
			),
			range: Type.Optional(
				Type.String({ description: "PDF 页码范围（如 \"1-5\"），默认全部页；仅对 PDF 生效" }),
			),
			wait: Type.Optional(
				Type.Boolean({ description: "submit 时设为 true 阻塞等待任务完成（默认 false）", default: false }),
			),
			timeoutSec: Type.Optional(Type.Number({ description: "wait 的超时秒数（默认 600）", default: 600 })),
			limit: Type.Optional(Type.Number({ description: "list 返回的最大记录数（默认 20）", default: 20 })),
			install: Type.Optional(
				Type.Boolean({ description: "setup：true=自动安装缺失的可安装依赖；默认 false 只体检", default: false }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action ?? "read";

			switch (action) {
				// ── read：同步读取（OCR 主力 + 视觉兜底）─────────────────────
				case "read": {
					// worker 在有待兜底页图时会保留临时目录并回传路径；读完/失败都要回收
					let tmpDirToClean: string | undefined;
					try {
						const spec = {
							paths: params.paths,
							outputPath: params.outputPath,
							method: params.method,
							range: params.range,
							workspace: ctx.cwd,
						};
						const res = await callWorkerSpec(spec, params.password, signal);
						const details: Record<string, unknown> = { ...(res.details || {}) };
						tmpDirToClean = (res.details?.tmpDir as string | undefined) || undefined;
						delete details.tmpDir;

						// worker 已产出全部文字 → 直接走落盘/内联判断
						if (!res.details?.visionRequests?.length) {
							const spilled = spillToDisk(res.body ?? res.text ?? "", ctx.cwd, params.outputPath);
							if (spilled.savedTo) details.output = spilled.savedTo;
							return toolResult(spilled.text, details);
						}

						// 有视觉兜底需求 → 扩展层执行（分离进程做不到）
						if (!hasVisionCandidate(ctx)) {
							return toolError(
								[
									"WPS OCR 对部分输入失败，需要视觉模型兜底，但当前没有可用的视觉模型。",
									"请配置 PI_VISION_MODEL / PI_VISION_FALLBACK_MODELS，或在本机配置任一支持图片输入的模型。",
									"",
									"WPS 失败原因：",
									...(res.details.visionRequests as Array<{ reason: string }>).map((r) => `  - ${r.reason}`),
								].join("\n"),
								{ error: "no_vision_model", details: res.details },
							);
						}

						const fallback = await runVisionFallback(
							ctx,
							res.details.visionRequests as Array<{ images: string[]; reason: string; label?: string }>,
							params.prompt,
							signal,
						);

						const bodyParts: string[] = [];
						if (res.body?.trim()) bodyParts.push(res.body);
						// 视觉结果同样过一遍确定性校验（信用代码校验位等）
						if (fallback.sections.length) bodyParts.push(appendUsccWarnings(fallback.sections.join("\n\n---\n\n")));
						// 兜底失败必须可见：之前只塞进 details，正文一片空白看着像成功
						if (fallback.errors.length) {
							bodyParts.push(fallback.errors.map((e) => `> ⚠️ 视觉兜底失败：${e}`).join("\n"));
						}
						const body = bodyParts.join("\n\n---\n\n");

						details.visionModels = fallback.models;
						details.visionErrors = fallback.errors;
						const spilled = spillToDisk(body, ctx.cwd, params.outputPath);
						if (spilled.savedTo) details.output = spilled.savedTo;
						if (!fallback.sections.length && fallback.errors.length) {
							return toolError(spilled.text, { ...details, error: "vision_failed" });
						}
						return toolResult(spilled.text, details);
					} catch (err) {
						if (signal?.aborted) return toolError("已取消。", { error: "aborted" });
						return toolError(`readall read 执行失败: ${messageOf(err)}`, { error: messageOf(err) });
					} finally {
						if (tmpDirToClean) {
							try {
								rmSync(tmpDirToClean, { recursive: true, force: true });
							} catch {
								// 清理失败不影响结果
							}
						}
					}
				}

				// ── submit：提交异步任务 ─────────────────────────────────────
				case "submit": {
					const paths = params.paths || [];
					if (!paths.length) return toolError("submit 失败：请提供 paths 参数", { error: "missing paths" });
					try {
						const res = submitJob({
							paths,
							password: params.password,
							outputPath: params.outputPath,
							method: params.method,
							range: params.range,
							workspace: ctx.cwd,
						});

						if (params.wait === true) {
							const waitRes = await waitJob(res.jobId, params.timeoutSec ?? 600);
							const job = waitRes.job || readJob(res.jobId);
							const summary = [
								`任务 ${res.jobId} 已完成（终态：${job?.status}）`,
								job?.resultPath ? `产物路径：${job.resultPath}` : "",
								job?.error ? `错误信息：${job.error}` : "",
							]
								.filter(Boolean)
								.join("\n");
							return toolResult(summary, { ...job, waitCompleted: true });
						}

						const msg = [
							`已提交后台转换任务：`,
							`- Job ID: ${res.jobId}`,
							`- 初始状态: ${res.status}`,
							`- 产物将保存至: ${res.jobDir}/result.md`,
							``,
							`后续操作：`,
							`- 查看状态: readall({ action: "status", id: "${res.jobId}" })`,
							`- 等待完成: readall({ action: "wait", id: "${res.jobId}" })`,
							`- 取消任务: readall({ action: "cancel", id: "${res.jobId}" })`,
							``,
							`注意：后台任务没有视觉兜底（WPS 失败即失败）；需要兜底请用同步 read 分批执行。`,
						].join("\n");
						return toolResult(msg, res);
					} catch (err) {
						return toolError(`submit 失败: ${messageOf(err)}`, { error: messageOf(err) });
					}
				}

				// ── status ───────────────────────────────────────────────────
				case "status": {
					if (!params.id) return toolError("status 失败：缺少 id 参数", { error: "missing id" });
					const job = readJob(params.id);
					if (!job) return toolError(`未找到任务: ${params.id}`, { error: "not found" });

					const lines = [
						`## 任务详情: ${job.id}`,
						`- 状态: **${job.status}**`,
						`- 提交时间: ${job.createdAt}`,
						job.startedAt ? `- 开始时间: ${job.startedAt}` : "",
						job.finishedAt ? `- 完成时间: ${job.finishedAt}` : "",
						`- 输入文件: ${(job.spec?.paths || []).join("、")}`,
						job.resultPath ? `- 产物 Markdown: **${job.resultPath}**` : "",
						job.error ? `- 错误信息: ${job.error}` : "",
					].filter(Boolean);
					return toolResult(lines.join("\n"), job);
				}

				// ── wait ─────────────────────────────────────────────────────
				case "wait": {
					if (!params.id) return toolError("wait 失败：缺少 id 参数", { error: "missing id" });
					const res = await waitJob(params.id, params.timeoutSec ?? 600);
					const job = res.job || readJob(params.id);
					const lines = [
						res.ok ? `✅ 任务 ${params.id} 执行成功` : `⚠️ 任务 ${params.id} 未成功（状态: ${job?.status}）`,
						job?.resultPath ? `- 产物路径: **${job.resultPath}**（可用 read 工具直接读取）` : "",
						job?.error ? `- 错误原因: ${job.error}` : "",
					].filter(Boolean);
					return toolResult(lines.join("\n"), { ...job, ok: res.ok });
				}

				// ── cancel ───────────────────────────────────────────────────
				case "cancel": {
					if (!params.id) return toolError("cancel 失败：缺少 id 参数", { error: "missing id" });
					const res = cancelJob(params.id);
					if (!res.ok) return toolError(`取消失败: ${res.error}`, res);
					return toolResult(`任务 ${params.id} 已取消（关联后台进程已终止）。`, res);
				}

				// ── list ─────────────────────────────────────────────────────
				case "list": {
					const limit = Math.max(1, Math.min(100, params.limit ?? 20));
					const jobs = listJobs(limit);
					if (!jobs.length) return toolResult("暂无转换任务记录。", { count: 0, jobsRoot: JOBS_ROOT });

					const rows = jobs.map((j) => {
						const file = path.basename(j.spec?.paths?.[0] || "unknown");
						const state =
							j.status === "succeeded" ? "✅ succeeded" : j.status === "failed" ? "❌ failed" : j.status === "cancelled" ? "⏹️ cancelled" : "⏳ " + j.status;
						const result = j.resultPath ? path.basename(j.resultPath) : j.error ? j.error.slice(0, 30) : "-";
						return `| \`${j.id}\` | ${state} | ${file} | ${j.createdAt.slice(0, 19).replace("T", " ")} | ${result} |`;
					});
					const table = [
						`## 最近任务列表（前 ${jobs.length} 条，存储根目录: \`${JOBS_ROOT}\`）`,
						"",
						"| Job ID | 状态 | 输入文件 | 提交时间 | 产物/错误 |",
						"|---|---|---|---|---|",
						...rows,
					].join("\n");
					return toolResult(table, { count: jobs.length, jobs });
				}

				// ── setup：依赖体检 / 安装 ───────────────────────────────────
				case "setup": {
					try {
						if (params.install === true) {
							const res = await callWorkerInstall(signal);
							const outcomes = (res.outcomes || []) as Array<{
								name: string;
								ranOk: boolean;
								skipped?: boolean;
								detected?: boolean;
								note?: string;
							}>;
							const outcomeLines = outcomes.map((o) => {
								const state = o.skipped ? "⏭️ 已跳过" : o.ranOk ? "✅ 已执行" : "❌ 失败";
								const detected = o.detected === undefined ? "" : o.detected ? "，复检已识别" : "，复检仍未识别";
								return `- ${state} ${o.name}${detected}${o.note ? `：${o.note}` : ""}`;
							});
							const body = [formatDepsReport(res.deps), "", "## 安装结果", outcomeLines.length ? outcomeLines.join("\n") : "- 无需安装"].join("\n");
							return toolResult(body, res);
						}
						const res = await callWorkerDeps();
						return toolResult(formatDepsReport(res.deps), res);
					} catch (err) {
						return toolError(`体检执行失败: ${messageOf(err)}`, { error: messageOf(err) });
					}
				}

				default:
					return toolError(`未知 action: ${action}`, { error: "invalid action" });
			}
		},
	});
}
