/**
 * `schedule` 工具：让 agent 能创建/查看/控制定时任务。
 *
 * 工具只做「参数校验 + 调用服务层」，不自己实现调度逻辑；
 * 真正的执行在 Scheduler/Runner（独立会话）。
 */
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createJob,
	deleteJob,
	describeJob,
	describeJobList,
	setEnabled,
	updateJob,
	type JobPatch,
} from "./jobs.ts";
import type { Scheduler } from "./scheduler.ts";
import {
	appendLedger,
	findRun,
	getJob,
	listJobs,
	listRuns,
	paths,
	readSessionTranscript,
	toRunSummary,
} from "./store.ts";
import { assertPermissionTier } from "./permissions.ts";
import { assertTimeoutOk, ScheduleError } from "./schedule.ts";
import { LIMITS, type Job, type ModelRef, type PermissionTier, type Trigger } from "./types.ts";

const ACTIONS = [
	"create",
	"list",
	"get",
	"update",
	"cancel",
	"enable",
	"disable",
	"run_now",
	"history",
	"reply",
	"status",
] as const;

const ScheduleParams = Type.Object({
	action: StringEnum(ACTIONS, { description: "操作类型", default: "list" }),
	id: Type.Optional(Type.String({ description: "任务 id（get/update/cancel/enable/disable/run_now/history 用）" })),
	runId: Type.Optional(Type.String({ description: "执行记录 id（history/reply 用）" })),
	name: Type.Optional(Type.String({ description: "任务名（create/update）" })),
	prompt: Type.Optional(Type.String({ description: "任务内容（create/update）：自包含的指令，会作为全新会话的任务书" })),
	cwd: Type.Optional(Type.String({ description: "工作区绝对路径（create/update），默认当前目录" })),
	trigger: Type.Optional(
		StringEnum(["manual", "once", "interval", "cron"] as const, {
			description: "触发方式：manual=仅手动；once=定时一次；interval=周期；cron=表达式",
		}),
	),
	every: Type.Optional(Type.String({ description: "trigger=interval 时的周期，如 30m / 2h / 1d" })),
	cron: Type.Optional(Type.String({ description: "trigger=cron 时的 5 段表达式，如 0 9 * * 1-5" })),
	at: Type.Optional(Type.String({ description: "trigger=once 时的绝对时间（ISO，如 2026-01-01T09:00:00+08:00）" })),
	timezone: Type.Optional(Type.String({ description: "cron 的时区，如 Asia/Shanghai；缺省用系统时区" })),
	permission: Type.Optional(
		StringEnum(["read_only", "write", "full"] as const, {
			description: "权限：read_only=只读；write=可改文件不可跑命令；full=全权（含 bash）",
		}),
	),
	model: Type.Optional(Type.String({ description: "模型，格式 provider/id，可选 :thinking，如 5/deepseek-v4.1-flash:medium" })),
	missedWindow: Type.Optional(
		StringEnum(["catch_up_one", "skip"] as const, { description: "错过窗口策略，默认 catch_up_one" }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "单次执行超时（毫秒），默认 1800000" })),
	maxRuns: Type.Optional(Type.Number({ description: "投递次数上限，到达后自动停用" })),
	loadExtensions: Type.Optional(Type.Boolean({ description: "执行会话是否加载扩展/技能，默认 false" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
	enabled: Type.Optional(Type.Boolean({ description: "是否启用（update）" })),
	wait: Type.Optional(Type.Boolean({ description: "run_now 是否等待执行完成，默认 true" })),
	waitMs: Type.Optional(Type.Number({ description: "run_now 等待上限（毫秒），默认 120000" })),
	limit: Type.Optional(Type.Number({ description: "history 返回条数，默认 10" })),
	text: Type.Optional(Type.String({ description: "reply 时的追问内容" })),
});

type ScheduleParamsT = Static<typeof ScheduleParams>;

function text(content: string, details: unknown = undefined): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details };
}

/** 解析 `provider/id[:thinking]`。 */
export function parseModelRef(input: string | undefined): ModelRef | null {
	if (!input?.trim()) return null;
	const raw = input.trim();
	const [modelPart, thinking] = splitThinking(raw);
	const slash = modelPart.indexOf("/");
	if (slash <= 0 || slash === modelPart.length - 1) {
		throw new ScheduleError(`model 格式应为 provider/id[:thinking]，收到：${input}`);
	}
	return {
		provider: modelPart.slice(0, slash),
		id: modelPart.slice(slash + 1),
		...(thinking ? { thinkingLevel: thinking as ModelRef["thinkingLevel"] } : {}),
	};
}

function splitThinking(raw: string): [string, string | null] {
	const colon = raw.lastIndexOf(":");
	if (colon <= 0) return [raw, null];
	const suffix = raw.slice(colon + 1).trim();
	const known = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (!known.includes(suffix)) return [raw, null];
	return [raw.slice(0, colon), suffix];
}

function triggerFromParams(params: ScheduleParamsT, fallback?: Trigger): Trigger {
	if (!params.trigger) {
		if (fallback) return fallback;
		throw new ScheduleError("create 需要 trigger（manual / once / interval / cron）");
	}
	switch (params.trigger) {
		case "manual":
			return { type: "manual" };
		case "once": {
			if (!params.at) throw new ScheduleError("trigger=once 需要 at（ISO 时间）");
			return { type: "once", at: params.at };
		}
		case "interval": {
			if (!params.every) throw new ScheduleError("trigger=interval 需要 every（如 30m）");
			return { type: "interval", every: params.every };
		}
		case "cron": {
			if (!params.cron) throw new ScheduleError("trigger=cron 需要 cron（5 段表达式）");
			return { type: "cron", cron: params.cron, timezone: params.timezone };
		}
	}
}

function statusText(job: Job): string {
	return describeJob(job);
}

export function registerScheduleTool(pi: ExtensionAPI, scheduler: Scheduler): void {
	pi.registerTool({
		name: "schedule",
		label: "定时任务",
		description:
			"创建/查看/控制定时任务（cron / 周期 / 一次性 / 仅手动）。每次执行都在**独立会话**里跑，历史可查、可续聊。",
		promptSnippet: "schedule — create/list/run scheduled tasks (cron, interval, once, manual)",
		promptGuidelines: [
			"用户说「每天/每小时/定时/cron/提醒我/定期检查」时用 schedule 工具建任务。",
			"任务 prompt 必须自包含：执行时是全新会话，没有当前对话上下文。",
			"需要跑命令（git/npm/gh/脚本）的任务必须 permission=full；只读检索用 read_only（默认）；要改文件但不用命令用 write。",
		],
		parameters: ScheduleParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const action = params.action ?? "list";
			try {
				switch (action) {
					case "create": {
						if (!params.name || !params.prompt) throw new ScheduleError("create 需要 name 与 prompt");
						const job = createJob(
							{
								name: params.name,
								prompt: params.prompt,
								cwd: params.cwd ?? ctx.cwd,
								trigger: triggerFromParams(params),
								permission: params.permission as PermissionTier | undefined,
								model: parseModelRef(params.model),
								missedWindow: params.missedWindow,
								timeoutMs: params.timeoutMs,
								maxRuns: params.maxRuns ?? null,
								loadExtensions: params.loadExtensions,
								tags: params.tags,
								enabled: params.enabled,
							},
							{ by: "agent" },
						);
						void scheduler.tick("tick").catch(() => undefined);
						return text(`已创建定时任务：\n\n${statusText(job)}`, { job });
					}
					case "list": {
						const jobs = listJobs();
						return text(describeJobList(jobs), { jobs, activeJobs: scheduler.activeJobIds() });
					}
					case "get": {
						const job = requireJob(params.id);
						return text(statusText(job), { job });
					}
					case "update": {
						const job = requireJob(params.id);
						const patch: JobPatch = {};
						if (params.name !== undefined) patch.name = params.name;
						if (params.prompt !== undefined) patch.prompt = params.prompt;
						if (params.cwd !== undefined) patch.cwd = params.cwd;
						if (params.trigger !== undefined) patch.trigger = triggerFromParams(params, job.trigger);
						if (params.permission !== undefined) patch.permission = assertPermissionTier(params.permission);
						if (params.model !== undefined) patch.model = parseModelRef(params.model);
						if (params.missedWindow !== undefined) patch.missedWindow = params.missedWindow;
						if (params.timeoutMs !== undefined) patch.timeoutMs = assertTimeoutOk(params.timeoutMs);
						if (params.maxRuns !== undefined) patch.maxRuns = params.maxRuns;
						if (params.loadExtensions !== undefined) patch.loadExtensions = params.loadExtensions;
						if (params.tags !== undefined) patch.tags = params.tags;
						if (params.enabled !== undefined) patch.enabled = params.enabled;
						const updated = updateJob(job.id, patch, { by: "agent" });
						void scheduler.tick("tick").catch(() => undefined);
						return text(`已更新：\n\n${statusText(updated)}`, { job: updated });
					}
					case "cancel": {
						const job = requireJob(params.id);
						deleteJob(job.id, { by: "agent" });
						return text(`已删除任务「${job.name}」(${job.id})。历史文件保留；如需一并清理用 HTTP DELETE /api/jobs/${job.id}?purge=1。`, {
							removed: job.id,
						});
					}
					case "enable":
					case "disable": {
						const job = requireJob(params.id);
						const updated = setEnabled(job.id, action === "enable", { by: "agent" });
						void scheduler.tick("tick").catch(() => undefined);
						return text(`已${action === "enable" ? "启用" : "停用"}：\n\n${statusText(updated)}`, { job: updated });
					}
					case "run_now": {
						const job = requireJob(params.id);
						const wait = params.wait ?? true;
						const waitMs = Math.min(600_000, Math.max(1_000, params.waitMs ?? 120_000));
						// 覆盖参数必须校验：未知 permission 会被当成「不传白名单」= full（踩过）
						const permissionOverride = params.permission
							? assertPermissionTier(params.permission)
							: undefined;
						const timeoutOverride =
							params.timeoutMs === undefined ? undefined : assertTimeoutOk(params.timeoutMs);
						const promise = scheduler.trigger(job, {
							trigger: "manual",
							permissionOverride,
							timeoutMsOverride: timeoutOverride,
						});
						if (!wait) {
							// 真非阻塞：不要 await，否则工具调用会被整个 run 挂住
							void promise.catch(() => undefined);
							return text(
								`已触发「${job.name}」。用 schedule(action:"history", id:"${job.id}") 查看进展与结果。`,
								{ pending: true, jobId: job.id },
							);
						}
						let timer: ReturnType<typeof setTimeout> | undefined;
						const raced = await Promise.race([
							promise,
							new Promise<"timeout">((resolve) => {
								timer = setTimeout(() => resolve("timeout"), waitMs);
								timer.unref?.();
							}),
						]);
						if (timer) clearTimeout(timer);
						if (raced === "timeout") {
							return text(
								`「${job.name}」仍在执行，已超过等待上限 ${Math.round(waitMs / 1000)}s。稍后用 schedule(action:"history", id:"${job.id}") 查看结果。`,
								{ pending: true, jobId: job.id },
							);
						}
						return text(formatRunResult(raced), { run: toRunSummary(raced) });
					}
					case "history": {
						if (params.runId) {
							const record = findRun(params.runId);
							if (!record) throw new ScheduleError(`执行记录不存在：${params.runId}`);
							const entries = record.sessionPath ? readSessionTranscript(record.sessionPath, 60) : [];
							const body = entries
								.slice(-10)
								.map((entry) => `[${entry.role}] ${entry.text.slice(0, 400)}`)
								.join("\n\n");
							return text(
								`${formatRunResult(record)}\n\n—— 会话摘录 ——\n${body || "（空）"}`,
								{ run: record, entries },
							);
						}
						const job = params.id ? requireJob(params.id) : undefined;
						const limit = Math.min(LIMITS.maxHistoryRows, Math.max(1, params.limit ?? 10));
						const runs = job ? listRuns(job.id, limit) : listJobs().flatMap((j) => listRuns(j.id, limit));
						if (runs.length === 0) return text("（暂无执行历史）", { runs: [] });
						const lines = runs
							.slice(0, limit)
							.map((record) => {
								const when = record.startedAt.replace("T", " ").slice(0, 19);
								return `${record.status.padEnd(7)} ${when} ${record.jobName} (run ${record.runId})${record.error ? ` · ${record.error}` : ""}`;
							})
							.join("\n");
						return text(lines, { runs: runs.slice(0, limit).map(toRunSummary) });
					}
					case "reply": {
						if (!params.runId || !params.text) throw new ScheduleError("reply 需要 runId 与 text");
						const record = findRun(params.runId);
						if (!record) throw new ScheduleError(`执行记录不存在：${params.runId}`);
						const job = getJob(record.jobId);
						if (!job) throw new ScheduleError(`任务已被删除：${record.jobId}`);
						if (!record.sessionPath) throw new ScheduleError("该执行没有可续聊的会话文件");
						appendLedger({
							at: new Date().toISOString(),
							event: "reply",
							jobId: job.id,
							jobName: job.name,
							runId: record.runId,
							detail: "agent 发起续聊",
						});
						const next = await scheduler.trigger(job, {
							trigger: "reply",
							forkFromSessionPath: record.sessionPath,
							forkOfRunId: record.runId,
							replyText: params.text,
						});
						return text(`已在该历史基础上继续执行（新 run ${next.runId}）：\n\n${formatRunResult(next)}`, {
							run: toRunSummary(next),
						});
					}
					case "status": {
						const status = scheduler.status();
						return text(
							[
								`调度器：${status.startedAt ? `运行中（启动于 ${status.startedAt}）` : "未启动"}`,
								`tick 间隔：${status.tickMs}ms · 并发上限：${status.maxConcurrent}`,
								`正在执行：${status.activeJobs.length > 0 ? status.activeJobs.join(", ") : "无"}`,
								`数据目录：${paths().root}`,
							].join("\n"),
							status,
						);
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return text(`schedule ${action} 失败：${message}`, { error: message });
			}
		},
	});
}

function requireJob(id: string | undefined): Job {
	if (!id) throw new ScheduleError("需要 id");
	const job = getJob(id);
	if (!job) throw new ScheduleError(`任务不存在：${id}`);
	return job;
}

export function formatRunResult(record: {
	runId: string;
	jobName: string;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	summary: string;
	outputText: string;
	error: string | null;
	usage: { input: number; output: number; total: number; cost: number } | null;
	runCount?: number;
}): string {
	const duration = record.finishedAt
		? `${Math.max(0, Math.round((new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()) / 1000))}s`
		: "-";
	const usage = record.usage ? ` · tokens ${record.usage.total} · cost ${record.usage.cost}` : "";
	const head = `「${record.jobName}」${record.status}（${duration}${usage}）runId=${record.runId}`;
	if (record.error) return `${head}\n错误：${record.error}`;
	return `${head}\n${record.outputText || record.summary || "（无输出）"}`;
}

