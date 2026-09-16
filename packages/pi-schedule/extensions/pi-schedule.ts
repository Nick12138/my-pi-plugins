/**
 * pi-schedule 扩展入口。
 *
 * 职责：
 * 1. 注册 `schedule` 工具（agent 可创建/控制定时任务）
 * 2. 进程级单例：调度器 + HTTP 控制面（一个宿主进程只起一份）
 * 3. 每会话投递管道：执行完成时把通知送进最近活跃会话
 *
 * 重要：一个宿主进程会承载多个会话，且 pi 用 `jiti(moduleCache:false)` 加载扩展
 * （cwd 变化即重新 import）——所以**所有跨会话状态必须挂在 globalThis**，
 * 模块级变量会随模块实例分裂，导致通知永远送不到后来的会话。
 *
 * 边界：PiAbyss 关闭后本进程不在，定时任务自然失效（符合既定需求）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerScheduleTool } from "../src/tool.ts";
import { getScheduler, type Scheduler } from "../src/scheduler.ts";
import { startHttpServer, resolvePort } from "../src/http.ts";
import { appendNotify, paths } from "../src/store.ts";
import { DEFAULTS, TICK_ENV, type RunRecord } from "../src/types.ts";

const NOTIFY_TYPE = "pi-schedule";
const RUNTIME_KEY = Symbol.for("pi-schedule.runtime");

interface SessionPipe {
	sessionId: string;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
}

interface ScheduleRuntime {
	scheduler: Scheduler;
	/** 同步返回的期望端口（真实端口在 httpReady 后写入 httpPort）。 */
	configuredPort: number;
	httpPort: number;
	httpError: string | null;
	startedAt: string;
	/** 每会话投递管道（挂 globalThis，避免模块实例分裂）。 */
	pipes: Map<string, SessionPipe>;
	lastActiveSessionId: string | null;
}

function resolveTickMs(): number {
	const raw = process.env[TICK_ENV]?.trim();
	if (!raw) return DEFAULTS.tickMs;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULTS.tickMs;
	return Math.min(parsed, 60 * 60 * 1000);
}

function runtimeStore(): Record<symbol, ScheduleRuntime | undefined> {
	return globalThis as unknown as Record<symbol, ScheduleRuntime | undefined>;
}

/** 进程级单例（globalThis）：调度器只起一份，管道跨模块实例共享。 */
function ensureRuntime(): ScheduleRuntime {
	const store = runtimeStore();
	const existing = store[RUNTIME_KEY];
	if (existing) return existing;

	const runtime: ScheduleRuntime = {
		scheduler: getScheduler({
			tickMs: resolveTickMs(),
			maxConcurrent: DEFAULTS.maxConcurrentRuns,
			onRunFinished: (record) => deliverNotification(runtime, record),
		}),
		configuredPort: resolvePort(),
		httpPort: 0,
		httpError: null,
		startedAt: new Date().toISOString(),
		pipes: new Map(),
		lastActiveSessionId: null,
	};
	// 先挂上再启动，保证 onRunFinished 闭包能拿到同一个 runtime
	store[RUNTIME_KEY] = runtime;
	runtime.scheduler.start();

	// 监听失败必须显式报错：不能打印一个并不存在的控制面地址
	void startHttpServer(runtime.scheduler, runtime.configuredPort)
		.then((port) => {
			runtime.httpPort = port;
			runtime.httpError = null;
			console.error(
				`[pi-schedule] 已启动：数据目录 ${paths().root}，控制面 http://127.0.0.1:${port}，tick ${resolveTickMs()}ms`,
			);
		})
		.catch((error: unknown) => {
			runtime.httpError = error instanceof Error ? error.message : String(error);
			console.error(
				`[pi-schedule] 调度器已启动，但 HTTP 控制面启动失败（端口 ${runtime.configuredPort}）：${runtime.httpError}。` +
					`面板将无法通过 HTTP 控制任务；数据仍正常落盘于 ${paths().root}`,
			);
		});

	return runtime;
}

/** 把一次执行终态通知到「最近活跃会话」+ 通知队列（面板消费）。 */
function deliverNotification(runtime: ScheduleRuntime, record: RunRecord): void {
	const statusText =
		record.status === "ok" ? "完成" : record.status === "timeout" ? "超时" : record.status === "aborted" ? "已中止" : "失败";
	const preview = record.error ?? record.summary ?? "";
	const content = [
		`【定时任务】「${record.jobName}」${statusText}（${record.status}）`,
		preview ? `\n${preview.slice(0, 800)}` : "",
		`\nrunId=${record.runId} · 查看历史：schedule(action:"history", runId:"${record.runId}")`,
	].join("");

	// 通知队列：唯一写入点（runner 不再写，避免重复入队）。
	// 所有终态都入队：面板自行决定弹什么（横幅/系统通知/TG）。
	appendNotify({
		at: record.finishedAt ?? new Date().toISOString(),
		jobId: record.jobId,
		jobName: record.jobName,
		runId: record.runId,
		status: record.status,
		level: record.status === "ok" ? "info" : "error",
		title: `定时任务「${record.jobName}」${statusText}`,
		message: preview.slice(0, 500),
	});

	// 会话内消息只发「值得打断人」的：失败类，或用户主动触发的（run_now/reply）。
	// 原因：custom_message 会进入 LLM 上下文，高频成功轮询必须保持安静。
	const userInitiated = record.trigger === "manual" || record.trigger === "reply";
	const shouldSurfaceInSession = record.status !== "ok" || userInitiated;
	if (!shouldSurfaceInSession) return;

	const pipe =
		(runtime.lastActiveSessionId ? runtime.pipes.get(runtime.lastActiveSessionId) : undefined) ??
		[...runtime.pipes.values()][runtime.pipes.size - 1];
	if (!pipe) return; // 宿主内暂无会话：通知已在队列里，等面板消费

	try {
		pipe.pi.sendMessage?.(
			{
				customType: NOTIFY_TYPE,
				content,
				display: true,
				details: { runId: record.runId, jobId: record.jobId, status: record.status },
			},
			{ triggerTurn: false },
		);
	} catch (error) {
		console.error(`[pi-schedule] 会话通知失败：${error instanceof Error ? error.message : String(error)}`);
	}

	if (pipe.ctx?.hasUI) {
		try {
			pipe.ctx.ui.notify(content, record.status === "ok" ? "info" : "error");
		} catch {
			/* UI 通知非关键 */
		}
	}
}

export default function piScheduleExtension(pi: ExtensionAPI): void {
	const runtime = ensureRuntime();
	registerScheduleTool(pi, runtime.scheduler);

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		runtime.pipes.set(sessionId, { sessionId, pi, ctx });
		runtime.lastActiveSessionId = sessionId;
		// 会话启动时补跑一次（覆盖该会话此前错过的窗口）
		void runtime.scheduler.tick("session_start").catch(() => undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		runtime.pipes.delete(sessionId);
		if (runtime.lastActiveSessionId === sessionId) {
			runtime.lastActiveSessionId = [...runtime.pipes.keys()].pop() ?? null;
		}
	});
}
