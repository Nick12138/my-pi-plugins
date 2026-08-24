/** 调度器：pending 队列 + 并发控制 + 自动重试 + 手动恢复 + 主 pi 重启接管。 */
import type { ChildHandle } from "./runner.ts";
import { isProcessAlive, parseResult, spawnChild } from "./runner.ts";
import { continueProcess, pauseProcess, stopProcess } from "./control.ts";
import { ensureRunDir, loadAllRuns, loadRun, readStatus, readTask, runDir, writeResult, writeStatus, writeTask } from "./store.ts";
import { createWorktree, isGitRepo } from "./worktree.ts";
import type { RunRecord, RunTask } from "./types.ts";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_RETRY, MAX_RESUME_COUNT } from "./types.ts";

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

		const result = parseResult(runId, exitCode ?? 0);
		writeResult(runId, result);
		const failed = exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length";

		if (failed && status.retryLeft > 0 && status.status !== "interrupted") {
			// 自动重试（A+B）：retryLeft--，同 session-id 续跑（不重复执行已完成部分）
			status.retryLeft -= 1;
			status.resumeCount += 1;
			status.lastError = result.errorMessage || result.stopReason || `退出码 ${exitCode}`;
			status.startedAt = status.startedAt ?? Date.now();
			writeStatus(runId, status);
			this.spawnResume(runId, task);
			return;
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
	async resume(runId: string): Promise<{ ok: boolean; error?: string }> {
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
		this.spawnResume(runId, task);
		return { ok: true };
	}

	/** 用同 session-id 续跑（自动重试与手动恢复共用）。内部负责 active 登记 + exit 监听。 */
	private spawnResume(runId: string, task: RunTask): void {
		const status = readStatus(runId)!;
		const { model, thinking } = this.deps.resolveModel(task);
		const handle = spawnChild({
			task,
			model,
			thinking,
			resume: true,
			lastError: status.lastError,
			projectTrusted: this.deps.projectTrusted,
		});
		this.active.set(runId, { handle });
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

export const scheduler = new Scheduler();
