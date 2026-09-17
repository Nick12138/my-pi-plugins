/**
 * pi-schedule 类型与常量。
 *
 * 设计原则：
 * - 文件即真相源：jobs.json 只由本插件写，PiAbyss 只读；控制面走 HTTP。
 * - 每次执行 = 一个独立的 pi 会话文件（sessions/<jobId>/<runId>.jsonl），
 *   不污染宿主会话，天然支持「历史可读 + fork 续聊」。
 */

/** 权限档位：决定执行会话能用的工具白名单。 */
export type PermissionTier = "read_only" | "write" | "full";

/** thinking 级别（与 pi 的 ThinkingLevel 对齐）。 */
export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 模型引用；缺省时用宿主 settings 的 defaultProvider/defaultModel。 */
export interface ModelRef {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevelName;
}

/** 触发方式。manual = 只手动触发，不进自动计划。 */
export type Trigger =
	| { type: "manual" }
	| { type: "once"; at: string }
	| { type: "interval"; every: string }
	| { type: "cron"; cron: string; timezone?: string };

/** 错过窗口策略。 */
export type MissedWindow = "catch_up_one" | "skip";

/** 完成通知推送方式。"tg" 为未来 Telegram 推送预留，当前无行为差异（面板仍以 notify-queue 为准）。 */
export type NotifyMode = "none" | "system" | "tg";

/** 执行终态。command 型任务不会出现 aborted（无会话可中止）。 */
export type RunStatus = "running" | "ok" | "error" | "timeout" | "aborted";

/** 触发来源，落进 run 记录用于审计。 */
export type RunTrigger = "manual" | "once" | "interval" | "cron" | "reply";

/** 任务终止原因（终止后 enabled=false 且不再参与扫描）。 */
export type TerminationReason = "once" | "maxRuns" | "missed";

export interface Job {
	/** 8 位十六进制。 */
	id: string;
	name: string;
	/** 任务内容，即发给执行会话的 prompt。命令型任务（command 非空）不用。 */
	prompt: string;
	/** 命令型任务：非空时触发后直接执行 shell 命令（不经模型、无执行会话），与 prompt 互斥。 */
	command: string | null;
	/** 工作区绝对路径，作为执行会话的 cwd。 */
	cwd: string;
	enabled: boolean;
	permission: PermissionTier;
	/** 缺省 = 用宿主默认模型。 */
	model: ModelRef | null;
	trigger: Trigger;
	missedWindow: MissedWindow;
	/** 完成通知推送方式（默认 none）。 */
	notify: NotifyMode;
	/** 单次执行超时（ms），默认 30 分钟。 */
	timeoutMs: number;
	/** 投递次数上限（ok+error+timeout 计数），到达后自动终止。 */
	maxRuns: number | null;
	/** 是否在执行会话中加载扩展/技能（默认 false：轻量、确定、防递归）。 */
	loadExtensions: boolean;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	updatedBy: string;
	/** 计算出的下次触发时间（ISO）；manual 或已终止为 null。 */
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastRunId: string | null;
	lastStatus: RunStatus | null;
	/** 已投递次数（ok+error+timeout；aborted 不计）。 */
	runCount: number;
	terminated: TerminationReason | null;
}

export interface UsageSummary {
	input: number;
	output: number;
	total: number;
	cost: number;
}

export interface RunRecord {
	runId: string;
	jobId: string;
	jobName: string;
	trigger: RunTrigger;
	/** 计划触发时刻（cron/interval/once 有值；manual/reply 为 null）。 */
	scheduledFor: string | null;
	startedAt: string;
	finishedAt: string | null;
	status: RunStatus;
	cwd: string;
	model: ModelRef | null;
	permission: PermissionTier;
	/** 实际生效的工具白名单；full 档记 ["*"]。 */
	tools: string[];
	sessionId: string | null;
	sessionPath: string | null;
	/** 续聊来源 run（fork 语义）。 */
	forkOf: string | null;
	/** 用户在该历史下的追问原文（trigger=reply 时有值）。 */
	replyText: string | null;
	usage: UsageSummary | null;
		/** 结果摘要（截断），供列表展示。 */
	summary: string;
	/** 本次执行的命令（仅命令型任务非空）。 */
	command: string | null;
	/** 最后一条 assistant 文本（截断）。 */
	outputText: string;
	/** 工具调用次数。 */
	toolCalls: number;
	error: string | null;
	idempotencyKey: string;
}

/** HTTP/工具层返回的精简 run 视图。 */
export interface RunSummary {
	runId: string;
	jobId: string;
	jobName: string;
	trigger: RunTrigger;
	status: RunStatus;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	model: ModelRef | null;
	permission: PermissionTier;
	forkOf: string | null;
	summary: string;
	error: string | null;
	usage: UsageSummary | null;
	toolCalls: number;
}

export interface LedgerEntry {
	at: string;
	event: "fire" | "skip" | "lock" | "terminate" | "error" | "reply";
	jobId: string;
	jobName?: string;
	runId?: string;
	detail?: string;
}

export interface NotifyEntry {
	at: string;
	jobId: string;
	jobName: string;
	runId: string;
	status: RunStatus;
	level: "info" | "error";
	title: string;
	message: string;
}

export const DEFAULTS = {
	timeoutMs: 30 * 60 * 1000,
	tickMs: 30 * 1000,
	maxConcurrentRuns: 2,
	missedWindow: "catch_up_one" as MissedWindow,
	notify: "none" as NotifyMode,
	permission: "read_only" as PermissionTier,
	httpPort: 18766,
	/** interval 最小粒度 */
	minIntervalMs: 60 * 1000,
	/** 允许的 interval 上限：90 天 */
	maxIntervalMs: 90 * 24 * 60 * 60 * 1000,
} as const;

export const LIMITS = {
	maxJobs: 200,
	maxPromptChars: 20_000,
	maxCommandChars: 2_000,
	maxOutputChars: 20_000,
	maxSummaryChars: 2_000,
	maxHistoryRows: 200,
	/** 单次 job 锁的过期上限；实际锁按任务 timeoutMs 动态计算（见 store.tryAcquireRunLock）。 */
	lockStaleMs: 60 * 60 * 1000,
	/** 台账保留行数（追加时裁剪，防无界增长）。 */
	maxLedgerLines: 5_000,
	/** 每个任务保留的历史 run 文件数。 */
	maxRunFilesPerJob: 300,
} as const;

export const ROOT_ENV = "PI_SCHEDULE_DIR";
export const PORT_ENV = "PI_SCHEDULE_PORT";
export const TICK_ENV = "PI_SCHEDULE_TICK_MS";
/** 控制面鉴权 token（缺省时自动生成到 <root>/token）。 */
export const TOKEN_ENV = "PI_SCHEDULE_TOKEN";
/** 与上游 npm 包 pi-schedule 的 ~/.pi-schedule 刻意区分。 */
export const DEFAULT_ROOT_DIRNAME = "schedule";
