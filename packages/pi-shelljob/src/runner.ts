/** 进程管理：detached 后台 spawn（stdio 重定向到日志文件）、进程树 kill、存活探测、超时/僵尸监控。
 * 注意：Windows 下 detached + 管道 stdio 会丢失子进程输出，因此日志采集必须用 fd 重定向
 * （子进程继承文件句柄直接写盘，宿主退出后照样落日志）。 */
import * as fs from "node:fs";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
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
	// 预热 Windows bash 探测（含候选可用性验证，首次约数百毫秒）：避免首次提交任务时
	// 「写 running 状态 → spawn 完成」之间的无 pid 窗口被监控循环误判为僵尸接管。
	if (process.platform === "win32") resolveWindowsBash();
}

/** 追加诊断到任务日志（spawn 失败 / 异常退出且零输出时兑底，保证日志不再是排查盲区）。 */
function appendLog(jobId: string, text: string): void {
	try {
		fs.appendFileSync(outputPath(jobId), text, "utf-8");
	} catch {
		/* 日志写不进不能影响终态落盘 */
	}
}

/** Windows 下的 bash 路径（与同步 bash 工具同为 Git Bash，模型无需区分两套 shell 语法）；
 * 探测不到可用 bash 时为 null，回退 cmd.exe（shell: true）。探测只在进程生命周期内做一次。
 *
 * 探测策略（v2，修复「所有命令 ~110ms exit 1、零输出」故障）：
 * 候选 = 环境变量（SHELL/MSYS_BASH）→ Git for Windows 固定路径 → PiAbyss 自带 bash
 * → where bash 结果（剔除 WSL 壳）。每个候选必须真实跑通 `bash -c "echo ok"`（带超时）
 * 才被采用——文件存在 / where 命中一律不算数。曾有缺陷：where 输出里只排除了
 * System32\bash.exe，漏掉同为 WSL 壳别名的 WindowsApps\bash.exe，导致命中一个
 * execvpe(/bin/bash) 直接失败的 WSL 启动器（本机无发行版）：exit 1、零输出、无日志。 */
let windowsBash: string | null | undefined;

/** WSL 壳特征：System32\bash.exe 与 WindowsApps\bash.exe（应用执行别名）都只是
 * WSL 启动器，不是可直接 spawn 的 Windows bash；system32\linux 是 where 对
 * System32 下 Linux 子目录的另一种展示形态。 */
const WSL_BASH_RE = /\\windows\\system32\\|\\windowsapps\\|system32\\linux/i;

/** where bash 的原始输出 → 候选列表（剔除 WSL 壳后按原顺序返回） */
export function parseWhereBash(raw: string): string[] {
	return raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.filter((p) => !WSL_BASH_RE.test(p));
}

/** 收集 Windows bash 候选（按优先级，已去重、不验证）：
 * 环境变量 SHELL / MSYS_BASH → Git for Windows 固定路径 → PiAbyss 自带 bash。 */
export function collectBashCandidates(env: NodeJS.ProcessEnv): string[] {
	const candidates: string[] = [];
	for (const v of [env.SHELL, env.MSYS_BASH]) {
		const p = typeof v === "string" ? v.trim() : "";
		if (p) candidates.push(p);
	}
	const fixed = [
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
	];
	const local = typeof env.LOCALAPPDATA === "string" ? env.LOCALAPPDATA.trim() : "";
	if (local) fixed.push(path.join(local, "PiAbyss", "resources", "git", "bin", "bash.exe"));
	candidates.push(...fixed);
	return [...new Set(candidates)];
}

/** 验证候选 bash 真的能执行命令（带短超时）：跑 `bash -c "echo <marker>"` 且 stdout
 * 含标记才算可用。WSL 壳（execvpe 失败 exit 1）、损坏的可执行文件、不存在的路径
 * 都会被这里淘汰——绝不能只凭文件存在或 where 命中就采用。 */
export function isUsableBash(candidate: string, timeoutMs = 5000): boolean {
	const MARKER = "__pi_shelljob_bash_ok__";
	try {
		const out = execFileSync(candidate, ["-c", `echo ${MARKER}`], {
			timeout: timeoutMs,
			windowsHide: true,
			encoding: "utf-8",
		});
		return out.includes(MARKER);
	} catch {
		return false; // 启动失败 / 非零退出 / 超时 → 不可用
	}
}

/** 按顺序取第一个「验证可用」的 bash；全不可用返回 null（调用方回退 cmd.exe）。
 * probe 可注入，便于测试用假候选覆盖「坏候选跳过 / 全坏回退」路径。 */
export function pickUsableBash(candidates: string[], probe: (candidate: string) => boolean = isUsableBash): string | null {
	for (const candidate of candidates) {
		if (probe(candidate)) return candidate;
	}
	return null;
}

function resolveWindowsBash(): string | null {
	if (windowsBash !== undefined) return windowsBash;
	windowsBash = null;
	if (process.platform === "win32") {
		const candidates = collectBashCandidates(process.env);
		try {
			candidates.push(...parseWhereBash(execFileSync("where", ["bash"], { windowsHide: true, encoding: "utf-8" })));
		} catch {
			/* where 不可用就只用固定路径候选 */
		}
		windowsBash = pickUsableBash([...new Set(candidates)]);
	}
	return windowsBash;
}

/** 测试专用：真实执行一次探测并返回结果（预热缓存 / 断言选中目标用） */
export function resolveWindowsBashForTest(): string | null {
	return resolveWindowsBash();
}

/** 测试专用：重置探测缓存（隔离用例） */
export function resetWindowsBashForTest(): void {
	windowsBash = undefined;
}

/** 测试专用：注入探测结果（验证 cmd 回退等路径无需真实探测） */
export function setWindowsBashForTest(value: string | null): void {
	windowsBash = value;
}

/** 后台启动命令：windowsHide，stdout/stderr 通过文件描述符重定向到 output.log（追加）。
 * Windows：不能用 detached —— CREATE_NEW_PROCESS_GROUP 下的 cmd.exe 直接不执行命令
 * （实测 echo 都不跑且静默返回 0），故非 detached（正常退出宿主不影响任务，终端窗口
 * 被直接关闭才会终止，与 VS Code 任务行为一致）；kill 用 taskkill /T /F 按进程树杀。
 * Windows 优先用探测到的 bash（与同步 bash 工具同一 Git Bash），避免模型混用两套
 * shell 语法（cmd 不认 while/$(...) 等 bash 语法，且中文输出按 GBK 落日志会乱码）；
 * bash 以 `-lc` 启动（登录 shell 保证 nvm 等环境就绪，UTF-8 编码顺带解决乱码）。
 * 注意：
 * - spawn bash 时不能用 windowsVerbatimArguments——Node 把参数原样拼给 Windows，
 *   带引号/空格的命令字符串在 bash 收到前就被吃掉引号，导致 exit 127。
 * - MSYS 程序（bash/echo 等）不认 Node 通过 stdio 传入的文件句柄（写时 EBADF，
 *   exit 1，实测 Git Bash 2.x + Node 24），fd 重定向对 cmd/node 生效但对 bash 失效。
 *   故 bash 路径改为让 bash 自己 exec 重定向打开日志（父进程 stdio 全 ignore），
 *   子进程持有真正的打开句柄，宿主退出后照样写盘，与 fd 继承语义等价。
 * Unix：detached 脱离会话（setsid 语义），宿主退出不影响，kill(-pid) 杀整组。返回 pid。 */
export function spawnShellJob(job: ShellJob, timeoutMs: number): number {
	if (!deps) throw new Error("runner 未初始化");
	const bash = process.platform === "win32" ? resolveWindowsBash() : null;
	const shellName = bash ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
	let logFd: number | undefined;
	let argv: string[] | null = null;
	if (!bash) {
		try {
			logFd = fs.openSync(outputPath(job.id), "a");
		} catch {
			logFd = undefined; // 打不开文件则丢弃输出，任务照跑
		}
	} else {
		// bash 自己重定向日志：'…' 单引号转义（' → '\''），log 路径来自插件自身的 JOBS_ROOT，不含单引号
		const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
		const log = outputPath(job.id).replaceAll("\\", "/");
		argv = ["-lc", `exec >> ${shq(log)} 2>&1\n${job.command}`];
	}
	const child = bash
		? spawn(bash, argv!, {
				cwd: job.cwd,
				detached: false,
				windowsHide: true,
				stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
				env: process.env,
			})
		: spawn(job.command, {
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
		// spawn 失败同样要写日志：否则任务零输出无从排查（如 shell 本身启动失败）
		appendLog(job.id, `[pi-shelljob] 启动失败（shell: ${shellName}）：${message}\n`);
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
			appendLog(job.id, `[pi-shelljob] shell（${shellName}）被信号 ${signal} 终止。\n`);
			deps?.settle(job.id, { status: "killed", finishedAt: Date.now(), errorMessage: `被信号 ${signal} 终止` });
			return;
		}
		if (code !== 0 && outputLogSize(job.id) === 0) {
			// 零输出的非零退出：子进程没能产生任何输出就死了（如 shell 本身启动失败、
			// 或命令静默失败），把退出码兑底写进日志，避免「exit 1 无日志」盲区
			appendLog(
				job.id,
				`[pi-shelljob] shell（${shellName}）退出码 ${code ?? "未知"}，进程未产生任何输出。\n[pi-shelljob] 若命令本身应有输出，请检查 shell 环境是否可用（Windows 下可能命中了不可用的 bash）。\n`,
			);
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
 * timedOut/reason 非空时终态记为 failed（带原因），否则记为 killed。
 * opts.by 标记停止来源（"user" = 用户界面手动停止 / "agent" = agent 主动 kill），
 * 落盘到 status.killedBy，通知据此区分「用户手动停止」与「异常终止」。 */
export function killShellJob(
	jobId: string,
	opts?: { timedOut?: boolean; reason?: string; by?: "user" | "agent" },
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
	opts?: { timedOut?: boolean; reason?: string; by?: "user" | "agent" },
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
		deps?.settle(jobId, { status: "killed", finishedAt: Date.now(), ...(opts?.by ? { killedBy: opts.by } : {}) });
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
 * （fd 重定向模式下无法截断写入中的文件，只能用 kill 兑现上限语义，防失控刷盘）
 *
 * 只遍历本进程在管的 liveChildren：这些才是"可能正在失控刷盘"的任务，且
 * 完全不需要读盘（旧实现每 tick 把全部 job 的 job.json/status.json 读一遍，
 * 99 个 job 时是纯粹的空转；别的进程管理的任务由 takeoverOrphans 兜底）。 */
export function enforceLogLimits(): void {
	if (!deps) return;
	const maxLogBytes = deps.maxLogBytes;
	for (const jobId of liveChildren.keys()) {
		if (outputLogSize(jobId) > maxLogBytes) {
			void killShellJob(jobId, { reason: `输出日志超过保护上限（${formatBytes(maxLogBytes)}），自动终止` });
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

/** 进程级监控循环（每次宿主进程只启动一个）：日志保护 + 遗留任务接管。
 *
 * 日志保护 2s 一跳（只看 liveChildren，纯内存 + 一次 stat）；遗留任务接管是
 * 冷路径（只对"上一个宿主进程留下的 running 记录"有意义），首个 tick 跑一次，
 * 之后每 60s 一次就够，没必要每 2s 把整个 jobs 目录读一遍。 */
export function startMonitorLoop(): void {
	const TICK = 2000;
	const ORPHAN_INTERVAL_MS = 60_000;
	let lastOrphanSweep = 0;
	setInterval(() => {
		void (async () => {
			if (!deps) return;
			enforceLogLimits();
			const now = Date.now();
			if (now - lastOrphanSweep < ORPHAN_INTERVAL_MS) return;
			lastOrphanSweep = now;
			await takeoverOrphans();
		})();
	}, TICK).unref?.();
}
