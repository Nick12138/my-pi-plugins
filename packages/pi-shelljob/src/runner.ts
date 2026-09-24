/** 进程管理：detached 后台 spawn（stdio 重定向到日志文件）、进程树 kill、存活探测、超时/僵尸监控。
 * 注意：Windows 下 detached + 管道 stdio 会丢失子进程输出，因此日志采集必须用 fd 重定向
 * （子进程继承文件句柄直接写盘，宿主退出后照样落日志）。 */
import * as fs from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
	isTerminal,
	loadAllJobs,
	outputLogSize,
	outputPath,
	readStatus,
	writeStatus,
	type ShellJob,
	type ShellJobStatusData,
} from "./store.ts";

interface LiveChild {
	jobId: string;
	child: ChildProcess;
	timer: ReturnType<typeof setTimeout> | null;
}

/** 本进程内活着的子进程（exit 事件据此带真实退出码定终态） */
const liveChildren = new Map<string, LiveChild>();
/** kill 在途的任务：期间 exit 事件不自行定终态，由 killShellJob 统一按终止原因落盘 */
const killing = new Set<string>();
/** Single-flight per job: duplicate requests share the actual kill result. */
const killOperations = new Map<string, Promise<{ ok: boolean; error?: string }>>();
const exitsDuringKill = new Map<string, { code: number | null; signal: NodeJS.Signals | null }>();

export interface SpawnDeps {
	/** 单任务日志保护上限：超过后保护性 kill（防失控输出塞满磁盘） */
	maxLogBytes: number;
	/** 终态落盘并触发通知路由（幂等：非 running 状态直接跳过） */
	settle: (jobId: string, update: Partial<ShellJobStatusData> & { status: ShellJobStatusData["status"] }) => void;
}

let deps: SpawnDeps | null = null;

export function initRunner(d: SpawnDeps): void {
	deps = d;
}

/** 后台启动命令：windowsHide，stdout/stderr 通过文件描述符重定向到 output.log（追加）。
 * Windows：不能用 detached —— CREATE_NEW_PROCESS_GROUP 下的 cmd.exe 直接不执行命令
 * （实测 echo 都不跑且静默返回 0），故非 detached（正常退出宿主不影响任务，终端窗口
 * 被直接关闭才会终止，与 VS Code 任务行为一致）；kill 用 taskkill /T /F 按进程树杀。
 * Unix：detached 脱离会话（setsid 语义），宿主退出不影响，kill(-pid) 杀整组。返回 pid。 */
export function spawnShellJob(job: ShellJob, timeoutMs: number): number {
	if (!deps) throw new Error("runner 未初始化");
	let logFd: number | undefined;
	try {
		logFd = fs.openSync(outputPath(job.id), "a");
	} catch {
		logFd = undefined; // 打不开文件则丢弃输出，任务照跑
	}
	const child = spawn(job.command, {
		shell: true,
		cwd: job.cwd,
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
		env: process.env,
	});
	// 父进程侧关闭 fd：子进程已继承句柄，宿主保留只会锁住文件
	if (logFd !== undefined) fs.closeSync(logFd);
	const pid = child.pid ?? -1;
	// 同步补写 pid：exit 事件是异步触发的，这里同步写入一定能落在 settle 之前
	const stNow = readStatus(job.id);
	if (stNow && stNow.status === "running") writeStatus(job.id, { ...stNow, pid });
	const live: LiveChild = { jobId: job.id, child, timer: null };
	liveChildren.set(job.id, live);

	// 单任务超时（精确）；进程级监控循环负责接管宿主重启后的遗留任务与日志超限保护
	if (timeoutMs > 0) {
		live.timer = setTimeout(() => {
			void killShellJob(job.id, { timedOut: true, reason: `超时（${Math.round(timeoutMs / 1000)}s）被自动终止` });
		}, timeoutMs);
		live.timer.unref?.();
	}

	const fail = (message: string): void => {
		// 失败也要清理：否则本任务的 Map 项与超时 timer 泄漏，且监控循环因
		// liveChildren.has() 为真而跳过本次任务，僵尸永远不会被接管定终态。
		liveChildren.delete(job.id);
		if (live.timer) clearTimeout(live.timer);
		deps?.settle(job.id, {
			status: "failed",
			finishedAt: Date.now(),
			errorMessage: message,
		});
	};
	child.on("error", (err) => fail(`启动失败：${err.message}`));
	child.on("exit", (code, signal) => {
		liveChildren.delete(job.id);
		if (live.timer) clearTimeout(live.timer);
		// kill 在途时暂存真实 exit：先区分“自然退出抢先发生”和“kill 导致退出”，
		// 后者仍由 killShellJob 统一按终止原因落盘。
		if (killing.has(job.id)) {
			exitsDuringKill.set(job.id, { code, signal });
			return;
		}
		const st = readStatus(job.id);
		// kill/超时已先行定终态（killed/failed），exit 只兜底正常退出
		if (st && isTerminal(st)) return;
		if (signal) {
			deps?.settle(job.id, { status: "killed", finishedAt: Date.now(), errorMessage: `被信号 ${signal} 终止` });
			return;
		}
		deps?.settle(job.id, {
			status: code === 0 ? "succeeded" : "failed",
			exitCode: code ?? undefined,
			finishedAt: Date.now(),
		});
	});
	return pid;
}

/** 终止任务：Windows taskkill /T /F 杀整棵进程树；Unix 杀 detached 进程组。
 * timedOut/reason 非空时终态记为 failed（带原因），否则记为 killed。 */
export function killShellJob(
	jobId: string,
	opts?: { timedOut?: boolean; reason?: string },
): Promise<{ ok: boolean; error?: string }> {
	const existing = killOperations.get(jobId);
	if (existing) return existing;
	const operation = killShellJobOnce(jobId, opts).finally(() => {
		if (killOperations.get(jobId) === operation) killOperations.delete(jobId);
	});
	killOperations.set(jobId, operation);
	return operation;
}

async function killShellJobOnce(
	jobId: string,
	opts?: { timedOut?: boolean; reason?: string },
): Promise<{ ok: boolean; error?: string }> {
	const st = readStatus(jobId);
	if (!st) return { ok: false, error: "任务不存在" };
	if (isTerminal(st)) return { ok: false, error: `任务已结束（${st.status}）` };
	const pid = st.pid;
	if (!pid || pid <= 0) return { ok: false, error: "缺少有效 pid" };

	const live = liveChildren.get(jobId);
	killing.add(jobId);
	// Fence the exit listener before the async liveness check. If it has already
	// exited, preserve its real outcome instead of claiming a user stop.
	if (!(await isProcessAlive(pid))) {
		killing.delete(jobId);
		const exited = exitsDuringKill.get(jobId);
		exitsDuringKill.delete(jobId);
		if (live?.timer) clearTimeout(live.timer);
		if (exited?.signal) deps?.settle(jobId, { status: "killed", finishedAt: Date.now(), errorMessage: `被信号 ${exited.signal} 终止` });
		else if (exited) deps?.settle(jobId, { status: exited.code === 0 ? "succeeded" : "failed", exitCode: exited.code ?? undefined, finishedAt: Date.now() });
		else deps?.settle(jobId, { status: "interrupted", finishedAt: Date.now(), errorMessage: "进程已退出，退出码未知" });
		return { ok: false, error: "进程已退出，任务已按自然结束收尾" };
	}
	let ok = true;
	let error: string | undefined;
	try {
		if (process.platform === "win32") {
			await new Promise<void>((resolve) => {
				execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
			});
		} else {
			try {
				process.kill(-pid, "SIGKILL"); // detached → 组长，负值杀整组
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* 已退出 */
				}
			}
		}
		// 验证真的死了（taskkill 可能因权限不足而失败）；未死则 300ms 后复查
		if (await isProcessAlive(pid)) {
			await new Promise((r) => setTimeout(r, 300));
			if (await isProcessAlive(pid)) {
				ok = false;
				error = "终止命令已执行但进程仍存活（可能权限不足），任务状态保持运行中";
			}
		}
	} finally {
		killing.delete(jobId);
	}
	exitsDuringKill.delete(jobId);

	if (!ok) {
		// kill 失败：不落终态，否则谎报成功且丢失真实运行状态；超时 timer 也已失效，重置为 null
		if (live) live.timer = null;
		return { ok: false, error };
	}

	if (live?.timer) clearTimeout(live.timer);

	// 统一落终态：timedOut/reason 非空 → failed（带原因），否则 killed
	if (opts?.timedOut || opts?.reason) {
		deps?.settle(jobId, { status: "failed", finishedAt: Date.now(), timedOut: opts.timedOut, errorMessage: opts.reason });
	} else {
		deps?.settle(jobId, { status: "killed", finishedAt: Date.now() });
	}
	return { ok: true };
}

/** 探测 pid 是否存活 */
export function isProcessAlive(pid: number): Promise<boolean> {
	if (!pid || pid <= 0) return Promise.resolve(false);
	if (process.platform === "win32") {
		return new Promise((resolve) => {
			execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, stdout) => {
				if (err) return resolve(false);
				resolve(stdout.includes(`"${pid}"`));
			});
		});
	}
	try {
		process.kill(pid, 0);
		return Promise.resolve(true);
	} catch {
		return Promise.resolve(false);
	}
}

/** 字节数人类可读化（保护上限提示用） */
function formatBytes(n: number): string {
	return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/** 日志保护：单任务 output.log 超过 maxLogBytes 的运行中任务保护性 kill
 * （fd 重定向模式下无法截断写入中的文件，只能用 kill 兑现上限语义，防失控刷盘） */
export function enforceLogLimits(): void {
	if (!deps) return;
	for (const { job, status } of loadAllJobs()) {
		if (status.status !== "running") continue;
		if (outputLogSize(job.id) > deps.maxLogBytes) {
			void killShellJob(job.id, { reason: `输出日志超过保护上限（${formatBytes(deps.maxLogBytes)}），自动终止` });
		}
	}
}

/** 接管遗留任务（宿主重启/崩溃后）：
 * - 超时（内存 timer 已丢）→ kill 并定 failed/timedOut
 * - pid 已消失 → interrupted（退出码不可知）
 * 只处理本进程未在管的 liveChildren，与精确的 exit/timer 路径不重叠。 */
export async function takeoverOrphans(): Promise<void> {
	if (!deps) return;
	for (const { job, status } of loadAllJobs()) {
		if (status.status !== "running") continue;
		if (liveChildren.has(job.id)) continue; // 本进程管理中，交给 exit/timer
		// 宿主在写入 running 状态后、spawn 前崩溃：无 pid，永远等不到 exit，直接落终态
		if (!status.pid) {
			deps.settle(job.id, {
				status: "interrupted",
				finishedAt: Date.now(),
				errorMessage: "宿主崩溃于任务启动前（无 pid 记录），任务未实际运行",
			});
			continue;
		}
		// 遗留任务：先查超时再查存活（超时优先语义明确）
		const timeout = job.timeoutMs ?? 0;
		if (timeout > 0 && Date.now() - status.startedAt > timeout) {
			await killShellJob(job.id, { timedOut: true, reason: `超时（${Math.round(timeout / 1000)}s）被自动终止` });
			continue;
		}
		if (!(await isProcessAlive(status.pid))) {
			deps.settle(job.id, {
				status: "interrupted",
				finishedAt: Date.now(),
				errorMessage: "宿主进程重启期间退出，退出码未知",
			});
		}
	}
}

/** 进程级监控循环（每次宿主进程只启动一个）：日志保护 + 遗留任务接管。 */
export function startMonitorLoop(): void {
	const TICK = 2000;
	setInterval(() => {
		void (async () => {
			if (!deps) return;
			enforceLogLimits();
			await takeoverOrphans();
		})();
	}, TICK).unref?.();
}
