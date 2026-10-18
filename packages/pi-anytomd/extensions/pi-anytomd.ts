/**
 * AnyToMD (pi-anytomd) — read any local file (images / Office / PDF / ODF / EPUB / RTF / CSV) as Markdown.
 *
 * 单工具 anytomd，按 action 分发：
 *   - convert            : 同步转换入口（默认）。自动格式分发（WPS OCR + pandoc 原生 + officecli + 百度 OCR 降级），
 *                          支持 password 参数处理加密文档。
 *   - submit/status/wait/cancel/list : 异步任务管理器（跨会话持久任务库，对标 myagents-anydoc）。
 *   - setup              : 依赖体检报告 + 一键自动安装（install=true）。
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
	return `${text.slice(0, max)}\n\n…(内容过长已截断，完整共 ${text.length} 字符；可用 outputPath 或 action:"submit" 异步落盘获取全文)`;
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

const ANYTOMD_ACTIONS = ["convert", "submit", "status", "wait", "cancel", "list", "setup"] as const;

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// 单工具 anytomd，按 action 分发：
	//   convert（同步转换，默认）/ submit·status·wait·cancel·list（异步任务队列）
	//   setup（依赖体检与安装）
	// =========================================================================
	pi.registerTool({
		name: "anytomd",
		label: "AnyToMD",
		description:
			"本地文档转 Markdown 总入口。action=convert（默认）同步转换：图片、Office（docx/xlsx/pptx 及 doc/xls/ppt/wps/et/dps）、ODF/EPUB/RTF/CSV、PDF（自动判别文字/扫描，扫描走 OCR）；action=submit/status/wait/cancel/list 异步任务队列（大文件、批量、跨会话续跑，落盘 ~/.pi/anytomd-jobs/）；action=setup 依赖体检/安装（install=true 才装 pandoc、officecli）。加密文档传 password；结果乱码或为空时改 method=\"ocr\"。",
		promptSnippet: "本地文档转 Markdown（转换/队列/体检）",
		promptGuidelines: [
			"读本地文件（PDF/Office/图片/EPUB…）一律用 anytomd(action:\"convert\")，不要用 cat 或 Python 库自己解析。",
			"缺依赖报错用 action:\"setup\"：先无参体检，用户同意后才加 install=true。",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("convert"),
						Type.Literal("submit"),
						Type.Literal("status"),
						Type.Literal("wait"),
						Type.Literal("cancel"),
						Type.Literal("list"),
						Type.Literal("setup"),
					],
					{
						description: "convert=同步转换（默认）；submit/status/wait/cancel/list=异步任务队列；setup=依赖体检/安装",
						default: "convert",
					},
				),
			),
			paths: Type.Array(Type.String({ description: "本地文件路径（绝对或相对）" }), {
				description: "待转换文件（convert 可多个；多张图片合并为一份结果；submit 用 file 或 paths）",
			}),
			id: Type.Optional(Type.String({ description: "任务 id（status/wait/cancel 必填）" })),
			outputPath: Type.Optional(
				Type.String({
					description: "结果另存为 .md（不覆盖同名）；相对路径落在会话输出目录。",
				}),
			),
			password: Type.Optional(
				Type.String({
					description: "加密文档打开密码（只在内存中临时使用，绝不落盘持久化）。",
				}),
			),
			method: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("wps"), Type.Literal("ocr")], {
					description: "auto=WPS 优先、质量差自动降级百度 OCR；wps=只走 WPS；ocr=强制百度 OCR（图片/扫描件 PDF）。默认 auto",
					default: "auto",
				}),
			),
			accuracy: Type.Optional(
				Type.Union([Type.Literal("standard"), Type.Literal("accurate")], {
					description: "百度 OCR 精度：standard(快) / accurate(准而慢)。默认 standard",
					default: "standard",
				}),
			),
			concurrency: Type.Optional(
				Type.Number({
					description: "百度 OCR 并发数 1-10（默认 2；未付费百度账号 QPS=2）",
				}),
			),
			range: Type.Optional(
				Type.String({
					description: "PDF 页码范围（单段，如 \"1-5\"），默认全部页；仅对 PDF 生效",
				}),
			),
			wait: Type.Optional(
				Type.Boolean({ description: "submit 时设为 true 会阻塞等待任务完成（默认 false 立即返回）", default: false }),
			),
			timeoutSec: Type.Optional(Type.Number({ description: "wait 的超时秒数（默认 600）", default: 600 })),
			limit: Type.Optional(Type.Number({ description: "list 返回的最大记录数（默认 20）", default: 20 })),
			install: Type.Optional(
				Type.Boolean({
					description: "setup：true=自动安装缺失的可安装依赖；默认 false 只体检不安装",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const action = params.action ?? "convert";

			switch (action) {
				// ── convert：同步转换（原 anytomd） ─────────────────────────────
				case "convert": {
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
				}

				// ── submit：提交异步任务（原 anyjob submit） ────────────────────
				case "submit": {
					const paths = params.paths || [];
					if (!paths.length) {
						return toolResult("submit 失败：请提供 file 或 paths 参数", { error: "missing file" });
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
							`- 查看状态: anytomd({ action: "status", id: "${res.jobId}" })`,
							`- 等待完成: anytomd({ action: "wait", id: "${res.jobId}" })`,
							`- 取消任务: anytomd({ action: "cancel", id: "${res.jobId}" })`,
						].join("\n");

						return toolResult(msg, res);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return toolResult(`submit 失败: ${msg}`, { error: msg });
					}
				}

				// ── status：查状态（原 anyjob status） ──────────────────────────
				case "status": {
					if (!params.id) return toolResult("status 失败：缺少 id 参数", { error: "missing id" });
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

				// ── wait：等待完成（原 anyjob wait） ────────────────────────────
				case "wait": {
					if (!params.id) return toolResult("wait 失败：缺少 id 参数", { error: "missing id" });
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

				// ── cancel：取消（原 anyjob cancel） ────────────────────────────
				case "cancel": {
					if (!params.id) return toolResult("cancel 失败：缺少 id 参数", { error: "missing id" });
					const res = cancelJob(params.id);
					if (!res.ok) return toolResult(`取消失败: ${res.error}`, res);
					return toolResult(`任务 ${params.id} 已取消（关联后台进程已终止）。`, res);
				}

				// ── list：任务历史（原 anyjob list） ────────────────────────────
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

				// ── setup：依赖体检 / 安装（原 anytomd_setup） ──────────────────
				case "setup": {
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
				}

				default:
					return toolResult(`未知 action: ${action}`, { error: "invalid action" });
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
			: "存在缺失——运行 anytomd({ action: \"setup\", install: true }) 自动安装。",
	].join("\n");
}
