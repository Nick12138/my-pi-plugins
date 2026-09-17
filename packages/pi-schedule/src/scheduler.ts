/**
 * 调度引擎（进程级单例）：
 * - ticker 周期扫描到期任务（外部时钟 nextRunAt，绝不信模型报的时间）
 * - fs.watch 监听 jobs.json：任务一改立刻重排，不必等下一个 tick
 * - 单飞锁：同一 job 已在跑就跳过本次（不排队，避免雪崩）
 * - 并发上限：同时最多 maxConcurrent 个执行会话
 * - 终止：once 跑一次即止；maxRuns 到顶自动 disable
 * - 启动即补跑：宿主任一时刻启动时，把 pi 关闭期间错过的窗口补上
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import {
	appendLedger,
	ensureRoot,
	listJobs,
	listRuns,
	patchJobsWith,
	paths,
	tryAcquireRunLock,
} from "./store.ts";
import { runJob } from "./runner.ts";
import { advanceNextRunAt, shouldFire, systemTimezone } from "./schedule.ts";
import { DEFAULTS, type Job, type RunRecord } from "./types.ts";

export interface SchedulerOptions {
	tickMs?: number;
	maxConcurrent?: number;
	agentDir?: string;
	onRunFinished?: (record: RunRecord) => void;
	onJobsChanged?: () => void;
}

/** 触发参数（手动 run_now / 续聊 reply 都复用）。 */
export interface FireOptions {
	trigger?: RunRecord["trigger"];
	scheduledFor?: string | null;
	forkFromSessionPath?: string | null;
	forkOfRunId?: string | null;
	replyText?: string | null;
	permissionOverride?: Job["permission"];
	timeoutMsOverride?: number;
}

export class Scheduler {
	private readonly options: SchedulerOptions;
	private readonly tickMs: number;
	private readonly maxConcurrent: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private watcher: FSWatcher | null = null;
	private watcherDebounce: ReturnType<typeof setTimeout> | null = null;
	private ticking = false;
	private readonly activeRuns = new Map<string, Promise<RunRecord>>();
	private startedAt: string | null = null;

	constructor(options: SchedulerOptions = {}) {
		this.options = options;
		this.tickMs = options.tickMs ?? DEFAULTS.tickMs;
		this.maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrentRuns;
	}

	start(): void {
		if (this.timer) return;
		ensureRoot();
		this.startedAt = new Date().toISOString();
		this.timer = setInterval(() => void this.tick("tick").catch(() => undefined), this.tickMs);
		this.timer.unref?.();
		this.watchJobsFile();
		void this.tick("session_start").catch(() => undefined);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.watcher) {
			try {
				this.watcher.close();
			} catch {
				/* 忽略 */
			}
		}
		this.watcher = null;
		if (this.watcherDebounce) clearTimeout(this.watcherDebounce);
		this.watcherDebounce = null;
	}

	/** 监听 jobs.json 所在目录（原子替换会让文件 inode 变化，监听目录更稳）。 */
	private watchJobsFile(): void {
		try {
			const dir = dirname(paths().jobsFile);
			if (!existsSync(dir)) return;
			this.watcher = watch(dir, (_event, filename) => {
				if (filename && String(filename) !== "jobs.json") return;
				if (this.watcherDebounce) clearTimeout(this.watcherDebounce);
				this.watcherDebounce = setTimeout(() => {
					this.watcherDebounce = null;
					this.options.onJobsChanged?.();
					void this.tick("tick").catch(() => undefined);
				}, 250);
			});
			this.watcher.unref?.();
		} catch {
			/* watch 不可用不影响 ticker */
		}
	}

	isBusy(): boolean {
		return this.activeRuns.size > 0;
	}

	activeCount(): number {
		return this.activeRuns.size;
	}

	activeJobIds(): string[] {
		return [...this.activeRuns.keys()];
	}

	status(): { startedAt: string | null; activeJobs: string[]; tickMs: number; maxConcurrent: number } {
		return {
			startedAt: this.startedAt,
			activeJobs: this.activeJobIds(),
			tickMs: this.tickMs,
			maxConcurrent: this.maxConcurrent,
		};
	}

	/** 扫描一次；重入时直接返回（上一次扫描还在进行）。 */
	async tick(reason: "tick" | "session_start" = "tick"): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const jobList = listJobs();
			const timezone = systemTimezone();
			const now = new Date();
			const staleIds: string[] = [];

			for (const job of jobList) {
				// per-job 兜底：形状校验之外的意外脏数据也不允许拖垮整个扫描
				try {
					this.scanJob(job, now, staleIds);
				} catch (error) {
					console.error(
						`[pi-schedule] 扫描任务 ${job?.id ?? "?"} 异常，已跳过：${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			if (staleIds.length > 0) this.advanceStaleJobs(staleIds, now, timezone);
		} finally {
			this.ticking = false;
		}
	}

	/** 单个任务的扫描逻辑（由 tick 逐个调用，异常不影响其他任务）。 */
	private scanJob(job: Job, now: Date, staleIds: string[]): void {
		if (!job.enabled || job.terminated) return;
		if (job.trigger.type === "manual") return;
		if (!job.nextRunAt) return;
		if (this.activeRuns.has(job.id)) return;
		if (this.activeRuns.size >= this.maxConcurrent) return;

		const decision = shouldFire({
			nextRunAt: job.nextRunAt,
			now,
			missedWindow: job.missedWindow,
			trigger: job.trigger,
		});

		if (!decision.fire) {
			const due = new Date(job.nextRunAt).getTime();
			if (due <= now.getTime()) staleIds.push(job.id);
			return;
		}

		void this.fire(job, { trigger: job.trigger.type, scheduledFor: job.nextRunAt }).catch(() => undefined);
	}

	/**
	 * skip 策略下已过期的任务：推进排期，或在无法前进时终止。
	 *
	 * 关键：`once` 的 nextRunAt 是固定时刻，重算仍会得到同一个过去时间——
	 * 若在这里无脑回写，每次 tick 都会重写 jobs.json → fs.watch 再 tick，
	 * 形成自持写入死循环（已实测）。所以推不动就直接终止。
	 *
	 * 用 patchJobsWith：补丁基于锁内最新数据计算，不会覆盖并发修改。
	 */
	private advanceStaleJobs(jobIds: string[], now: Date, timezone: string): void {
		const applied = patchJobsWith(jobIds, (fresh) => {
			try {
				// 正在执行的任务不要动它的排期/状态（once 任务跑得比宽限期久时
				// 曾被误标成 terminated:"missed"）
				if (this.activeRuns.has(fresh.id)) return null;
				// 跨进程证据：本进程 activeRuns 为空不代表没人跑——另一个宿主进程
				// 可能正在执行（共用数据目录）。runs 目录里最新记录仍是 running 且
				// 未超出「超时 + 宽限」就当作正在执行，不动它的排期/状态。
				// 超出宽限仍 running 的记录视为宿主崩溃遗留的僵尸，照常处理。
				const latest = listRuns(fresh.id, 1)[0];
				if (latest?.status === "running") {
					const startedMs = Date.parse(latest.startedAt);
					const bound = Math.max(60_000, fresh.timeoutMs + 5 * 60 * 1000);
					if (Number.isFinite(startedMs) && Date.now() - startedMs < bound) return null;
				}
				if (!fresh.nextRunAt) return null;
				const due = new Date(fresh.nextRunAt).getTime();
				if (due > now.getTime()) return null; // 期间已被别的路径推进
				// once 走到这里就说明「唯一的那个槽位」已经过期且 skip 策略不发车：
				// 直接终止（不看 trigger.at——槽位才是事实上的计划时刻）
				const next =
					fresh.trigger.type === "once" ? null : advanceNextRunAt(fresh.trigger, now, timezone, fresh.nextRunAt);
				if (!next) {
					// 无法前进：终止，避免反复重写（once 已过期 / 表达式不再可触发）
					return {
						enabled: false,
						terminated: "missed" as const,
						nextRunAt: null,
						updatedAt: now.toISOString(),
					};
				}
				return { nextRunAt: next, updatedAt: now.toISOString() };
			} catch (error) {
				// 脏数据导致的意外异常：跳过这个任务，绝不让它把整个 tick 拖死
				console.error(
					`[pi-schedule] 处理过期任务 ${fresh?.id ?? "?"} 异常，已跳过：${error instanceof Error ? error.message : String(error)}`,
				);
				return null;
			}
		});

		for (const { id, patch } of applied) {
			const job = listJobs().find((j) => j.id === id);
			if (patch.terminated) {
				appendLedger({
					at: now.toISOString(),
					event: "terminate",
					jobId: id,
					jobName: job?.name,
					detail: "错过窗口且无法推进排期（skip 策略）——已终止",
				});
			} else {
				appendLedger({
					at: now.toISOString(),
					event: "skip",
					jobId: id,
					jobName: job?.name,
					detail: "错过窗口，按 skip 策略放弃本次并推进排期",
				});
			}
		}
	}

	/** 手动触发（run_now / reply）。会抛出错误供 HTTP 层返回 4xx/5xx。 */
	trigger(job: Job, overrides: FireOptions = {}): Promise<RunRecord> {
		return this.fire(job, overrides);
	}

	private fire(job: Job, overrides: FireOptions = {}): Promise<RunRecord> {
		// 锁的过期时间要覆盖「任务最长可能运行时间」，否则长任务会被另一个
		// 进程判为陈旧锁而抢占 → 同一任务并发执行两次。
		const timeoutMs = overrides.timeoutMsOverride ?? job.timeoutMs;
		const lockStaleMs = Math.max(60_000, timeoutMs + 5 * 60 * 1000);
		const release = tryAcquireRunLock(job.id, lockStaleMs);
		if (!release) {
			// 单飞：本次跳过，但要把排期往前推，避免反复命中同一 slot
			appendLedger({
				at: new Date().toISOString(),
				event: "lock",
				jobId: job.id,
				jobName: job.name,
				detail: "上一次执行仍在进行，本次跳过（单飞）",
			});
			if (overrides.scheduledFor) {
				// 锁被占时**不要**写 nextRunAt：once 在此会算出 null，写入就留下
				// 「enabled 但永不再跑」的僵尸态。单飞锁本身已经保证不会重复发车，
				// 同一个 slot 等锁释放后自然会再被 tick 命中（或由 advanceStaleJobs 处理 skip）。
			}
			const running = this.activeRuns.get(job.id);
			if (running) return running;
			return Promise.reject(new Error(`任务「${job.name}」正在执行中（单飞锁）`));
		}

		const trigger = overrides.trigger ?? (job.trigger.type === "manual" ? "manual" : job.trigger.type);
		const promise = runJob(job, {
			trigger,
			scheduledFor: overrides.scheduledFor ?? null,
			forkFromSessionPath: overrides.forkFromSessionPath ?? null,
			forkOfRunId: overrides.forkOfRunId ?? null,
			replyText: overrides.replyText ?? null,
			permissionOverride: overrides.permissionOverride,
			timeoutMsOverride: overrides.timeoutMsOverride,
			agentDir: this.options.agentDir,
		})
			.then((record) => {
				this.afterRun(job, record);
				return record;
			})
			.catch((error: unknown) => {
				appendLedger({
					at: new Date().toISOString(),
					event: "error",
					jobId: job.id,
					jobName: job.name,
					detail: `执行器异常：${error instanceof Error ? error.message : String(error)}`,
				});
				throw error;
			})
			.finally(() => {
				this.activeRuns.delete(job.id);
				release();
			});

		this.activeRuns.set(job.id, promise);
		return promise;
	}

	/**
	 * 终态后处理：更新 job 排期/计数/终止状态。
	 *
	 * 全部基于「锁内的最新 job」计算（patchJobsWith）：
	 * - runCount 原子自增，不会因陈旧快照而丢失并发完成的次数（maxRuns 失效）；
	 * - nextRunAt 从 scheduledFor 推进，保留节拍（避免长任务导致整体漂移）。
	 */
	private afterRun(job: Job, record: RunRecord): void {
		const now = new Date();
		const timezone = systemTimezone();
		// aborted 不计入投递次数（用户主动中止不应消耗配额）
		const delivered = record.status === "aborted" ? 0 : 1;
		const applied = patchJobsWith([job.id], (fresh) => {
			const runCount = fresh.runCount + delivered;
			const patch: Partial<Job> = {
				lastRunAt: record.finishedAt ?? now.toISOString(),
				lastRunId: record.runId,
				lastStatus: record.status,
				runCount,
				updatedAt: now.toISOString(),
				nextRunAt: advanceNextRunAt(fresh.trigger, now, timezone, record.scheduledFor),
			};
			if (fresh.trigger.type === "once") {
				patch.enabled = false;
				patch.terminated = "once";
				patch.nextRunAt = null;
			} else if (fresh.maxRuns !== null && runCount >= fresh.maxRuns) {
				patch.enabled = false;
				patch.terminated = "maxRuns";
				patch.nextRunAt = null;
			}
			return patch;
		});

		const outcome = applied[0]?.patch;
		// 任务可能在运行期间被删除：patch 为空，但这次终态仍要通知（队列里必须有）
		if (!outcome) {
			this.options.onRunFinished?.(record);
			return;
		}
		if (outcome.terminated === "once") {
			appendLedger({
				at: now.toISOString(),
				event: "terminate",
				jobId: job.id,
				jobName: job.name,
				runId: record.runId,
				detail: "一次性任务已执行完毕",
			});
		} else if (outcome.terminated === "maxRuns") {
			appendLedger({
				at: now.toISOString(),
				event: "terminate",
				jobId: job.id,
				jobName: job.name,
				runId: record.runId,
				detail: `已达投递上限 ${job.maxRuns} 次`,
			});
		}

		this.options.onRunFinished?.(record);
	}
}

let singleton: Scheduler | null = null;

/** 进程级单例：一个宿主进程多个会话时，只允许一个调度器。 */
export function getScheduler(options: SchedulerOptions = {}): Scheduler {
	if (!singleton) singleton = new Scheduler(options);
	return singleton;
}

export function resetScheduler(): void {
	singleton?.stop();
	singleton = null;
}
