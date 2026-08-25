/** pi-subagent 核心类型定义 */

export type RunStatus =
	| "pending" // 队列中等待槽位
	| "running" // 子进程运行中
	| "paused" // taskkill /SUSPEND 挂起
	| "completed" // 成功完成
	| "failed" // 失败（resumable）
	| "stopped" // 用户停止
	| "interrupted"; // 进程消失（主 pi 退出/崩溃）

export type AgentName = "scout" | "worker" | "reviewer";

/** 启动一个 run 的全部输入（写入 task.json） */
export interface RunTask {
	id: string;
	title: string; // 会话标题
	agent: AgentName;
	task: string;
	/** 模型覆盖，缺省 = 继承主 agent（task.json 里记录实际解析出的模型） */
	model?: string;
	thinking?: string;
	cwd: string;
	worktree: boolean;
	/** 失败自动重试次数 */
	retry: number;
	/** 模型回退列表：主模型失败（限流/超时/模型错误）时依次尝试 */
	fallbackModels?: string[];
	/** 运行总超时（毫秒），超时自动 kill */
	maxRuntimeMs?: number;
	/** 回合数上限，超出自动 stop（防失控） */
	turnBudget?: number;
	/** 单工具调用超时（毫秒），以进程无事件输出监控近似（0=不限制） */
	toolTimeoutMs?: number;
	/** 发起该 run 的主 agent 会话 id（orchestrator），面板按会话过滤用 */
	sessionId?: string;
	createdAt: number;
	parentCwd: string; // 主仓库位置（merge 时用）
	worktreePath?: string; // 创建成功后写入
}

/** 运行状态（写入 status.json，扩展是唯一 writer） */
export interface RunStatusData {
	status: RunStatus;
	pid?: number; // 当前（最近一次）子进程 pid
	startedAt?: number; // 首次开始时间
	finishedAt?: number;
	exitCode?: number;
	stopReason?: string; // end | error | aborted | length | ...
	errorMessage?: string;
	notified: boolean; // 是否已回调主 agent
	resumeCount: number; // 已恢复次数（上限 3）
	retryLeft: number; // 剩余自动重试次数
	fallbackIndex?: number; // 已尝试的模型回退位置（-1/缺省=主模型）
	pausedAt?: number;
	lastError?: string; // 最近一次失败原因（resume prompt 用）
}

/** 完成结果（写入 result.json） */
export interface RunResultData {
	output: string;
	errorMessage?: string;
	stopReason?: string;
	usage: {
		turns: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
	};
	model?: string;
	finishedAt: number;
}

/** 一个 run 的完整记录（内存 + 磁盘聚合） */
export interface RunRecord {
	task: RunTask;
	status: RunStatusData;
	result?: RunResultData;
}

export const STATUS_LABEL: Record<RunStatus, string> = {
	pending: "排队中",
	running: "运行中",
	paused: "已暂停",
	completed: "已完成",
	failed: "失败",
	stopped: "已停止",
	interrupted: "已中断",
};

export const MAX_RESUME_COUNT = 3;
export const DEFAULT_MAX_CONCURRENCY = 10;
export const DEFAULT_RETRY = 1;
export const DEFAULT_HTTP_PORT = 18765;
