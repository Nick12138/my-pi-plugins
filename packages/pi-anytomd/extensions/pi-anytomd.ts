/**
 * AnyToMD (pi-anytomd) — read any local file (images / Office / PDF / ODF / EPUB / RTF / CSV) as Markdown.
 *
 * Tools:
 *   - anytomd        : 同步转换入口。自动格式分发（WPS OCR + pandoc 原生 + officecli + 百度 OCR 降级）。
 *                      支持 password 参数处理加密文档。
 *   - anyjob         : 异步任务管理器（跨会话持久任务库，对标 myagents-anydoc）。
 *                      actions: submit / status / wait / cancel / list
 *   - anytomd_setup  : 依赖体检报告 + 一键自动安装。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.resolve(__dirname, "..", "worker.mjs");

const MAX_CONTEXT_CHARS = 200_000;

function truncate(text: string, max = MAX_CONTEXT_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…(内容过长已截断，完整共 ${text.length} 字符；可用 outputPath 或 anyjob 落盘获取全文)`;
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

/**
 * 跨平台调用 worker.mjs 的同步模式。
 */
async function callWorkerSpec(spec: Record<string, unknown>, password?: string, signal?: AbortSignal) {
	const tmpSpec = path.join(os.tmpdir(), `anytomd-spec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(tmpSpec, JSON.stringify(spec, null, 2), "utf-8");

	const childEnv: Record<string, string | undefined> = {
		...process.env,
		ELECTRON_RUN_AS_NODE: "1",
	};
	if (password) {
		childEnv.ANYTOMD_PASSWORD = password;
	}

	try {
		const { stdout } = await execFileAsync(process.execPath, [WORKER_SCRIPT, "--spec", tmpSpec], {
			timeout: 900_000,
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

/**
 * 调用 worker.mjs --deps
 */
async function callWorkerDeps(): Promise<{ deps: Array<{ name: string; ok: boolean; version: string; path: string; detail: string }>; allOk: boolean }> {
	const { stdout } = await execFileAsync(process.execPath, [WORKER_SCRIPT, "--deps"], {
		timeout: 30_000,
		windowsHide: true,
		encoding: "utf-8",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	return JSON.parse(stdout.trim());
}

/**
 * 调用 worker.mjs --install
 */
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

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// 1. anytomd（同步主工具）
	// =========================================================================
	pi.registerTool({
		name: "anytomd",
		label: "AnyToMD",
		description:
			"Read any local file as Markdown, by path. Auto-dispatch: images (single → WPS photo2word; " +
			"multiple → merge PDF → WPS scanned OCR), Office files (docx/xlsx/pptx → officecli view text; " +
			"legacy doc/xls/ppt/wps/et/dps → wpscli convert → pdf2md), Pandoc formats (odt/epub/rtf/csv/tsv → pandoc), " +
			"PDF (auto text/scanned detection: text → pdf2md, scanned → pdf2word --scanned OCR → markdown), txt/md direct read. " +
			"Supports password for encrypted documents. Quality gate auto-falls-back to Baidu OCR when WPS output is empty/garbled. " +
			"For asynchronous/background jobs that persist across sessions, use anyjob instead. " +
			"Optional outputPath persists the Markdown. Intermediate files cleaned up automatically.",
		promptSnippet:
			"Read any local file (image/Office/PDF/ODF/EPUB/RTF/CSV) as Markdown; auto OCR; encrypted doc password; Baidu fallback; optional md output",
		promptGuidelines: [
			"Use anytomd when the user asks to read/extract a local file by path — images, docx/xlsx/pptx, legacy Office, ODT, EPUB, RTF, CSV, PDF.",
			"Pass password when reading encrypted/password-protected PDFs or Office files.",
			"Pass multiple image paths in one call to merge them; one file per section for non-images; PDF page ranges via range (e.g. \"1-5\").",
			"If the returned text looks wrong or garbled, retry with method=\"ocr\" to force Baidu OCR.",
			"For long-running conversions or when cross-session task tracking is needed, use anyjob.",
			"Run anytomd_setup (no args) when a dependency error appears; anytomd_setup({install:true}) auto-installs pandoc/officecli.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "One or more local file paths (absolute or relative)" }), {
				description: "文件路径；多张图片会合并为一份结果",
			}),
			outputPath: Type.Optional(
				Type.String({
					description:
						"可选：结果同时落盘为 .md 文件（已存在自动改名，不覆盖）。相对路径落到当前工作区的 Agent临时工作/output/；绝对路径按原样保存。",
				}),
			),
			password: Type.Optional(
				Type.String({
					description: "文档打开密码（加密 PDF / Office 文件）。仅在内存中临时使用，绝不落盘持久化。",
				}),
			),
			method: Type.Optional(
				Type.Union(
					[Type.Literal("auto"), Type.Literal("wps"), Type.Literal("ocr")],
					{
						description:
							"auto = WPS 优先、质量差自动降级到百度 OCR；wps = 只用 WPS 链路；ocr = 强制百度 OCR（图片/扫描件 PDF）。默认 auto",
						default: "auto",
					},
				),
			),
			accuracy: Type.Optional(
				Type.Union(
					[Type.Literal("standard"), Type.Literal("accurate")],
					{ description: "百度 OCR 精度：standard 标准版（快）/ accurate 高精度版（更准更慢）。默认 standard", default: "standard" },
				),
			),
			concurrency: Type.Optional(
				Type.Number({
					description: "百度 OCR 并发数 1-10（默认 2；未付费百度账号 QPS=2，开按量后可到 10）",
				}),
			),
			range: Type.Optional(
				Type.String({
					description: "PDF 页码范围（单段，如 \"1-5\" 或 \"3\"），默认全部页；仅对 PDF 生效",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const spec = {
				paths: params.paths,
				outputPath: params.outputPath,
				method: params.method,
				accuracy: params.accuracy,
				concurrency: params.concurrency,
				range: params.range,
				workspace: process.cwd(),
			};

			try {
				const res = await callWorkerSpec(spec, params.password, signal);
				return toolResult(truncate(res.text || ""), res.details || {});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolResult(`anytomd 转换执行失败: ${msg}`, { error: msg });
			}
		},
	});

	// =========================================================================
	// 2. anyjob（异步任务管理工具，对标 myagents-anydoc）
	// =========================================================================
	pi.registerTool({
		name: "anyjob",
		label: "AnyToMD Job Manager",
		description:
			"Asynchronous document conversion job manager (persists across sessions, background execution, 16-job concurrency queue, stale detection). " +
			"Equivalent to myagents-anydoc CLI workflow. Actions: " +
			"submit (creates detached job, exits immediately unless wait=true), " +
			"status (inspects one job by id, auto-detects stale crashed workers), " +
			"wait (polls a job until terminal state: succeeded/failed/cancelled), " +
			"cancel (kills process tree and marks job cancelled), " +
			"list (lists recent jobs sorted by date). " +
			"Artifacts stored in ~/.pi/anytomd-jobs/jobs/<job-id>/result.md.",
		promptSnippet:
			"Async conversion job queue: submit/status/wait/cancel/list; background execution surviving session end; cross-session persistence",
		promptGuidelines: [
			"Use anyjob submit when converting large documents, running multiple conversions in parallel, or when the conversion should continue in background across sessions.",
			"Pass wait=true during submit if the current turn needs to block until complete, or submit then query later with status/wait.",
			"When a job finishes with status 'succeeded', use the standard read tool to read the returned resultPath (~/.pi/anytomd-jobs/jobs/<id>/result.md).",
			"Use anyjob list to discover previous job IDs or review conversion history.",
			"Use anyjob cancel <id> to stop a running or queued job (kills the background process tree).",
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
				{ description: "操作类型: submit(提交) | status(查状态) | wait(等待完成) | cancel(取消) | list(列出历史)" },
			),
			id: Type.Optional(Type.String({ description: "任务 ID（status/wait/cancel 必填）" })),
			file: Type.Optional(Type.String({ description: "待转换的单个本地文件路径（submit 时使用）" })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "多文件路径（如多张图片合并为一个任务）" })),
			password: Type.Optional(Type.String({ description: "文档密码（临时透传给 worker，不写入 job.json 持久化）" })),
			outputPath: Type.Optional(Type.String({ description: "可选额外落盘目录/文件路径" })),
			method: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("wps"), Type.Literal("ocr")])),
			accuracy: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("accurate")])),
			range: Type.Optional(Type.String({ description: "PDF 页码范围" })),
			wait: Type.Optional(Type.Boolean({ description: "submit 时设为 true 会阻塞等待任务完成（默认 false 立即返回）", default: false })),
			timeoutSec: Type.Optional(Type.Number({ description: "wait 操作的超时秒数（默认 600 秒）", default: 600 })),
			limit: Type.Optional(Type.Number({ description: "list 返回的最大记录数（默认 20）", default: 20 })),
		}),

		async execute(_toolCallId, params) {
			const action = params.action;

			switch (action) {
				case "submit": {
					const file = params.file;
					const paths = params.paths || (file ? [file] : []);
					if (!paths.length) {
						return toolResult("anyjob submit 失败：请提供 file 或 paths 参数", { error: "missing file" });
					}

					try {
						const res = submitJob({
							paths,
							password: params.password,
							outputPath: params.outputPath,
							method: params.method,
							accuracy: params.accuracy,
							range: params.range,
							workspace: process.cwd(),
						});

						if (params.wait === true) {
							const waitRes = await waitJob(res.jobId, params.timeoutSec ?? 600);
							const job = waitRes.job || readJob(res.jobId);
							const summary = [
								`任务 ${res.jobId} 已完成（终态：${job?.status}）`,
								job?.resultPath ? `产物路径：${job.resultPath}` : "",
								job?.error ? `错误信息：${job.error}` : "",
							].filter(Boolean).join("\n");
							return toolResult(summary, { ...job, waitCompleted: true });
						}

						const msg = [
							`已成功提交后台转换任务：`,
							`- Job ID: ${res.jobId}`,
							`- 初始状态: ${res.status}`,
							`- 产物将保存至: ${res.jobDir}/result.md`,
							``,
							`后续操作：`,
							`- 查看状态: anyjob({ action: "status", id: "${res.jobId}" })`,
							`- 等待完成: anyjob({ action: "wait", id: "${res.jobId}" })`,
							`- 取消任务: anyjob({ action: "cancel", id: "${res.jobId}" })`,
						].join("\n");

						return toolResult(msg, res);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return toolResult(`anyjob submit 失败: ${msg}`, { error: msg });
					}
				}

				case "status": {
					if (!params.id) return toolResult("anyjob status 失败：缺少 id 参数", { error: "missing id" });
					const job = readJob(params.id);
					if (!job) return toolResult(`未找到任务: ${params.id}`, { error: "not found" });

					const lines = [
						`## 任务详情: ${job.id}`,
						`- 状态: **${job.status}**`,
						`- 提交时间: ${job.createdAt}`,
						job.startedAt ? `- 开始时间: ${job.startedAt}` : "",
						job.finishedAt ? `- 完成时间: ${job.finishedAt}` : "",
						job.pid ? `- Worker PID: ${job.pid}` : "",
						`- 输入文件: ${(job.spec?.paths || []).join("、")}`,
						job.resultPath ? `- 产物 Markdown: **${job.resultPath}**` : "",
						job.outputPath ? `- 额外落盘: ${job.outputPath}` : "",
						job.error ? `- 错误信息: ${job.error}` : "",
					].filter(Boolean);

					return toolResult(lines.join("\n"), job);
				}

				case "wait": {
					if (!params.id) return toolResult("anyjob wait 失败：缺少 id 参数", { error: "missing id" });
					const timeout = params.timeoutSec ?? 600;
					const res = await waitJob(params.id, timeout);
					const job = res.job || readJob(params.id);

					const lines = [
						res.ok ? `✅ 任务 ${params.id} 执行成功` : `⚠️ 任务 ${params.id} 未成功（状态: ${job?.status}）`,
						job?.resultPath ? `- 产物路径: **${job.resultPath}**（可用 read 工具直接读取）` : "",
						job?.error ? `- 错误原因: ${job.error}` : "",
					].filter(Boolean);

					return toolResult(lines.join("\n"), { ...job, ok: res.ok });
				}

				case "cancel": {
					if (!params.id) return toolResult("anyjob cancel 失败：缺少 id 参数", { error: "missing id" });
					const res = cancelJob(params.id);
					if (!res.ok) return toolResult(`取消失败: ${res.error}`, res);
					return toolResult(`任务 ${params.id} 已取消（关联后台进程已终止）。`, res);
				}

				case "list": {
					const limit = Math.max(1, Math.min(100, params.limit ?? 20));
					const jobs = listJobs(limit);
					if (!jobs.length) return toolResult("暂无转换任务记录。", { count: 0, jobsRoot: JOBS_ROOT });

					const rows = jobs.map((j) => {
						const file = path.basename(j.spec?.paths?.[0] || "unknown");
						const state = j.status === "succeeded" ? "✅ succeeded" : j.status === "failed" ? "❌ failed" : j.status === "cancelled" ? "⏹️ cancelled" : "⏳ " + j.status;
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

				default:
					return toolResult(`未知 action: ${action}`, { error: "invalid action" });
			}
		},
	});

	// =========================================================================
	// 3. anytomd_setup（体检与依赖安装工具）
	// =========================================================================
	pi.registerTool({
		name: "anytomd_setup",
		label: "AnyToMD Setup",
		description:
			"Dependency health check and one-shot auto-install for AnyToMD. No args → read-only report: " +
			"wpscli (WPS Office, located never installed), officecli, pandoc, Baidu OCR keys. " +
			"install=true → auto-install missing installables: pandoc via winget, officecli via official script.",
		promptSnippet:
			"Check or auto-install AnyToMD dependencies (wpscli/officecli/pandoc/Baidu keys); install=true runs installers",
		promptGuidelines: [
			"Run anytomd_setup() first when anytomd reports a missing dependency.",
			"Pass install=true only when authorized to install missing tools (pandoc, officecli).",
		],
		parameters: Type.Object({
			install: Type.Optional(
				Type.Boolean({
					description: "true = 自动安装缺失的可安装依赖；默认 false 只体检不安装",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				if (params.install === true) {
					const res = await callWorkerInstall(signal);
					const report = formatDepsReport(res.deps);
					return toolResult(`${report}\n\n已执行安装操作。`, res);
				}

				const res = await callWorkerDeps();
				const report = formatDepsReport(res.deps);
				return toolResult(report, res);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolResult(`体检执行失败: ${msg}`, { error: msg });
			}
		},
	});
}

function formatDepsReport(deps: Array<{ name: string; ok: boolean; version: string; path: string; detail: string }>): string {
	const rows = deps.map((s) => {
		const state = s.ok ? "✅" : "❌";
		const ver = s.version ? `v${s.version}` : "";
		const loc = s.path || s.detail;
		return `| ${state} | ${s.name} | ${ver} | ${loc.replace(/\|/g, "\\|")} |`;
	});
	return [
		"## 依赖体检报告",
		"",
		"| 状态 | 依赖 | 版本 | 位置/说明 |",
		"|---|---|---|---|",
		...rows,
		"",
		deps.every((s) => s.ok)
			? "全部就绪 ✅"
			: "存在缺失——运行 anytomd_setup({ install: true }) 自动安装。",
	].join("\n");
}
