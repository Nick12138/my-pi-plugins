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
import { loadRun, loadAllRuns, readResult, readStatus, writeStatus, writeTask } from "../src/store.ts";
import { mergeWorktree, worktreeExists } from "../src/worktree.ts";
import { startHttpServer } from "../src/http.ts";
import { createSupervisorChannel, registerSupervisorTool, visibleRequestText, type SupervisorChannel } from "../src/supervisor-channel.ts";
import { ENV_ORCHESTRATOR_SESSION_ID } from "../src/supervisor-protocol.ts";
import { Notifier, enqueueUnnotified } from "../src/notifier.ts";
import type { RunRecord, RunTask } from "../src/types.ts";
import { DEFAULT_HTTP_PORT, DEFAULT_RETRY, MAX_RESUME_COUNT, STATUS_LABEL } from "../src/types.ts";

const AGENTS = ["scout", "worker", "reviewer"] as const;
type AgentName = (typeof AGENTS)[number];
const AGENT_DESC: Record<AgentName, string> = {
	scout: "只读探索：摸清代码库/问题范围，输出压缩上下文摘要",
	worker: "执行实现：改代码、跑验证，完成后列出改动清单",
	reviewer: "只读审查：正确性/测试/安全/简洁性审查报告",
};

let currentCtx: ExtensionContext | null = null;
let initialized = false;
let supervisorChannel: SupervisorChannel | null = null;
let notifier: Notifier | null = null;

// ── 工具参数 schema ──────────────────────────────────────────

const Action = StringEnum(["spawn", "list", "stop", "pause", "continue", "resume", "result", "merge"] as const, {
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
	runId: Type.Optional(Type.String({ description: "目标 run id（stop/pause/continue/resume/result/merge 用）" })),
	agent: Type.Optional(Type.String({ description: "角色（spawn 单任务用）" })),
	task: Type.Optional(Type.String({ description: "任务（spawn 单任务用）" })),
	title: Type.Optional(Type.String({ description: "会话标题" })),
	model: Type.Optional(Type.String({ description: "模型覆盖" })),
	thinking: Type.Optional(Type.String({ description: "thinking 级别覆盖" })),
	cwd: Type.Optional(Type.String({ description: "子代理工作目录，默认主 agent 目录" })),
	worktree: Type.Optional(Type.Boolean({ description: "在 git worktree 隔离目录运行（并行写文件安全），完成后用 merge 合并" })),
	retry: Type.Optional(Type.Number({ description: "失败自动重试次数（0-3），默认取配置" })),
	tasks: Type.Optional(Type.Array(SpawnItem, { description: "一次提交多个任务（自动排队，≤并发上限同时运行）" })),
});

type SubagentParamsT = Static<typeof SubagentParams>;
type SpawnItemT = Static<typeof SpawnItem>;

// ── 工具返回 helper ──────────────────────────────────────────

function text(content: string, details: unknown = undefined): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details };
}

// ── 模型解析 ─────────────────────────────────────────────────

function resolveModelFor(task: RunTask): { model?: string; thinking?: string } {
	// 优先级：任务显式指定 > 环境配置 > 继承主 agent
	if (task.model) return { model: task.model, thinking: task.thinking };
	const configured = process.env.SUBAGENT_DEFAULT_MODEL;
	if (configured && configured !== "inherit") {
		return { model: configured, thinking: task.thinking };
	}
	const ctx = currentCtx;
	if (ctx?.model) {
		return {
			model: `${ctx.model.provider}/${ctx.model.id}`,
			thinking: task.thinking ?? ctx.thinkingLevel,
		};
	}
	return { thinking: task.thinking };
}

// ── 回调 ─────────────────────────────────────────────────────

function makeOnSettled(notifier: Notifier): (run: RunRecord) => void {
	return (run) => {
		notifier.queue(run);
	};
}

// ── 工具 execute ─────────────────────────────────────────────

function newRunId(): string {
	return `run_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

function makeTask(params: SubagentParamsT, item: SpawnItemT, cwd: string): RunTask {
	const agent = item.agent as AgentName;
	const title = (item.title ?? params.title)?.trim() || `${agent}: ${item.task.slice(0, 30)}`;
	const retryRaw = params.retry ?? process.env.SUBAGENT_RETRY ?? DEFAULT_RETRY;
	const retry = Math.max(0, Math.min(3, Number(retryRaw) || DEFAULT_RETRY));
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
		createdAt: Date.now(),
		parentCwd: cwd,
	};
}

async function executeSpawn(params: SubagentParamsT, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
	const cwd = params.cwd ?? ctx.cwd;
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
		const task = makeTask(params, t, cwd);
		await scheduler.schedule(task);
		runIds.push(task.id);
	}
	const max = scheduler.deps.maxConcurrency;
	return text(
		`已提交 ${runIds.length} 个子代理任务（并发上限 ${max}，超出的自动排队）：\n${runIds.map((id) => `- ${id}`).join("\n")}\n\n完成/失败时会自动通知主 agent，无需等待。查看列表：subagent(action:"list")。[v3]`,
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
		return `- ${task.id}  [${STATUS_LABEL[status.status]}]  「${task.title}」  ${task.agent}  ${model}  ${dur}`;
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
			const r = await scheduler.stop(runId);
			return text(r.ok ? `已停止「${run.task.title}」。` : `停止失败：${r.error}`);
		}
		case "pause": {
			const r = await scheduler.pause(runId);
			return text(r.ok ? `已暂停「${run.task.title}」。可继续或停止。` : `暂停失败：${r.error}`);
		}
		case "continue": {
			const r = await scheduler.continueRun(runId);
			return text(r.ok ? `已继续「${run.task.title}」。` : `继续失败：${r.error}`);
		}
		case "resume": {
			const r = await scheduler.resume(runId, { model: params.model });
			return text(
				r.ok
					? `已恢复「${run.task.title}」，从断点继续（第 ${run.status.resumeCount + 1}/${MAX_RESUME_COUNT} 次）。`
					: `恢复失败：${r.error}`,
			);
		}
		case "result": {
			const result = readResult(runId);
			const body = result
				? `「${run.task.title}」输出：\n\n${result.output || "(无输出)"}\n\n用法：${result.usage.turns} turns · ↑${result.usage.input} ↓${result.usage.output} · $${result.usage.cost.toFixed(4)}${result.model ? ` · ${result.model}` : ""}${result.errorMessage ? `\n错误：${result.errorMessage}` : ""}`
				: `run ${runId} 尚未产生结果（状态：${STATUS_LABEL[run.status.status]}）。`;
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
		default:
			return text(`未知操作 ${action}`);
	}
}

// ── 扩展入口 ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// 子代理进程内不加载本扩展自身（配合 --exclude-tools subagent 双保险，
	// 避免子进程里重复注册工具、HTTP 端口冲突、restoreFromDisk 干扰）
	if (process.env.PI_SUBAGENT_DEPTH === "1") return;

	// supervisor 工具必须在扩展加载阶段注册（与 subagent 同时机），
	// 否则会话工具列表快照不会包含它（session_start 里注册无法同步到已建会话）
	registerSupervisorTool(pi);

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

	// 会话初始化
	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		// 子代理 spawn 时继承该变量，用于 supervisor 请求的会话归属校验
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) process.env[ENV_ORCHESTRATOR_SESSION_ID] = sessionId;
		} catch {
			/* 拿不到会话 id 则子代理无法使用 supervisor 通道 */
		}
		// 完成通知管理器：sendMessage(customType) + 投递确认 + 合并批处理
		notifier?.dispose();
		notifier = new Notifier(pi);
		notifier.start();
		scheduler.init({
			maxConcurrency: Number(process.env.SUBAGENT_MAX_CONCURRENCY) || 10,
			resolveModel: resolveModelFor,
			projectTrusted: ctx.isProjectTrusted?.() ?? false,
			onSettled: makeOnSettled(notifier),
		});
		// supervisor 文件信箱：每次会话都重建（session_shutdown 会 dispose，
		// 且 initialized 是进程级单次，后续会话必须重新创建通道并启动轮询）
		supervisorChannel?.dispose();
		supervisorChannel = createSupervisorChannel(pi, {
			getSessionId: () => {
				try {
					return currentCtx?.sessionManager.getSessionId() ?? process.env[ENV_ORCHESTRATOR_SESSION_ID];
				} catch {
					return process.env[ENV_ORCHESTRATOR_SESSION_ID];
				}
			},
			onRequest: (request, visibleText) => {
				try {
					pi.sendMessage(
						{
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
						},
						{ triggerTurn: true },
					);
				} catch {
					/* 会话不活跃则丢弃（请求文件仍在，下一轮扫描不会重复唤醒） */
				}
			},
		});
		supervisorChannel.start();
		if (!initialized) {
			initialized = true;
			// 接管上次会话遗留的 run（主 pi 重启场景）：补发未通知的回调
			void scheduler.restoreFromDisk().then(() => {
				if (notifier) enqueueUnnotified(notifier, loadAllRuns());
			});
			// HTTP API（PiDeck 面板）
			const port = Number(process.env.SUBAGENT_HTTP_PORT) || DEFAULT_HTTP_PORT;
			startHttpServer(port);
			console.log(`[pi-subagent] HTTP API 已启动: http://127.0.0.1:${port}`);
		}
	});

	// 主 pi 退出时不取消子代理（后台运行需求）；这里只做记录
	pi.on("session_shutdown", () => {
		currentCtx = null;
		supervisorChannel?.dispose();
		supervisorChannel = null;
		notifier?.dispose();
		notifier = null;
	});
}
