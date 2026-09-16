/**
 * pi-shelljob：后台 Shell 任务。
 *
 * - shelljob：提交后台 shell 命令（detached 新进程组，宿主退出不影响）、查看列表/日志、终止
 * - shell_wait：阻塞等待任务完成（支持超时与中止，后台任务不受影响）
 * - 完成/失败/终止自动通知发起会话（投递确认 + 合并批处理 + 重启补发）
 * - 全量落盘 ~/.pi/shelljob/jobs/<id>/（job.json / status.json / output.log），跨会话可查
 * - Windows taskkill /T /F 杀整棵进程树；Unix 杀 detached 进程组
 *
 * 使用边界（写入 promptGuidelines）：短任务用同步 bash，长任务才提交后台。
 */
import { randomUUID } from "node:crypto";
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_LOG_BYTES,
	ensureJobDir,
	isTerminal,
	loadAllJobs,
	loadJobRecord,
	readOutputTail,
	readStatus,
	scanJobs,
	writeJob,
	writeStatus,
	STATUS_LABEL,
	type ShellJob,
	type ShellJobRecord,
	type ShellJobStatusData,
} from "../src/store.ts";
import { initRunner, killShellJob, spawnShellJob, startMonitorLoop } from "../src/runner.ts";

const NOTIFY_MESSAGE_TYPE = "shelljob-notify";
const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const MAX_PREVIEW_CHARS = 800;
const NOTIFY_TAIL_LINES = 15;

// ── 会话注册表（进程级，按 sessionId 路由）─────────────────
// 与 pi-subagent 同款约束：一个宿主进程可能承载多个会话，每个新会话都会
// 重新执行本扩展入口，严禁把通知目标放进模块级单例。每个会话实例在
// session_start 登记自己的投递管道，终态按 job.sessionId 精准路由。
interface SessionPipe {
	notifier: Notifier;
}
const sessionPipes = new Map<string, SessionPipe>();
let initialized = false;

// ── 完成通知（精简版 Notifier：批量窗口 + 投递确认 + 失败重试）──

function durationText(record: ShellJobRecord): string {
	const { status } = record;
	if (!status.startedAt) return "-";
	const end = status.finishedAt ?? Date.now();
	return `${Math.max(0, Math.round((end - status.startedAt) / 1000))}s`;
}

function formatJobNotice(record: ShellJobRecord, detail: boolean): string {
	const { job, status } = record;
	const label = STATUS_LABEL(status.status);
	const meta = `（${durationText(record)}${status.exitCode !== undefined ? ` · exit ${status.exitCode}` : ""}${status.timedOut ? " · 超时" : ""}）`;
	const lines = [`【后台任务通知】「${job.title}」${label}${meta}`];
	if (status.errorMessage) lines.push(`原因：${status.errorMessage}`);
	if (detail) {
		const tail = readOutputTail(job.id, NOTIFY_TAIL_LINES);
		if (tail.lines.length > 0) {
			const body = tail.lines.join("\n");
			lines.push("", body.length > MAX_PREVIEW_CHARS ? body.slice(0, MAX_PREVIEW_CHARS) + "\n…(已截断)" : body);
		}
	}
	lines.push(`\n查看完整日志：shelljob(action:"log", jobId:"${job.id}")。`);
	return lines.join("\n");
}

class Notifier {
	private readonly sessionId: string | undefined;
	private readonly send: (message: { customType: string; content: string; display: boolean; details?: unknown }) => void;
	private pending = new Map<string, ShellJobRecord>();
	private flushing = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private batchTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(sessionId: string | undefined, send: (message: { customType: string; content: string; display: boolean; details?: unknown }) => void) {
		this.sessionId = sessionId;
		this.send = send;
	}

	queue(record: ShellJobRecord): void {
		const st = readStatus(record.job.id);
		if (!st || st.notified) return;
		if (this.sessionId && record.job.sessionId !== this.sessionId) {
			// 归属不符：标记已通知丢弃，防止吞掉其他会话的通知
			writeStatus(record.job.id, { ...st, notified: true });
			return;
		}
		this.pending.set(record.job.id, record);
		if (!this.batchTimer) {
			this.batchTimer = setTimeout(() => {
				this.batchTimer = null;
				void this.flush();
			}, 1000);
			this.batchTimer.unref?.();
		}
	}

	private async flush(): Promise<void> {
		if (this.flushing) return;
		this.flushing = true;
		try {
			while (this.pending.size > 0) {
				const items = [...this.pending.values()];
				const content =
					items.length === 1
						? formatJobNotice(items[0]!, true)
						: `【后台任务通知】${items.length} 个任务已结束：\n${items.map((r) => `- 「${r.job.title}」${STATUS_LABEL(r.status.status)}（${durationText(r)}）`).join("\n")}\n\n查看详情：shelljob(action:"log", jobId:"<id>")。`;
				try {
					this.send({
						customType: NOTIFY_MESSAGE_TYPE,
						content,
						display: false,
						details: {
							count: items.length,
							jobs: items.map(({ job, status }) => ({ id: job.id, title: job.title, status: status.status, exitCode: status.exitCode })),
						},
					});
					for (const record of items) {
						const st = readStatus(record.job.id);
						if (st) writeStatus(record.job.id, { ...st, notified: true });
						this.pending.delete(record.job.id);
					}
				} catch {
					break; // 会话暂不可投递：保留队列，定时器重试
				}
			}
		} finally {
			this.flushing = false;
		}
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.flush(), 5000);
		this.timer.unref?.();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.batchTimer) clearTimeout(this.batchTimer);
		this.batchTimer = null;
		this.pending.clear();
	}
}

/** 终态路由：按 job.sessionId 送回发起会话；会话离线时标记 notified（状态已落盘，面板/列表可查） */
function routeSettled(record: ShellJobRecord): void {
	const pipe = record.job.sessionId ? sessionPipes.get(record.job.sessionId) : undefined;
	if (pipe) {
		pipe.notifier.queue(record);
		return;
	}
	const st = readStatus(record.job.id);
	if (st && !st.notified) writeStatus(record.job.id, { ...st, notified: true });
}

// ── 公共 helper ──────────────────────────────────────────────

function text(content: string, details: unknown = undefined): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details };
}

function safeSessionId(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionId() ?? null;
	} catch {
		return null;
	}
}

function newJobId(): string {
	return `job_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

function maxLogBytes(): number {
	const v = Number(process.env.SHELLJOB_MAX_LOG_BYTES);
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_LOG_BYTES;
} // 单任务日志保护上限（超过后保护性 kill）

/** 单任务超时：任务参数 > 全局默认（SHELLJOB_DEFAULT_TIMEOUT_MS，0 = 不限） */
function resolveTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs !== undefined) return Math.max(0, timeoutMs);
	const v = Number(process.env.SHELLJOB_DEFAULT_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 终态落盘（幂等）并触发通知路由 */
function settle(jobId: string, update: Partial<ShellJobStatusData> & { status: ShellJobStatusData["status"] }): void {
	const st = readStatus(jobId);
	if (!st || isTerminal(st)) return;
	const merged: ShellJobStatusData = { ...st, ...update };
	writeStatus(jobId, merged);
	const record = loadJobRecord(jobId);
	if (record) routeSettled(record);
}

// ── 工具参数 schema ──────────────────────────────────────────

const Action = StringEnum(["submit", "list", "log", "kill"] as const, {
	description: "操作类型，默认 submit",
	default: "submit",
});

const ShelljobParams = Type.Object({
	action: Type.Optional(Action),
	command: Type.Optional(Type.String({ description: "submit 用：要执行的命令（经系统 shell 解释，Windows 为 cmd、Unix 为 sh）" })),
	cwd: Type.Optional(Type.String({ description: "submit 用：工作目录，默认当前会话目录" })),
	title: Type.Optional(Type.String({ description: "submit 用：任务标题（显示用），默认取命令前 40 字符" })),
	timeoutMs: Type.Optional(Type.Number({ description: "submit 用：单任务超时毫秒，超时自动终止；0 = 不限。默认取全局配置" })),
	jobId: Type.Optional(Type.String({ description: "log/kill 用：目标任务 id" })),
	tail: Type.Optional(Type.Number({ description: "log 用：查看日志尾部行数（默认 200，上限 2000）" })),
});
type ShelljobParamsT = Static<typeof ShelljobParams>;

// ── 工具 execute ─────────────────────────────────────────────

function executeSubmit(params: ShelljobParamsT, ctx: ExtensionContext): AgentToolResult<unknown> {
	const command = params.command?.trim();
	if (!command) return text('submit 需要 command，例如 shelljob({ command: "npm run build" })。');
	const cwd = params.cwd?.trim() || ctx.cwd;
	if (!cwd || !String(cwd).trim()) return text("submit 失败：无法确定工作目录（ctx.cwd 为空且未传 cwd）。请显式传 cwd。");
	const title = (params.title?.trim() || command.slice(0, 40)).slice(0, 120);
	const timeoutMs = resolveTimeout(params.timeoutMs);

	const job: ShellJob = {
		id: newJobId(),
		title,
		command,
		cwd,
		...(timeoutMs > 0 ? { timeoutMs } : {}),
		sessionId: safeSessionId(ctx) ?? undefined,
		createdAt: Date.now(),
	};
	// 先落盘 job.json，再写 running status，最后 spawn（exit 事件可能在 spawn
	// 后毫秒级触发，settle 依赖 status/job 已存在；spawnShellJob 内部还会再写 pid）
	ensureJobDir(job.id);
	writeJob(job);
	writeStatus(job.id, { status: "running", startedAt: Date.now() });
	let pid: number;
	try {
		pid = spawnShellJob(job, timeoutMs);
	} catch (err) {
		settle(job.id, { status: "failed", finishedAt: Date.now(), errorMessage: err instanceof Error ? err.message : String(err) });
		return text(`提交失败：${err instanceof Error ? err.message : String(err)}`);
	}

	const timeoutNote = timeoutMs > 0 ? `，超时 ${Math.round(timeoutMs / 1000)}s 自动终止` : "";
	return text(
		`已提交后台任务 ${job.id}（pid ${pid}${timeoutNote}）：\n$ ${command}\n\n完成/失败会自动通知，无需等待。期间可继续其他工作；需要结果时用 shell_wait(jobId:"${job.id}") 阻塞等待，或 shelljob(action:"log", jobId:"${job.id}") 查看输出。`,
		{ jobId: job.id, pid },
	);
}

function executeList(limit = 30): AgentToolResult<unknown> {
	const records = loadAllJobs().slice(0, limit);
	if (records.length === 0) return text("暂无后台任务。");
	const lines = records.map(({ job, status }) => {
		const exit = status.exitCode !== undefined ? ` · exit ${status.exitCode}` : "";
		const who = status.timedOut ? " · 超时" : "";
		return `- ${job.id}  [${STATUS_LABEL(status.status)}${exit}${who}]  ${durationText({ job, status })}  「${job.title}」\n  $ ${job.command}`;
	});
	const running = records.filter((r) => r.status.status === "running").length;
	return text(`后台任务列表（共 ${records.length} 个，运行中 ${running}）：\n${lines.join("\n")}`);
}

/** 解析任务：完整 id 优先，否则按前缀唯一匹配（供 log/kill 使用） */
function resolveJob(jobId: string): ShellJobRecord | null {
	const exact = loadJobRecord(jobId);
	if (exact) return exact;
	for (const id of scanJobs()) {
		if (id.startsWith(jobId)) return loadJobRecord(id);
	}
	return null;
}

function executeLog(params: ShelljobParamsT): AgentToolResult<unknown> {
	const jobId = params.jobId?.trim();
	if (!jobId) return text("log 需要 jobId。");
	const record = resolveJob(jobId);
	if (!record) return text(`任务 ${jobId} 不存在。`);
	const maxLines = params.tail ?? 200;
	const { lines, total } = readOutputTail(record.job.id, maxLines);
	const head =
		`「${record.job.title}」[${STATUS_LABEL(record.status.status)}] ${durationText(record)}${record.status.exitCode !== undefined ? ` · exit ${record.status.exitCode}` : ""}\n` +
		`$ ${record.job.command}\n\n`;
	const prefix = `（输出共 ${total} 行，显示尾部 ${lines.length} 行）\n`;
	const body = lines.length > 0 ? lines.join("\n") : "（暂无输出）";
	return text(head + prefix + body, { jobId: record.job.id, total, shown: lines.length });
}

function executeKill(jobId: string): AgentToolResult<unknown> {
	if (!jobId?.trim()) return text("kill 需要 jobId。");
	const record = resolveJob(jobId);
	if (!record) return text(`任务 ${jobId} 不存在。`);
	if (isTerminal(record.status)) return text(`任务「${record.job.title}」已结束（${STATUS_LABEL(record.status.status)}），无需终止。`);
	return killShellJob(record.job.id).then((r) =>
		text(r.ok ? `已终止「${record.job.title}」（${record.job.id}）。` : `终止失败：${r.error}`),
	);
}

// ── 扩展入口 ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mySessionId: string | null = null;

	pi.registerTool({
		name: "shelljob",
		label: "后台 Shell",
		description: [
			"后台 shell 任务：提交后立即返回、不阻塞会话，完成/失败自动通知主 agent。",
			"适用长任务：构建打包、依赖安装、dev server/监听进程、批量转换、大文件下载、全量测试等。短任务（1-2 分钟内）请直接用同步 bash。",
			"操作：submit（默认，command 提交）/ list（列表）/ log（看输出尾部）/ kill（终止，杀整棵进程树）。",
			"任务落盘 ~/.pi/shelljob/，跨会话可查；宿主退出任务继续跑。",
		].join("\n"),
		promptSnippet: "后台 shell 任务：长任务提交后台立即返回，完成自动通知；短任务仍用同步 bash",
		promptGuidelines: [
			"先估时长再选工具：1-2 分钟内能结束的任务（查文件、git 操作、装个小包、单测）直接用同步 bash，不要提交后台。",
			"可能跑很久的任务（构建打包、完整依赖安装、dev server/文件监听、批量转换、大下载、全量测试）用 shelljob 提交后台，不阻塞会话。",
			"判断不了时长时宁可用后台：提交后立即返回，可继续其他工作，完成自动通知；需要结果才能继续时才用 shell_wait 阻塞等待。",
			"shell_wait 超时或被中止后任务仍在后台继续：稍后再等，或 shelljob(action:\"log\") 查看进度。",
		],
		parameters: ShelljobParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			switch (params.action ?? "submit") {
				case "submit":
					return executeSubmit(params, ctx);
				case "list":
					return executeList();
				case "log":
					return executeLog(params);
				case "kill": {
					const jobId = params.jobId?.trim() ?? "";
					return await executeKill(jobId);
				}
			}
		},
	});

	pi.registerTool({
		name: "shell_wait",
		label: "Shell Wait",
		description: [
			"阻塞等待后台 shell 任务完成：",
			"- shell_wait({jobId})：等单个任务",
			"- shell_wait({all:true})：等本会话所有运行中的任务",
			"- timeoutMs：超时后返回当前进度（默认 30 分钟）；任务在后台继续不受影响",
			"返回每个任务的最终状态与输出预览。",
		].join("\n"),
		promptSnippet: "阻塞等待后台 shell 任务结束；超时返回进度，任务继续不受影响",
		promptGuidelines: [
			"只等真正需要结果才能继续的任务；能并行推进的工作先做，等自动通知即可。",
			"超时或中止后任务仍在后台继续：稍后可再 shell_wait，或 shelljob(action:\"log\") 查看进度。",
		],
		parameters: Type.Object({
			jobId: Type.Optional(Type.String({ description: "目标任务 id（缺省且 all=false 时等本会话全部）" })),
			all: Type.Optional(Type.Boolean({ description: "等本会话所有运行中的任务" })),
			timeoutMs: Type.Optional(Type.Number({ description: "超时（毫秒），默认 1800000（30 分钟）" })),
		}),
		async execute(_id, params, signal) {
			const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
			const deadline = Date.now() + Math.max(1000, timeoutMs);
			const all = loadAllJobs();
			const ownOrOrphan = (r: ShellJobRecord): boolean => !r.job.sessionId || r.job.sessionId === mySessionId;
			const targets = params.jobId
				? all.filter((r) => r.job.id === params.jobId || r.job.id.startsWith(params.jobId!))
				: all.filter((r) => ownOrOrphan(r) && r.status.status === "running");
			if (targets.length === 0) return text("没有需要等待的后台任务。");

			while (Date.now() < deadline) {
				if (signal?.aborted) {
					const running = targets.filter((r) => !isTerminal(readStatus(r.job.id) ?? r.status));
					return text(
						`等待已中止。仍有 ${running.length} 个任务未完成（${running.map((r) => `「${r.job.title}」`).join("、")}），任务在后台继续：稍后可再 shell_wait，或 shelljob(action:"log") 查看进度。`,
					);
				}
				const done = targets.filter((r) => isTerminal(readStatus(r.job.id) ?? r.status));
				if (done.length === targets.length) {
					const lines = targets.map((r) => {
						const st = readStatus(r.job.id) ?? r.status;
						const tail = readOutputTail(r.job.id, 1);
						const preview = tail.lines[0]?.slice(0, 100) ?? "";
						return `- 「${r.job.title}」[${STATUS_LABEL(st.status)}]${st.exitCode !== undefined ? ` exit ${st.exitCode}` : ""}${preview ? `：${preview}` : ""}`;
					});
					return text(`等待完成（${targets.length} 个）：\n${lines.join("\n")}\n\n查看完整日志：shelljob(action:"log", jobId:"<id>")。`);
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			const running = targets.filter((r) => !isTerminal(readStatus(r.job.id) ?? r.status));
			return text(
				`等待超时（${Math.round(timeoutMs / 1000)}s），仍有 ${running.length} 个任务运行中（${running.map((r) => `「${r.job.title}」`).join("、")}）。\n任务在后台继续：稍后可再 shell_wait，或 shelljob(action:"log") 查看进度。`,
			);
		},
	});

	// 命令（手动操作）
	pi.registerCommand("shelljobs", {
		description: "列出所有后台 shell 任务及状态",
		handler: async (_args, ctx) => {
			const records = loadAllJobs();
			if (records.length === 0) {
				ctx.ui.notify("暂无后台任务。", "info");
				return;
			}
			const running = records.filter((r) => r.status.status === "running").length;
			const head = records
				.slice(0, 12)
				.map((r) => `[${STATUS_LABEL(r.status.status)}] ${r.job.id} 「${r.job.title}」`)
				.join("\n");
			ctx.ui.notify(`后台任务共 ${records.length} 个（运行中 ${running}）：\n${head}${records.length > 12 ? "\n…" : ""}`, "info");
		},
	});
	pi.registerCommand("shelljob-kill", {
		description: "终止后台 shell 任务",
		handler: async (args, ctx) => {
			const jobId = args.trim();
			if (!jobId) {
				ctx.ui.notify("用法：/shelljob-kill <jobId>", "warning");
				return;
			}
			const r = await executeKill(jobId);
			ctx.ui.notify(r.content[0]?.type === "text" ? r.content[0].text : "", "info");
		},
	});

	// 会话初始化（每个会话实例各执行一次；mySessionId 是入口闭包变量，各实例独立）
	pi.on("session_start", (_event, ctx) => {
		const sessionId = safeSessionId(ctx);
		mySessionId = sessionId;
		if (sessionId) {
			// 同一 sessionId 重入（重开/恢复会话）时先释放旧 pipe，避免旧 Notifier 的 5s 定时器泄漏
			sessionPipes.get(sessionId)?.notifier.dispose();
			sessionPipes.delete(sessionId);
			const sendMessage = (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
				pi.sendMessage(message, { triggerTurn: true });
			};
			const pipe: SessionPipe = { notifier: new Notifier(sessionId, sendMessage) };
			pipe.notifier.start();
			sessionPipes.set(sessionId, pipe);
		}
		initRunner({ maxLogBytes: maxLogBytes(), settle });
		if (!initialized) {
			initialized = true;
			// 进程级监控：接管宿主重启遗留的 running 任务（僵尸定终态 + 超时兜底）
			startMonitorLoop();
		}
		// 本会话历史遗留补发：宿主重启/会话重开后，补发属于本会话的未通知终态任务
		if (sessionId) {
			const pipe = sessionPipes.get(sessionId);
			if (pipe) {
				for (const record of loadAllJobs()) {
					if (record.job.sessionId !== sessionId) continue;
					if (!isTerminal(record.status) || record.status.notified) continue;
					pipe.notifier.queue(record);
				}
			}
		}
	});

	// 会话销毁：只注销本会话的管道；后台任务不取消（后台运行需求）
	pi.on("session_shutdown", () => {
		if (mySessionId) {
			sessionPipes.get(mySessionId)?.notifier.dispose();
			sessionPipes.delete(mySessionId);
		}
		mySessionId = null;
	});
}
