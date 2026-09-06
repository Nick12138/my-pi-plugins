/**
 * 完成通知管理器：批量 + 投递确认 + 自动重试。
 *
 * 用 pi.sendMessage 发送自定义类型消息（customType: "subagent-notify"）：
 * - 通知不冒充用户消息，可注册 renderer 定制 TUI 显示
 * - sendMessage 成功后才写 notified 标记（投递确认），失败保留在队列重试
 * - 同一批待通知的 run 合并成一条消息发送，减少上下文占用与打断
 *
 * 会话归属：每个 Notifier 实例绑定唯一的发起会话（sessionId + send 回调），
 * 由扩展层按 task.sessionId 路由创建（见 extensions/pi-subagent.ts 的 sessionPipes）。
 * 一个宿主进程可能同时运行多个会话（如 PiDeck 的 active/background/热缓存），
 * 通知必须送回发起会话的实例，绝不能“最后一次 session_start 赢者通吃”。
 */
import { readResult, readStatus, writeStatus } from "./store.ts";
import { STATUS_LABEL } from "./types.ts";
import type { RunRecord } from "./types.ts";

export const SUBAGENT_NOTIFY_MESSAGE_TYPE = "subagent-notify";

/** 发送给宿主会话的自定义消息形状（宿主侧 pi.sendMessage 的第一参数） */
export interface NotifyMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

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
	/** 本实例归属的会话 id（发起会话）；归属不符的 run 一律拒绝入队 */
	private readonly sessionId: string | undefined;
	/** 投递通道：宿主侧 pi.sendMessage(msg, { triggerTurn: true }) 的封装。
	 * 会话不活跃时应抛错（由调用方保留队列重试）。 */
	private readonly send: (message: NotifyMessage) => void;
	private pending = new Map<string, RunRecord>();
	private flushing = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private batchTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(sessionId: string | undefined, send: (message: NotifyMessage) => void) {
		this.sessionId = sessionId;
		this.send = send;
	}

	/** 入队一个已终结的 run；延迟一个批量窗口后合并发送，失败保留重试。
	 * 归属校验：非本会话的 run 直接丢弃（路由层应已按 sessionId 分发）。 */
	queue(run: RunRecord): void {
		const status = readStatus(run.task.id);
		if (!status || status.notified) return;
		if (this.sessionId && run.task.sessionId !== this.sessionId) {
			// 归属不符：标记已通知丢弃，防止其他会话的通知被本会话吞掉
			writeStatus(run.task.id, { ...status, notified: true });
			return;
		}
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
			await this.drainQueue(this.pending);
		} finally {
			this.flushing = false;
		}
	}

	/** 清空并发送终态通知队列（发送成功写 notified 标记）。
	 * 仅终态（completed/failed/stopped/interrupted）入队；暂停等中间态不通知，
	 * 主 agent 可通过 subagent(action:"list") 自行查看。 */
	private async drainQueue(map: Map<string, RunRecord>): Promise<void> {
		while (map.size > 0) {
			const items = [...map.values()].map((run) => ({ run }));
			const content = formatGrouped(items);
			try {
				this.send({
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
				});
				// 投递确认：sendMessage 接受后才写 notified 标记
				for (const { run } of items) {
					const st = readStatus(run.task.id);
					if (st) writeStatus(run.task.id, { ...st, notified: true });
					map.delete(run.task.id);
				}
			} catch {
				// 会话不活跃等：保留队列，由定时器重试
				break;
			}
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

/** 补发指定会话的历史遗留未通知终态 run（宿主重启/会话重开场景）。
 * 暂停等中间态不通知（主 agent 可自行 subagent(action:"list") 查看状态）。 */
export function enqueueUnnotified(notifier: Notifier, runs: RunRecord[]): void {
	for (const run of runs) {
		const status = readStatus(run.task.id);
		if (!status || status.notified) continue;
		if (status.status !== "completed" && status.status !== "failed" && status.status !== "stopped" && status.status !== "interrupted") continue;
		notifier.queue(run);
	}
}
