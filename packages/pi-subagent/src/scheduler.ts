/** 调度器：pending 队列 + 并发控制 + 自动重试 + 手动恢复 + 主 pi 重启接管。 */
import type { ChildHandle } from "./runner.ts";
import { isProcessAlive, parseResult, spawnChild } from "./runner.ts";
import { continueProcess, pauseProcess, stopProcess } from "./control.ts";
import { ensureRunDir, eventsPath, loadAllRuns, loadRun, readStatus, readTask, runDir, stderrPath, writeResult, writeStatus, writeTask } from "./store.ts";
import { createWorktree, isGitRepo } from "./worktree.ts";
import type { RunRecord, RunResultData, RunTask } from "./types.ts";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_RETRY, MAX_RESUME_COUNT } from "./types.ts";
import { statSync, readFileSync } from "node:fs";

export interface SchedulerDeps {
	maxConcurrency: number;
	/** 从当前主 session 解析继承模型/thinking */
	resolveModel: (task: RunTask) => { model?: string; thinking?: string };
	projectTrusted: boolean;
	/** run 进入终态（completed/failed/stopped/interrupted）时通知（回调/补发） */
	onSettled: (run: RunRecord) => void;
}

interface ActiveEntry {
	handle: ChildHandle;
}

const MONITOR_INTERVAL_MS = 3000;
const BUDGET_CHECK_INTERVAL_MS = 5000;
const TIMEOUT_EXIT_CODE = 124;

class Scheduler {
	deps: SchedulerDeps = {
		maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		resolveModel: () => ({}),
		projectTrusted: false,
		onSettled: () => {},
	};
	private queue: string[] = [];
	private active = new Map<string, ActiveEntry>();
	/** 主 pi 重启后接管：需要轮询进程状态的 run */
	private monitorSet = new Set<string>();
	private monitorTimer: ReturnType<typeof setInterval> | null = null;
	private budgetTimer: ReturnType<typeof setInterval> | null = null;

	/** 预算/超时监控：maxRuntimeMs 总超时、turnBudget 回合上限、toolTimeoutMs 无输出卡死 */
	private startBudgetMonitor(): void {
		if (this.budgetTimer) return;
		this.budgetTimer = setInterval(() => {
			void this.checkBudgets();
		}, BUDGET_CHECK_INTERVAL_MS);
		this.budgetTimer.unref?.();
	}

	private async checkBudgets(): Promise<void> {
		const now = Date.now();
		for (const runId of [...this.active.keys()]) {
			const task = readTask(runId);
			const status = readStatus(runId);
			if (!task || !status || status.status !== "running") continue;

			// 1) 总运行超时
			if (task.maxRuntimeMs && status.startedAt && now - status.startedAt > task.maxRuntimeMs) {
				await this.timeoutRun(runId, `运行超时（超过 ${Math.round(task.maxRuntimeMs / 1000)}s）`);
				continue;
			}

			// 2) 回合数上限
			if (task.turnBudget) {
				const turns = countAssistantTurns(runId);
				if (turns > task.turnBudget) {
					await this.timeoutRun(runId, `超出回合预算（${turns}/${task.turnBudget} turns）`);
					continue;
				}
			}

			// 3) 工具卡死（无事件输出超时）
			if (task.toolTimeoutMs && task.toolTimeoutMs > 0) {
				try {
					const mtime = statSync(eventsPath(runId)).mtimeMs;
					if (now - mtime > task.toolTimeoutMs) {
						await this.timeoutRun(runId, `工具无输出超时（超过 ${Math.round(task.toolTimeoutMs / 1000)}s 无事件）`);
					}
				} catch {
					/* events 文件不存在则跳过 */
				}
			}
		}
	}

	/** 超时/预算触发：kill 进程并定终态 failed(timeout) */
	private async timeoutRun(runId: string, reason: string): Promise<void> {
		const status = readStatus(runId);
		const task = readTask(runId);
		if (!status || !task) return;
		if (status.status !== "running") return;
		if (status.pid) await stopProcess(status.pid);
		this.active.delete(runId);
		const result = parseResult(runId, TIMEOUT_EXIT_CODE);
		result.errorMessage = reason;
		result.stopReason = "timeout";
		writeResult(runId, result);
		this.finishStatus(runId, status, {
			status: "failed",
			finishedAt: Date.now(),
			exitCode: TIMEOUT_EXIT_CODE,
			stopReason: "timeout",
			errorMessage: reason,
		});
		const run = loadRun(runId);
		if (run) this.deps.onSettled(run);
		this.pump();
	}

	init(deps: Partial<SchedulerDeps>): void {
		this.deps = { ...this.deps, ...deps };
	}

	/** 创建 run 并排队。返回错误信息或 null。 */
	async schedule(task: RunTask): Promise<string | null> {
		ensureRunDir(task.id);
		writeTask(task);
		writeStatus(task.id, {
			status: "pending",
			notified: false,
			resumeCount: 0,
			retryLeft: task.retry,
		});
		this.queue.push(task.id);
		this.pump();
		return null;
	}

	/** 活动 run 数 */
	activeCount(): number {
		return this.active.size;
	}

	/** 从队列启动 pending 任务，直到并发满 */
	pump(): void {
		while (this.active.size < this.deps.maxConcurrency && this.queue.length > 0) {
			const runId = this.queue.shift()!;
			const status = readStatus(runId);
			if (!status || status.status !== "pending") continue;
			void this.spawnRun(runId, { resume: false });
		}
	}

	private async spawnRun(runId: string, opts: { resume: boolean }): Promise<void> {
		const task = readTask(runId);
		if (!task) return;
		const status = readStatus(runId) ?? {
			status: "pending" as const,
			notified: false,
			resumeCount: 0,
			retryLeft: task.retry,
		};

		// worktree：首次运行前创建隔离目录
		if (task.worktree && !task.worktreePath && !opts.resume) {
			const worktreePath = runDir(runId) + "-wt";
			if (await isGitRepo(task.cwd)) {
				const wt = await createWorktree(task.cwd, runId, worktreePath);
				if (wt.ok) {
					task.worktreePath = wt.worktreePath;
					writeTask(task);
				}
			}
		}

		const { model, thinking } = this.deps.resolveModel(task);
		const handle = spawnChild({
			task,
			model,
			thinking,
			resume: opts.resume,
			lastError: status.lastError,
			projectTrusted: this.deps.projectTrusted,
		});

		this.active.set(runId, { handle });
		// exit 监听丢失时的兜底：纳入进程存活轮询（tick 3s 检测，进程消失即定终态）
		this.monitorSet.add(runId);
		writeStatus(runId, {
			...status,
			status: "running",
			pid: handle.pid,
			startedAt: status.startedAt ?? Date.now(),
			errorMessage: undefined,
		});

		handle.proc.on("exit", (code) => {
			void this.handleExit(runId, code ?? undefined);
		});
	}

	private async handleExit(runId: string, exitCode: number | undefined): Promise<void> {
		this.active.delete(runId);
		const status = readStatus(runId);
		const task = readTask(runId);
		if (!status || !task) return;
		if (status.status === "stopped") {
			// 用户主动停止，exit 回调不覆盖状态
			this.finishStatus(runId, status, { status: "stopped", finishedAt: Date.now(), exitCode });
			this.deps.onSettled(loadRun(runId)!);
			this.pump();
			return;
		}
		// 预算/超时监控已定终态（timeoutRun），exit 回调不覆盖
		if (status.status !== "running" && status.status !== "paused") return;

		const result = parseResult(runId, exitCode ?? 0);
		writeResult(runId, result);
		const failed = exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length";

		if (failed && status.status !== "interrupted") {
			status.resumeCount += 1;
			status.lastError = result.errorMessage || result.stopReason || `退出码 ${exitCode}`;
			status.startedAt = status.startedAt ?? Date.now();

			// 模型回退（独立配额 fallbackModels.length+1 次，含最终主模型兜底，不消耗 retryLeft）：
			// 主模型 → fallbackModels[0..n] → 主 agent 继承模型（兜底，不再换回坏 task.model）
			if (isModelFailure(result, runId) && task.fallbackModels?.length) {
				const idx = status.fallbackIndex ?? -1;
				if (idx + 1 < task.fallbackModels.length + 1) {
					let nextModel: string | undefined;
					let inheritModel = false;
					if (idx + 1 < task.fallbackModels.length) {
						nextModel = task.fallbackModels[idx + 1]!;
					} else {
						inheritModel = true;
					}
					status.fallbackIndex = idx + 1;
					writeStatus(runId, status);
					this.spawnResume(runId, task, { model: nextModel, inheritModel });
					return;
				}
			}

			// 常规重试（同模型，消耗 retryLeft）
			if (status.retryLeft > 0) {
				status.retryLeft -= 1;
				writeStatus(runId, status);
				this.spawnResume(runId, task);
				return;
			}
		}

		const finalStatus = failed ? "failed" : "completed";
		this.finishStatus(runId, status, {
			status: finalStatus,
			finishedAt: Date.now(),
			exitCode,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage,
		});
		this.deps.onSettled(loadRun(runId)!);
		this.pump();
	}

	private finishStatus(
		runId: string,
		status: NonNullable<ReturnType<typeof readStatus>>,
		partial: Partial<NonNullable<ReturnType<typeof readStatus>>>,
	): void {
		writeStatus(runId, { ...status, ...partial, pid: undefined });
	}

	// ── 手动控制 ──────────────────────────────────────────────

	async stop(runId: string): Promise<{ ok: boolean; error?: string }> {
		const status = readStatus(runId);
		if (!status) return { ok: false, error: "run 不存在" };
		if (status.status !== "running" && status.status !== "paused" && status.status !== "pending") {
			return { ok: false, error: `当前状态 ${status.status} 不可停止` };
		}
		if (status.status === "pending") {
			this.queue = this.queue.filter((id) => id !== runId);
			this.finishStatus(runId, status, { status: "stopped", finishedAt: Date.now() });
			this.deps.onSettled(loadRun(runId)!);
			return { ok: true };
		}
		writeStatus(runId, { ...status, status: "stopped" });
		if (status.pid) await stopProcess(status.pid);
		return { ok: true };
	}

	async pause(runId: string): Promise<{ ok: boolean; error?: string }> {
		const status = readStatus(runId);
		if (!status) return { ok: false, error: "run 不存在" };
		if (status.status !== "running" || !status.pid) return { ok: false, error: `当前状态 ${status.status} 不可暂停` };
		await pauseProcess(status.pid);
		writeStatus(runId, { ...status, status: "paused", pausedAt: Date.now() });
		return { ok: true };
	}

	async continueRun(runId: string): Promise<{ ok: boolean; error?: string }> {
		const status = readStatus(runId);
		if (!status) return { ok: false, error: "run 不存在" };
		if (status.status !== "paused" || !status.pid) return { ok: false, error: `当前状态 ${status.status} 不可继续` };
		await continueProcess(status.pid);
		writeStatus(runId, { ...status, status: "running", pausedAt: undefined });
		return { ok: true };
	}

	/** 手动恢复：failed/interrupted/stopped 的 run，同 session-id 续跑 */
	async resume(runId: string, opts?: { model?: string }): Promise<{ ok: boolean; error?: string }> {
		const status = readStatus(runId);
		const task = readTask(runId);
		if (!status || !task) return { ok: false, error: "run 不存在" };
		if (status.status === "running" || status.status === "pending") {
			return { ok: false, error: `当前状态 ${status.status}，无需恢复` };
		}
		if (status.resumeCount >= MAX_RESUME_COUNT) {
			return { ok: false, error: `恢复次数已达上限 ${MAX_RESUME_COUNT} 次` };
		}
		status.resumeCount += 1;
		status.lastError = status.lastError || status.errorMessage || "手动恢复";
		writeStatus(runId, { ...status, status: "running" });
		// resume 未显式指定模型时，忽略原 task.model（上次的模型已失败），回退继承主 agent
		this.spawnResume(runId, opts?.model ? task : { ...task, model: undefined });
		return { ok: true };
	}

	/** 用同 session-id 续跑（自动重试与手动恢复共用）。内部负责 active 登记 + exit 监听。 */
	private spawnResume(runId: string, task: RunTask, opts?: { model?: string; inheritModel?: boolean }): void {
		const status = readStatus(runId)!;
		// inheritModel：忽略 task.model，用继承的主 agent 模型（兜底场景）
		const effectiveTask = opts?.inheritModel ? { ...task, model: undefined } : opts?.model ? { ...task, model: opts.model } : task;
		const { model, thinking } = this.deps.resolveModel(effectiveTask);
		const handle = spawnChild({
			task: effectiveTask,
			model,
			thinking,
			resume: true,
			lastError: status.lastError,
			projectTrusted: this.deps.projectTrusted,
		});
		this.active.set(runId, { handle });
		this.monitorSet.add(runId);
		writeStatus(runId, {
			...status,
			status: "running",
			pid: handle.pid,
			startedAt: status.startedAt ?? Date.now(),
			errorMessage: undefined,
		});
		handle.proc.on("exit", (code) => {
			void this.handleExit(runId, code ?? undefined);
		});
	}

	// ── 主 pi 重启接管 ─────────────────────────────────────────

	/** 扫描磁盘，把 running/paused 的 run 纳入进程存活监控。
	 * 每次 session_start 调用：即使宿主进程重启/换人接管，磁盘上
	 * 遗留的“running 但子进程已消失”的 run 也会被 tick 轮询定终态。 */
	refreshMonitor(): void {
		const runs = loadAllRuns();
		for (const run of runs) {
			const { task, status } = run;
			if ((status.status === "running" || status.status === "paused") && status.pid) {
				this.monitorSet.add(task.id);
			}
		}
		this.ensureMonitor();
	}

	/** 扫描磁盘，重建队列/监控/补发回调 */
	async restoreFromDisk(): Promise<void> {
		const runs = loadAllRuns();
		for (const run of runs) {
			const { task, status } = run;
			if (status.status === "pending") {
				this.queue.push(task.id);
			} else if (status.status === "running" || status.status === "paused") {
				if (status.pid) {
					this.monitorSet.add(task.id);
				} else {
					this.finishStatus(task.id, status, { status: "interrupted" });
				}
			} else if (!status.notified) {
				// 终态未通知 → 补发回调
				this.deps.onSettled(run);
			}
		}
		this.ensureMonitor();
		this.startBudgetMonitor();
		this.pump();
	}

	private ensureMonitor(): void {
		if (this.monitorTimer) return;
		this.monitorTimer = setInterval(() => {
			void this.tick();
		}, MONITOR_INTERVAL_MS);
		this.monitorTimer.unref?.();
	}

	/** 轮询被接管的 run：进程死了 → 定终态 + 回调 */
	private async tick(): Promise<void> {
		for (const runId of [...this.monitorSet]) {
			const status = readStatus(runId);
			if (!status || !status.pid) {
				this.monitorSet.delete(runId);
				continue;
			}
			if (await isProcessAlive(status.pid)) continue;
			this.monitorSet.delete(runId);
			// 进程结束，exitCode 未知：以事件流判定
			const result = parseResult(runId, 0);
			writeResult(runId, result);
			const failed = result.stopReason === "error" || result.stopReason === "aborted";
			this.finishStatus(runId, status, {
				status: failed ? "failed" : result.output ? "completed" : "interrupted",
				finishedAt: Date.now(),
				stopReason: result.stopReason,
				errorMessage: result.errorMessage,
			});
			const run = loadRun(runId);
			if (run) this.deps.onSettled(run);
		}
	}
}

/** 统计 events.jsonl 中 assistant 回合数（message_end 且 role=assistant） */
function countAssistantTurns(runId: string): number {
	let count = 0;
	try {
		const raw = readFileSync(eventsPath(runId), "utf-8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				if (event?.type === "message_end" && event.message?.role === "assistant") count++;
			} catch {
				/* skip bad line */
			}
		}
	} catch {
		/* events 文件不存在 */
	}
	return count;
}

/** 判断失败是否与模型相关（限流/超时/模型不存在/上下文过长等）
 * 注意：模型不存在等启动错误只写在 stderr.log（events 为空），需一并检查。 */
function isModelFailure(result: RunResultData, runId?: string): boolean {
	const text = `${result.errorMessage ?? ""} ${result.stopReason ?? ""}`.toLowerCase();
	if (/model|429|503|rate\s?limit|overload|context\s?length|invalid\s?api|timeout/i.test(text)) return true;
	if (runId) {
		try {
			const stderr = readFileSync(stderrPath(runId), "utf-8").toLowerCase();
			if (/model\s+["']?[\w/.\-]+["']?\s+not\s+found|429|503|rate\s?limit|overload|context\s?length|invalid\s?api|timeout/i.test(stderr)) return true;
		} catch {
			/* stderr 不存在则跳过 */
		}
	}
	return false;
}

export const scheduler = new Scheduler();
