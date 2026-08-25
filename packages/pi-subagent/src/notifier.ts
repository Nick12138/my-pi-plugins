/**
 * 完成通知管理器：批量 + 投递确认 + 自动重试。
 *
 * 对比旧实现（sendUserMessage 注入用户消息），这里用 pi.sendMessage 发送
 * 自定义类型消息（customType: "subagent-notify"）：
 * - 通知不冒充用户消息，可注册 renderer 定制 TUI 显示
 * - sendMessage 成功后才写 notified 标记（投递确认），失败保留在队列重试
 * - 同一批待通知的 run 合并成一条消息发送，减少上下文占用与打断
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readResult, readStatus, writeStatus } from "./store.ts";
import { STATUS_LABEL } from "./types.ts";
import type { RunRecord } from "./types.ts";
import { ENV_ORCHESTRATOR_SESSION_ID } from "./supervisor-protocol.ts";

export const SUBAGENT_NOTIFY_MESSAGE_TYPE = "subagent-notify";

const FLUSH_INTERVAL_MS = 5000;
const BATCH_WINDOW_MS = 1000;
const MAX_PREVIEW = 800;

export interface NotifyItem {
	run: RunRecord;
}

/** 单条完成通知的格式化文本 */
export function formatRunNotice(run: RunRecord, detail: boolean): string {
	const { task, status, result } = run;
	const label = STATUS_LABEL[status.status];
	const duration = status.startedAt && status.finishedAt ? `${Math.round((status.finishedAt - status.startedAt) / 1000)}s` : "-";
	const model = result?.model ?? task.model ?? "继承";
	const who = operatorLabel(status.operator);
	const meta = `（${task.agent} · ${duration} · ${model}${who}）`;
	const lines = [`【子代理通知】「${task.title}」${label}${meta}`];
	if (status.errorMessage) lines.push(`失败原因：${status.errorMessage}`);

	// 用户主动停止/暂停：主 agent 必须先询问用户，不得自行恢复或重试
	if ((status.status === "stopped" || status.status === "paused") && status.operator === "user") {
		lines.push(
			`\n此任务由用户手动${status.status === "stopped" ? "停止" : "暂停"}。请先向用户确认是否需要继续，不要自行 resume/continue 或重试。`,
		);
	}

	if (detail && result?.output) {
		const out = result.output.length > MAX_PREVIEW ? result.output.slice(0, MAX_PREVIEW) + "\n…(已截断)" : result.output;
		lines.push("", out);
	}
	if (result?.usage && (result.usage.turns > 0 || result.usage.cost > 0)) {
		const u = result.usage;
		lines.push(`\n用法：${u.turns} turns · ↑${u.input} ↓${u.output} · $${u.cost.toFixed(4)}`);
	}
	if (status.status === "failed" || status.status === "interrupted") {
		lines.push(`\n可执行 subagent(action:"resume", runId:"${task.id}") 从断点继续；或 action:"stop" 放弃。`);
	}
	if (status.status === "completed" && task.worktreePath) {
		lines.push(`\n（此 run 在 worktree 中运行，改动未合并。执行 subagent(action:"merge", runId:"${task.id}") 合并。）`);
	}
	return lines.join("\n");
}

/** 状态信息里的操作者标注 */
function operatorLabel(operator: string | undefined): string {
	switch (operator) {
		case "user":
			return "·用户操作";
		case "agent":
			return "·主agent操作";
		case "system":
			return "·异常";
		default:
			return "";
	}
}

/** 合并多条通知：单条完整输出，多条紧凑列表 */
function formatGrouped(items: NotifyItem[]): string {
	if (items.length === 1) {
		return formatRunNotice(items[0]!.run, true);
	}
	const lines = [`【子代理通知】${items.length} 个任务已完成：`];
	for (const { run } of items) {
		const { task, status, result } = run;
		const label = STATUS_LABEL[status.status];
		const preview = result?.output?.split("\n")[0]?.slice(0, 80) ?? "";
		lines.push(`- 「${task.title}」${label}（${task.agent}）${preview ? `：${preview}` : ""}`);
	}
	lines.push(`\n查看详情：subagent(action:"list") 或 subagent(action:"result", runId:"<id>")。`);
	return lines.join("\n");
}

export class Notifier {
	private pi: ExtensionAPI;
	private pending = new Map<string, RunRecord>();
	private flushing = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private batchTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/** 入队一个已终结的 run；延迟一个批量窗口后合并发送，失败保留重试 */
	queue(run: RunRecord): void {
		const status = readStatus(run.task.id);
		if (!status || status.notified) return;
		this.pending.set(run.task.id, run);
		this.scheduleBatch();
	}

	/** 批量窗口内多次完成合并成一条通知；窗口后发送 */
	private scheduleBatch(): void {
		if (this.batchTimer) return;
		this.batchTimer = setTimeout(() => {
			this.batchTimer = null;
			void this.flush();
		}, BATCH_WINDOW_MS);
		this.batchTimer.unref?.();
	}

	private async flush(): Promise<void> {
		if (this.flushing) return;
		this.flushing = true;
		try {
			while (this.pending.size > 0) {
				// 通知按会话归属过滤：只发送给 run 的发起会话（当前激活会话）。
				// 跨会话/历史 run（含无 sessionId 的旧 run）不唤醒任何会话，直接标 notified 丢弃，
				// 避免“新会话收到别人的子代理通知并自动处理”（如自动 resume 产生额外 LLM 成本）。
				const currentSessionId = process.env[ENV_ORCHESTRATOR_SESSION_ID];
				const owned = [...this.pending.values()].filter((run) => {
					if (!run.task.sessionId) return false;
					return run.task.sessionId === currentSessionId;
				});
				// 非当前会话的 run：丢弃（标 notified，避免下次重复补发）
				for (const run of this.pending.values()) {
					if (owned.includes(run)) continue;
					const st = readStatus(run.task.id);
					if (st) writeStatus(run.task.id, { ...st, notified: true });
					this.pending.delete(run.task.id);
				}
				if (owned.length === 0) return;
				const items = owned.map((run) => ({ run }));
				const content = formatGrouped(items);
				try {
					this.pi.sendMessage(
						{
							customType: SUBAGENT_NOTIFY_MESSAGE_TYPE,
							content,
							// 不注入会话 UI：custom 消息不参与 LLM 上下文，仅作为内部触发信号，
							// 避免“工具提示”直接显示在主会话里。
							display: false,
							details: {
								count: items.length,
								runs: items.map(({ run }) => ({
									id: run.task.id,
									title: run.task.title,
									agent: run.task.agent,
									status: run.status.status,
								})),
							},
						},
						{ triggerTurn: true },
					);
					// 投递确认：sendMessage 接受后才标记 notified
					for (const { run } of items) {
						const st = readStatus(run.task.id);
						if (st) writeStatus(run.task.id, { ...st, notified: true });
						this.pending.delete(run.task.id);
					}
				} catch {
					// 会话不活跃等：保留队列，由定时器重试
					break;
				}
			}
		} finally {
			this.flushing = false;
		}
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.flush();
		}, FLUSH_INTERVAL_MS);
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

/** 重启接管时补发：终态但未通知的 run 入队 */
export function enqueueUnnotified(notifier: Notifier, runs: RunRecord[]): void {
	for (const run of runs) {
		const status = readStatus(run.task.id);
		if (status && !status.notified) notifier.queue(run);
	}
}
