/**
 * pi-subagent：Windows 专用子代理运行时。
 *
 * - 3 角色：scout / worker / reviewer（markdown agent，不限制工具，靠 system prompt 区分）
 * - 并行（可配上限）+ 队列排队（FIFO pending）
 * - 停止/暂停/继续/恢复（taskkill + --session-id 续跑），失败自动重试（A+B）
 * - 后台运行：子进程 detached 新进程组，主 pi 退出不影响；重启后接管 + 补发回调
 * - 回调：完成/失败/停止时 sendMessage(customType) 通知主 agent（投递确认 + 合并批处理 + 自动重试）
 * - 全量落盘：task/status/events.jsonl（原始 NDJSON，含 thinking/toolCall）/result/session
 * - HTTP API（127.0.0.1）供 PiDeck 面板查看与停止
 */
import { randomUUID } from "node:crypto";
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scheduler } from "../src/scheduler.ts";
import { isProcessAlive } from "../src/runner.ts";
import { loadRun, loadAllRuns, readResult, readStatus, writeStatus, writeTask } from "../src/store.ts";
import { mergeWorktree, worktreeExists } from "../src/worktree.ts";
import { startHttpServer } from "../src/http.ts";
import { registerSupervisorTool, startSupervisorPolling } from "../src/supervisor-channel.ts";
import { channelDir, ensureSteerDirs, steerRequestPath, writeAtomicJson, type SteerRequest } from "../src/supervisor-protocol.ts";
import { Notifier, enqueueUnnotified, type NotifyMessage } from "../src/notifier.ts";
import type { RunRecord, RunTask } from "../src/types.ts";
import { DEFAULT_HTTP_PORT, DEFAULT_RETRY, MAX_RESUME_COUNT, STATUS_LABEL } from "../src/types.ts";

const AGENTS = ["scout", "worker", "reviewer"] as const;
type AgentName = (typeof AGENTS)[number];
const AGENT_DESC: Record<AgentName, string> = {
	scout: "只读探索：摸清代码库/问题范围，输出压缩上下文摘要",
	worker: "执行实现：改代码、跑验证，完成后列出改动清单",
	reviewer: "只读审查：正确性/测试/安全/简洁性审查报告",
};

// ── 会话注册表（进程级，按 sessionId 路由）─────────────────
// 一个宿主进程可能同时承载多个会话（如 PiDeck 的 active + background +
// 空闲热缓存），且每个新会话都会重新执行本扩展入口。因此严禁把“发起会话
// 身份/通知目标”存放在模块级变量或 process.env（会被后续 session_start
// 覆盖，导致通知投错会话：幽灵会话 bug）。正确姿势：
// - 每个会话实例在 session_start 时把自己的投递管道登记进 sessionPipes；
// - run 归属在 spawn 点（工具 execute 的 ctx）确定并固化进 task；
// - 终态通知由 routeSettled 按 task.sessionId 精准路由回发起会话。
interface SessionPipe {
	/** 向本会话发自定义消息并触发 turn（绑定本会话实例的 pi） */
	sendMessage: (message: NotifyMessage) => void;
	notifier: Notifier;
}
const sessionPipes = new Map<string, SessionPipe>();
let initialized = false;

// ── 工具参数 schema ──────────────────────────────────────────

const Action = StringEnum(["spawn", "list", "stop", "pause", "continue", "resume", "result", "merge", "steer"] as const, {
	description: "操作类型，默认 spawn",
	default: "spawn",
});

const SpawnItem = Type.Object({
	agent: Type.String({ description: "角色：scout / worker / reviewer" }),
	task: Type.String({ description: "任务描述（自包含：目标+约束+预期输出）" }),
	title: Type.Optional(Type.String({ description: "会话标题（显示用）" })),
	model: Type.Optional(Type.String({ description: "模型覆盖，如 openai/gpt-5；缺省继承主 agent 或环境配置" })),
	thinking: Type.Optional(Type.String({ description: "thinking 级别覆盖" })),
});

const SubagentParams = Type.Object({
	action: Type.Optional(Action),
	runId: Type.Optional(Type.String({ description: "目标 run id（stop/pause/continue/resume/result/merge/steer 用）" })),
	agent: Type.Optional(Type.String({ description: "角色（spawn 单任务用）" })),
	task: Type.Optional(Type.String({ description: "任务（spawn 单任务用）" })),
	title: Type.Optional(Type.String({ description: "会话标题" })),
	model: Type.Optional(Type.String({ description: "模型覆盖" })),
	thinking: Type.Optional(Type.String({ description: "thinking 级别覆盖" })),
	cwd: Type.Optional(Type.String({ description: "子代理工作目录，默认主 agent 目录" })),
	worktree: Type.Optional(Type.Boolean({ description: "在 git worktree 隔离目录运行（并行写文件安全），完成后用 merge 合并" })),
	retry: Type.Optional(Type.Number({ description: "失败自动重试次数（0-3），默认取配置" })),
	fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "模型回退列表：主模型失败时依次尝试" })),
	maxRuntimeMs: Type.Optional(Type.Number({ description: "运行总超时（毫秒），超时自动 kill" })),
	turnBudget: Type.Optional(Type.Number({ description: "回合数上限，超出自动 stop" })),
	toolTimeoutMs: Type.Optional(Type.Number({ description: "单工具调用超时（毫秒），0=不限制" })),
	message: Type.Optional(Type.String({ description: "steer 时发送给运行中子代理的引导消息" })),
	mode: Type.Optional(StringEnum(["steer", "follow_up", "auto"] as const, { description: "steer 投递模式：steer=中断当前执行投递；follow_up=回合边界投递；auto=自动", default: "steer" })),
	tasks: Type.Optional(Type.Array(SpawnItem, { description: "一次提交多个任务（自动排队，≤并发上限同时运行）" })),
});

type SubagentParamsT = Static<typeof SubagentParams>;
type SpawnItemT = Static<typeof SpawnItem>;

// ── 工具返回 helper ──────────────────────────────────────────

function text(content: string, details: unknown = undefined): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details };
}

/** 状态信息里的操作者标注：用户/主 agent/系统/未知 */
function operatorLabel(operator: string | undefined): string {
	switch (operator) {
		case "user":
			return "（用户操作）";
		case "agent":
			return "（主 agent 操作）";
		case "system":
			return "（系统/异常）";
		default:
			return "";
	}
}

/** 用户在等待结果时看到停止/暂停且是用户自己操作的：要求主 agent 先询问用户，不要自动恢复 */
function userIntervenedHint(run: RunRecord): string {
	if (run.status.operator !== "user") return "";
	if (run.status.status === "stopped" || run.status.status === "paused") {
		return `\n注意：该任务由用户手动${run.status.status === "stopped" ? "停止" : "暂停"}，请先向用户确认是否需要继续，不要自行恢复或重试。`;
	}
	return "";
}

// ── 模型解析 ─────────────────────────────────────────────────

function resolveModelFor(task: RunTask, ctx: ExtensionContext): { model?: string; thinking?: string } {
	// 优先级：任务显式指定 > 环境配置 > 继承发起会话（ctx）的模型。
	// 在 spawn 提交点解析一次并固化进 task：多会话宿主下不能在调度/重试时
	// 动态读“当前会话”，否则可能继承到另一个会话的模型。
	if (task.model) return { model: task.model, thinking: task.thinking };
	const configured = process.env.SUBAGENT_DEFAULT_MODEL;
	if (configured && configured !== "inherit") {
		return { model: configured, thinking: task.thinking };
	}
	if (ctx?.model) {
		return {
			model: `${ctx.model.provider}/${ctx.model.id}`,
			thinking: task.thinking ?? ctx.thinkingLevel,
		};
	}
	return { thinking: task.thinking };
}

// ── 回调 ─────────────────────────────────────────────────────

/** run 终态通知路由：按 task.sessionId 送回发起会话。
 * 发起会话不在线（已关闭/未打开）时不唤醒其他会话：状态已落盘（HTTP 面板、
 * subagent list 可见），标记 notified 丢弃；会话重开时 session_start 会按
 * sessionId 补发未通知的历史终态。 */
function routeSettled(run: RunRecord): void {
	const pipe = run.task.sessionId ? sessionPipes.get(run.task.sessionId) : undefined;
	if (pipe) {
		pipe.notifier.queue(run);
		return;
	}
	const st = readStatus(run.task.id);
	if (st) writeStatus(run.task.id, { ...st, notified: true });
}

// ── 工具 execute ─────────────────────────────────────────────

function newRunId(): string {
	return `run_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

/** 从扩展上下文安全取当前会话 id（拿不到返回 null，多会话宿主下每个 ctx 绑定各自会话） */
function safeSessionId(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionId() ?? null;
	} catch {
		return null;
	}
}

function makeTask(params: SubagentParamsT, item: SpawnItemT, cwd: string, sessionId: string | undefined): RunTask {
	const agent = item.agent as AgentName;
	const title = (item.title ?? params.title)?.trim() || `${agent}: ${item.task.slice(0, 30)}`;
	const retryRaw = params.retry ?? process.env.SUBAGENT_RETRY ?? DEFAULT_RETRY;
	const retry = Math.max(0, Math.min(3, Number(retryRaw) || DEFAULT_RETRY));
	// 回退模型列表：任务参数优先，其次全局配置 SUBAGENT_FALLBACK_MODELS（逗号分隔）
	const fallbackRaw = params.fallbackModels?.length
		? params.fallbackModels
		: process.env.SUBAGENT_FALLBACK_MODELS?.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	return {
		id: newRunId(),
		title: title.slice(0, 120),
		agent,
		task: item.task,
		model: item.model ?? params.model,
		thinking: item.thinking ?? params.thinking,
		cwd,
		worktree: params.worktree === true,
		retry,
		...(fallbackRaw?.length ? { fallbackModels: fallbackRaw } : {}),
		...(params.maxRuntimeMs ? { maxRuntimeMs: params.maxRuntimeMs } : {}),
		...(params.turnBudget ? { turnBudget: params.turnBudget } : {}),
		...(params.toolTimeoutMs ? { toolTimeoutMs: params.toolTimeoutMs } : {}),
		// 记录发起会话：通知路由/面板过滤/子进程 supervisor 归属都以它为准。
		// 取自本次工具调用的 ctx（spawn 点），绝不读进程级 env（多会话宿主下会被
		// 其他会话的 session_start 覆盖，导致归属污染）。
		sessionId,
		createdAt: Date.now(),
		parentCwd: cwd,
	};
}

async function executeSpawn(params: SubagentParamsT, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
	const cwd = params.cwd ?? ctx.cwd;
	// 防徊：未绑定 workspace 的宿主（如 PiDeck prewarm/shared host）里 ctx.cwd 可能为空，
	// 此时子 pi 进程会退化继承 host 进程自身 cwd（dev 下是 pi-host 包目录），必须显式拒绝。
	if (!cwd || !String(cwd).trim()) {
		return text("spawn 失败：无法确定工作目录（ctx.cwd 为空且未传 params.cwd）。请显式传 cwd。");
	}
	const sessionId = safeSessionId(ctx) ?? undefined;
	const tasks: SpawnItemT[] = [];
	if (params.tasks && params.tasks.length > 0) {
		tasks.push(...params.tasks);
	} else if (params.agent && params.task) {
		tasks.push({ agent: params.agent, task: params.task, title: params.title, model: params.model, thinking: params.thinking });
	} else {
		return text("spawn 需要 agent+task（单任务）或 tasks 数组（多任务）。");
	}

	for (const t of tasks) {
		if (!AGENTS.includes(t.agent as AgentName)) {
			return text(
				`未知角色 "${t.agent}"。可用角色：${AGENTS.join(" / ")}\n${AGENTS.map((a) => `- ${a}：${AGENT_DESC[a]}`).join("\n")}`,
			);
		}
		if (!t.task.trim()) return text("任务描述不能为空。");
	}

	const runIds: string[] = [];
	for (const t of tasks) {
		const task = makeTask(params, t, cwd, sessionId);
		// spawn 点解析继承模型并固化（resolveModelFor 只在此时读取发起会话的模型）
		const resolved = resolveModelFor(task, ctx);
		task.model = resolved.model ?? task.model;
		task.thinking = resolved.thinking ?? task.thinking;
		await scheduler.schedule(task);
		runIds.push(task.id);
	}
	const max = scheduler.deps.maxConcurrency;
	return text(
		`已提交 ${runIds.length} 个子代理任务（并发上限 ${max}，超出的自动排队）：\n${runIds.map((id) => `- ${id}`).join("\n")}\n\n完成/失败时会自动通知主 agent，无需等待。查看列表：subagent(action:"list")。`,
		{ runIds, maxConcurrency: max },
	);
}

function executeList(): AgentToolResult<unknown> {
	const runs = loadAllRuns();
	if (runs.length === 0) return text("暂无子代理任务。");
	const lines = runs.map((r) => {
		const { task, status } = r;
		const dur = status.startedAt ? `${Math.round((Date.now() - status.startedAt) / 1000)}s` : "-";
		const model = r.result?.model ?? task.model ?? "继承";
		const who = operatorLabel(status.operator);
		return `- ${task.id}  [${STATUS_LABEL[status.status]}${who}]  「${task.title}」  ${task.agent}  ${model}  ${dur}`;
	});
	const running = runs.filter((r) => r.status.status === "running").length;
	return text(`子代理列表（共 ${runs.length} 个，运行中 ${running}）：\n${lines.join("\n")}`);
}

async function executeControl(
	action: string,
	runId: string | undefined,
	params: SubagentParamsT = {},
): Promise<AgentToolResult<unknown>> {
	if (!runId) return text("缺少 runId。");
	const run = loadRun(runId);
	if (!run) return text(`run ${runId} 不存在。`);

	switch (action) {
		case "stop": {
			const r = await scheduler.stop(runId, "agent");
			return text(r.ok ? `已停止「${run.task.title}」（主 agent 操作）。` : `停止失败：${r.error}`);
		}
		case "pause": {
			const r = await scheduler.pause(runId, "agent");
			return text(r.ok ? `已暂停「${run.task.title}」（主 agent 操作）。可继续或停止。` : `暂停失败：${r.error}`);
		}
		case "continue": {
			const r = await scheduler.continueRun(runId, "agent");
			return text(r.ok ? `已继续「${run.task.title}」（主 agent 操作）。` : `继续失败：${r.error}`);
		}
		case "resume": {
			const r = await scheduler.resume(runId, { model: params.model }, "agent");
			return text(
				r.ok
					? `已恢复「${run.task.title}」，从断点继续（第 ${run.status.resumeCount + 1}/${MAX_RESUME_COUNT} 次）（主 agent 操作）。`
					: `恢复失败：${r.error}`,
			);
		}
		case "result": {
			const result = readResult(runId);
			const body = result
				? `「${run.task.title}」输出：\n\n${result.output || "(无输出)"}\n\n用法：${result.usage.turns} turns · ↑${result.usage.input} ↓${result.usage.output} · $${result.usage.cost.toFixed(4)}${result.model ? ` · ${result.model}` : ""}${result.errorMessage ? `\n错误：${result.errorMessage}` : ""}`
				: `run ${runId} 尚未产生结果（状态：${STATUS_LABEL[run.status.status]}${operatorLabel(run.status.operator)}）。`;
			return text(body);
		}
		case "merge": {
			const task = run.task;
			if (!task.worktreePath) return text("该 run 未使用 worktree，无需合并。");
			if (!worktreeExists(task.worktreePath)) return text("worktree 已不存在（可能已合并）。");
			const r = await mergeWorktree(task.parentCwd ?? task.cwd, runId, task.worktreePath);
			if (r.ok) {
				task.worktreePath = undefined;
				writeTask(task);
			}
			return text(r.ok ? `合并成功：${r.output}` : `合并失败：${r.output}`);
		}
		case "steer": {
			const task = run.task;
			const message = params.message?.trim();
			if (!message) return text("steer 需要 message（给运行中子代理的引导消息）。");
			if (run.status.status !== "running" && run.status.status !== "paused") {
				return text(`run ${runId} 当前状态 ${STATUS_LABEL[run.status.status]}，无法引导。`);
			}
			const steerDir = channelDir(task.id, task.agent);
			ensureSteerDirs(steerDir);
			const request: SteerRequest = {
				type: "subagent.steer.request",
				id: randomUUID(),
				createdAt: Date.now(),
				message,
				mode: params.mode ?? "steer",
				runId: task.id,
				agent: task.agent,
				childIndex: 0,
			};
			try {
				writeAtomicJson(steerRequestPath(steerDir, request.id), request);
			} catch (error) {
				return text(`引导失败：${error instanceof Error ? error.message : String(error)}`);
			}
			return text(
				`已向「${task.title}」发送引导消息（${request.id}）。\n内容：${message}\n子代理将在${params.mode === "follow_up" ? "回合边界" : "下一安全点"}收到。`,
			);
		}
		default:
			return text(`未知操作 ${action}`);
	}
}

// ── 扩展入口 ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// 子代理进程内不加载本扩展自身（配合 --exclude-tools subagent 双保险，
	// 避免子进程里重复注册工具、HTTP 端口冲突、restoreFromDisk 干扰）
	if (process.env.PI_SUBAGENT_DEPTH === "1") return;

	// 本扩展实例绑定的会话 id。入口函数每个会话实例调用一次，此变量是
	// 入口闭包内的局部状态，各实例独立，互不覆盖；工具 execute 通过闭包
	// 引用它拿到“正在调用的会话”。
	let mySessionId: string | null = null;

	// supervisor 工具必须在扩展加载阶段注册（与 subagent 同时机），
	// 否则会话工具列表快照不会包含它（session_start 里注册无法同步到已建会话）。
	// 待回复请求按归属会话过滤：本会话只能看到/回复自己发起的请求。
	registerSupervisorTool(pi, () => mySessionId ?? undefined);

	// subagent_wait：阻塞等待子代理完成（与 subagent 工具同时机注册）
	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: [
			"阻塞等待子代理任务完成：",
			"- subagent_wait({runId:<id>})：等单个 run 完成",
			"- subagent_wait({all:true})：等当前所有运行中的 run 完成",
			"- timeoutMs：超时后返回当前进度（默认 30 分钟）；run 在后台继续不受影响",
			"返回每个目标 run 的最终状态与输出预览。",
		].join("\n"),
		promptSnippet: "阻塞等待子代理 run 结束；超时返回进度，后台继续不受影响",
		promptGuidelines: [
			"subagent_wait({all:true}) 阻塞等本会话所有 pending/running run 完成；传 runId 只等指定 run。",
			"超时或被中断后 run 仍在后台继续：稍后再 subagent_wait，或用 subagent(action:\"list\") 查看状态。",
		],
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "目标 run id（缺省且 all=false 时等全部）" })),
			all: Type.Optional(Type.Boolean({ description: "等所有运行中的 run 完成" })),
			timeoutMs: Type.Optional(Type.Number({ description: "超时（毫秒），默认 1800000（30 分钟）" })),
		}),
		async execute(_id, params, signal) {
			const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
			const deadline = Date.now() + Math.max(1000, timeoutMs);
			const runs = loadAllRuns();
			// all 模式只等本会话发起的 run（无 sessionId 的历史孤儿也算进来，
			// 避免多会话宿主下等到其他会话的任务）；显式 runId 不限（跨会话接管语义）。
			const ownOrOrphan = (r: RunRecord): boolean => !r.task.sessionId || r.task.sessionId === mySessionId;
			const targets = params.runId
				? runs.filter((r) => r.task.id === params.runId || r.task.id.startsWith(params.runId!))
				: runs.filter((r) => ownOrOrphan(r) && (r.status.status === "running" || r.status.status === "pending" || r.status.status === "paused"));
			if (targets.length === 0) return text("没有需要等待的 run。");

			const isTerminal = (s: { status: string }): boolean =>
				s.status === "completed" || s.status === "failed" || s.status === "stopped" || s.status === "interrupted";

			// 僵尸兜底：status 仍 running 但子进程已消失的 run 视为中断（exit 回调可能因
			// 宿主进程崩溃/重启而丢失）。每轮最多探测一次，避免频繁拉起 tasklist。
			const zombieCheckedAt = new Map<string, number>();
			const markZombieInterrupted = async (): Promise<void> => {
				for (const r of targets) {
					const st = readStatus(r.task.id);
					if (!st || isTerminal(st) || st.status !== "running" || !st.pid) continue;
					const last = zombieCheckedAt.get(r.task.id) ?? 0;
					if (Date.now() - last < 3000) continue;
					zombieCheckedAt.set(r.task.id, Date.now());
					if (!(await isProcessAlive(st.pid))) {
						writeStatus(r.task.id, {
							...st,
							status: "interrupted",
							finishedAt: Date.now(),
							pid: undefined,
							stopReason: "zombie",
						});
					}
				}
			};

			while (Date.now() < deadline) {
				// 用户中止（abort）：立即返回当前进度，避免阻塞主 agent 无法停止
				if (signal?.aborted) {
					const running = targets.filter((r) => !isTerminal(readStatus(r.task.id) ?? r.status));
					return text(
						`等待已中断。仍有 ${running.length} 个 run 未完成（${running.map((r) => r.task.title).join("、")}），可稍后用 subagent_wait 再等，或 subagent(action:"list") 查看。`,
					);
				}
				await markZombieInterrupted();
				const done = targets.filter((r) => isTerminal(readStatus(r.task.id) ?? r.status));
				if (done.length === targets.length) {
					const lines = targets.map((r) => {
						const st = readStatus(r.task.id) ?? r.status;
						const res = readResult(r.task.id);
						const preview = res?.output?.split("\n")[0]?.slice(0, 100) ?? "";
						const who = operatorLabel(st.operator);
						return `- 「${r.task.title}」[${STATUS_LABEL[st.status]}${who}]${preview ? `：${preview}` : ""}`;
					});
					const hint = targets
						.map((r) => {
							const st = readStatus(r.task.id) ?? r.status;
							return userIntervenedHint({ task: r.task, status: st, result: readResult(r.task.id) ?? undefined });
						})
						.filter(Boolean)
						.join("");
					return text(`等待完成（${targets.length} 个）：\n${lines.join("\n")}${hint}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			const running = targets.filter((r) => !isTerminal(readStatus(r.task.id) ?? r.status));
			return text(
				`等待超时（${Math.round(timeoutMs / 1000)}s），仍有 ${running.length} 个 run 运行中。\n可用 subagent(action:"list") 查看，或稍后 subagent_wait 再等。`,
			);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"把任务委托给独立子代理（scout 探索 / worker 执行 / reviewer 审查），子代理在独立 pi 进程、独立上下文中运行。",
			"支持后台运行：提交后不阻塞主 agent，完成/失败会自动通知。支持队列排队（并发上限可配）、失败自动重试、worktree 隔离、手动控制（stop/pause/continue/resume）。",
			"角色：",
			...AGENTS.map((a) => `- ${a}：${AGENT_DESC[a]}`),
			"用法：subagent(agent, task) 单任务；subagent(tasks:[...]) 多任务；subagent(action, runId) 控制/查看。",
		].join("\n"),
		promptSnippet: "委托独立子代理（scout/worker/reviewer）：后台运行、队列排队、worktree 隔离、完成自动通知",
		promptGuidelines: [
			"会撑爆主上下文的自包含工作交给子代理：scout = 只读探索代码库/问题范围，worker = 实现并跑验证，reviewer = 只读审查改动。",
			"多个相互独立的任务用一次 tasks:[...] 批量提交——自动排队并按并发上限同时运行；仅当后续任务依赖前面结果时才逐个 spawn。",
			"并行 worker 会写同一仓库的文件时设 worktree:true，完成后用 subagent(action:\"merge\", runId) 合并回主分支。",
			"spawn 立即返回（后台运行）：用 subagent_wait({all:true}) 阻塞等完成，或依赖完成后的自动通知。",
			"任务描述必须自包含（目标 + 约束 + 预期输出）：子代理看不到你的会话内容。",
			"需要改正在运行的子代理方向时用 subagent(action:\"steer\", runId, message) 引导，不要直接 stop；stop/pause/continue/resume 留给手动控制。",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const action = params.action ?? "spawn";
			switch (action) {
				case "spawn":
					return await executeSpawn(params, ctx);
				case "list":
					return executeList();
				default:
					return await executeControl(action, params.runId, params);
			}
		},
	});

	// 命令（手动操作）
	pi.registerCommand("subagents", {
		description: "列出所有子代理任务及状态",
		handler: async (_args, ctx) => {
			const runs = loadAllRuns();
			if (runs.length === 0) {
				ctx.ui.notify("暂无子代理任务。", "info");
				return;
			}
			const running = runs.filter((r) => r.status.status === "running").length;
			const head = runs
				.slice(0, 12)
				.map((r) => `[${STATUS_LABEL[r.status.status]}] ${r.task.id} 「${r.task.title}」 ${r.task.agent}`)
				.join("\n");
			ctx.ui.notify(`子代理共 ${runs.length} 个（运行中 ${running}）：\n${head}${runs.length > 12 ? "\n…" : ""}`, "info");
		},
	});
	for (const action of ["stop", "pause", "continue", "resume", "result", "merge"] as const) {
		pi.registerCommand(`subagent-${action}`, {
			description: `子代理操作：${action}`,
			handler: async (args, ctx) => {
				const runId = args.trim();
				if (!runId) {
					ctx.ui.notify(`用法：/subagent-${action} <runId>`, "warning");
					return;
				}
				const r = await executeControl(action, runId);
				ctx.ui.notify(r.content[0]?.type === "text" ? r.content[0].text : "", "info");
			},
		});
	}

	// 会话初始化（每个会话实例各执行一次；mySessionId 是入口函数闭包变量，
	// 各实例独立，不会被其他会话的 session_start 覆盖）
	pi.on("session_start", (_event, ctx) => {
		const sessionId = safeSessionId(ctx);
		mySessionId = sessionId;
		if (sessionId) {
			// 登记本会话实例的通知管道：pi 闭包绑定本实例，routeSettled 按
			// task.sessionId 精准投递（重复 session_start，如 reload，幂等覆盖）
			const sendMessage = (message: NotifyMessage) => {
				pi.sendMessage(message, { triggerTurn: true });
			};
			const pipe: SessionPipe = {
				sendMessage,
				notifier: new Notifier(sessionId, sendMessage),
			};
			pipe.notifier.start(); // 定时 flush：投递失败（会话忙碌等）后保留队列重试
			sessionPipes.set(sessionId, pipe);
		}
		scheduler.init({
			maxConcurrency: Number(process.env.SUBAGENT_MAX_CONCURRENCY) || 10,
			projectTrusted: ctx.isProjectTrusted?.() ?? false,
			onSettled: routeSettled,
		});
		// 每次会话都接管磁盘上遗留的 running/paused run（宿主重启/崩溃兜底），
		// tick 会轮询其子进程存活状态并在进程消失后定终态
		scheduler.refreshMonitor();
		// supervisor 轮询是进程级单例：请求按 orchestratorSessionId 归属投递到
		// sessionPipes 中的发起会话，与会话切换/关闭解耦
		startSupervisorPolling({
			deliver: (request, visibleText) => {
				const pipe = sessionPipes.get(request.orchestratorSessionId);
				if (!pipe) return false; // 发起会话离线：期望回复的请求保留目录等待
				try {
					pipe.sendMessage({
						customType: "subagent_supervisor_request",
						content: visibleText,
						display: true,
						details: {
							id: request.id,
							reason: request.reason,
							expectsReply: request.expectsReply,
							runId: request.runId,
							agent: request.agent,
						},
					});
					return true;
				} catch {
					// 会话暂不可投递：请求文件保留，下一轮轮询重试
					return false;
				}
			},
		});
		if (!initialized) {
			initialized = true;
			// 接管上次宿主进程遗留的 pending/running run（重建队列/监控）；
			// 终态通知不在此时补发（归属发起会话，由各会话自己拉取）
			void scheduler.restoreFromDisk();
			// HTTP API（PiDeck 面板）
			const port = Number(process.env.SUBAGENT_HTTP_PORT) || DEFAULT_HTTP_PORT;
			startHttpServer(port);
			console.log(`[pi-subagent] HTTP API 已启动: http://127.0.0.1:${port}`);
		}
		// 本会话历史遗留补发：宿主重启/会话重开后，拉取属于本会话的未通知终态 run
		if (sessionId) {
			const pipe = sessionPipes.get(sessionId);
			if (pipe) enqueueUnnotified(pipe.notifier, loadAllRuns().filter((r) => r.task.sessionId === sessionId));
		}
	});

	// 会话销毁：只注销本会话的管道；子代理进程不取消（后台运行需求），
	// 进程级 supervisor 轮询继续服务其他会话
	pi.on("session_shutdown", () => {
		if (mySessionId) {
			sessionPipes.get(mySessionId)?.notifier.dispose();
			sessionPipes.delete(mySessionId);
		}
		mySessionId = null;
	});
}
