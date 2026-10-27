/**
 * 落盘层：文件即真相源。全部原子写 + O_EXCL 锁。
 *
 * 目录（默认 ~/.pi/automation，可用 PI_AUTOMATION_DIR 覆盖）：
 *   jobs.json                       任务定义（唯一真相源，只由本插件写）
 *   runs/<jobId>/<runId>.json       单次执行元数据
 *   sessions/<jobId>/<runId>.jsonl  单次执行的 pi 会话（可 fork 续聊）
 *   locks/<jobId>.lock              单飞锁（跨进程）
 *   locks/jobs.lock                 jobs.json 的读改写锁
 *   runs.jsonl                      追加型台账（fire/skip/lock/terminate/error）
 *   notify-queue.jsonl              通知队列（桌面端消费）
 */
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	DEFAULTS,
	DEFAULT_ROOT_DIRNAME,
	LEGACY_DEFAULT_ROOT_DIRNAME,
	LEGACY_ROOT_ENV,
	LIMITS,
	readEnvWithLegacy,
	ROOT_ENV,
	type Job,
	type LedgerEntry,
	type NotifyEntry,
	type RunRecord,
	type RunStatus,
	type RunSummary,
} from "./types.ts";

export const STORE_VERSION = 1;

export interface JobsFile {
	version: number;
	jobs: Job[];
}

export interface StorePaths {
	root: string;
	jobsFile: string;
	runsRoot: string;
	sessionsRoot: string;
	locksDir: string;
	ledgerFile: string;
	notifyFile: string;
}

function resolveRoot(): string {
	const override = readEnvWithLegacy(ROOT_ENV, LEGACY_ROOT_ENV);
	if (override) return resolve(override);
	const root = join(homedir(), ".pi", DEFAULT_ROOT_DIRNAME);
	migrateLegacyRoot(join(homedir(), ".pi", LEGACY_DEFAULT_ROOT_DIRNAME), root);
	return root;
}

/**
 * 一次性把旧名时代的 `~/.pi/schedule` 搬到 `~/.pi/automation`。
 *
 * 只在「使用默认根」且「新根不存在、旧根存在」时动手；两边都有就谁也不碰，
 * 让调用方自己决定怎么合并。任何失败都只告警不抛：大不了当成一个空的新目录，
 * 绝不能因为搬家失败就把整个插件起不来。
 *
 * `from` / `target` 显式传入（而不是内部拼 homedir），单测才能拿临时目录跑。
 */
export function migrateLegacyRoot(
	from: string = join(homedir(), ".pi", LEGACY_DEFAULT_ROOT_DIRNAME),
	target: string = join(homedir(), ".pi", DEFAULT_ROOT_DIRNAME),
): "moved" | "merged" | "kept-both" | "nothing-to-move" {
	if (from === target || !existsSync(from)) return "nothing-to-move";
	if (!existsSync(join(from, "jobs.json"))) {
		// 旧目录里连任务定义都没有：没有值得搬的东西，别乱动。
		return "nothing-to-move";
	}
	if (!existsSync(target)) return moveDir(from, target);
	if (!targetIsStray(target)) {
		console.warn(`[pi-automation] 新旧数据目录都有任务数据：继续用 ${target}，${from} 原样保留，请自行合并。`);
		return "kept-both";
	}
	return mergeIntoStrayTarget(from, target);
}

/**
 * 新目录是不是「只有 Host 钉下的 token」这种空壳。
 *
 * 必须认得出来：桌面端的 Host 启动时就会往 `<root>/token` 落一份控制面 token，
 * 于是更名之后**每个用户**都会在插件第一次跑起来之前先有 `~/.pi/automation/`。
 * 把它当成「新目录已经有数据了」而拒绝搬家，表现是面板里任务全空——看着像数据丢失。
 */
function targetIsStray(target: string): boolean {
	if (existsSync(join(target, "jobs.json"))) return false;
	try {
		return readdirSync(target).filter((name) => name !== "token").length === 0;
	} catch {
		return false;
	}
}

/**
 * 把旧目录逐项并进 Host 钉下的 token 空壳目录。
 *
 * token 以**旧目录那份**为准：任务数据一直是用它写的，留着新钉的那份只会让每次调用都 401。
 * 并完删掉空的旧目录；中途失败就停在原地并告警，绝不删没确认过的数据。
 */
function mergeIntoStrayTarget(from: string, target: string): "merged" | "kept-both" {
	try {
		for (const name of readdirSync(from)) {
			renameSync(join(from, name), join(target, name));
		}
		rmdirSync(from);
		console.log(`[pi-automation] 已把旧数据目录并入 ${target}（含 token，以旧的那份为准）`);
		return "merged";
	} catch (error) {
		console.warn(
			`[pi-automation] 并入旧数据目录失败（${error instanceof Error ? error.message : String(error)}）：` +
				`请手动把 ${from} 的内容移到 ${target}（token 用 ${from} 里的那份）`,
		);
		return "kept-both";
	}
}

function moveDir(from: string, target: string): "moved" | "kept-both" {
	try {
		mkdirSync(dirname(target), { recursive: true });
		renameSync(from, target);
		console.log(`[pi-automation] 数据目录已更名：${from} → ${target}`);
		return "moved";
	} catch (error) {
		console.warn(
			`[pi-automation] 数据目录搬迁失败（${error instanceof Error ? error.message : String(error)}）：` +
				`仍使用 ${target}，旧数据留在 ${from}`,
		);
		return "kept-both";
	}
}

let cachedPaths: StorePaths | null = null;

export function paths(): StorePaths {
	if (cachedPaths) return cachedPaths;
	const root = resolveRoot();
	cachedPaths = {
		root,
		jobsFile: join(root, "jobs.json"),
		runsRoot: join(root, "runs"),
		sessionsRoot: join(root, "sessions"),
		locksDir: join(root, "locks"),
		ledgerFile: join(root, "runs.jsonl"),
		notifyFile: join(root, "notify-queue.jsonl"),
	};
	return cachedPaths;
}

/** 测试用：清空路径缓存（改环境变量后需调用）。 */
export function resetPathsCache(): void {
	cachedPaths = null;
}

export function ensureRoot(): void {
	const p = paths();
	for (const dir of [p.root, p.runsRoot, p.sessionsRoot, p.locksDir]) {
		mkdirSync(dir, { recursive: true });
	}
}

// ── 基础 IO ─────────────────────────────────────────────────

export function newJobId(): string {
	return randomBytes(4).toString("hex");
}

export function newRunId(): string {
	return randomBytes(6).toString("hex");
}

function writeJsonAtomic(file: string, data: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmp, file);
}

function readJsonFile<T>(file: string, fallback: T): T {
	if (!existsSync(file)) return fallback;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		// IO 错误（EACCES/EBUSY/EMFILE…）绝不能当成「文件损坏」：
		// jobs.json 是唯一真相源，一次瞬时读失败不该让任务列表消失。
		throw error;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		// 只有真的解析不了才隔离，并明确告警（不静默吞掉）
		const quarantine = `${file}.corrupt-${Date.now()}`;
		try {
			renameSync(file, quarantine);
		} catch {
			/* 隔离失败不阻塞 */
		}
		console.error(`[pi-automation] 文件损坏已隔离：${file} → ${quarantine}`);
		return fallback;
	}
}

function appendJsonLine(file: string, data: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(data)}\n`, "utf8");
}

function readJsonLines<T>(file: string, limit: number): T[] {
	if (!existsSync(file)) return [];
	let raw = "";
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const slice = lines.slice(Math.max(0, lines.length - limit));
	const out: T[] = [];
	for (const line of slice) {
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			/* 跳过坏行 */
		}
	}
	return out;
}

/** 只保留文件尾部 maxLines 行（通知队列防无限增长）。 */
function trimFile(file: string, maxLines: number): void {
	if (!existsSync(file)) return;
	try {
		const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
		if (lines.length <= maxLines) return;
		writeFileSync(file, `${lines.slice(lines.length - maxLines).join("\n")}\n`, "utf8");
	} catch {
		/* 裁剪失败不影响主流程 */
	}
}

// ── 文件锁（O_EXCL + 陈旧抢占）───────────────────────────────

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
	try {
		Atomics.wait(sleepCell, 0, 0, ms);
	} catch {
		/* 忽略 */
	}
}

/**
 * 获取文件锁。timeoutMs=0 表示「拿不到立刻失败」（单飞场景）。
 * staleMs 之后视为陈旧锁（持锁进程已死/超时）可抢占。
 */
export function acquireFileLock(
	lockPath: string,
	options: { timeoutMs?: number; staleMs?: number } = {},
): () => void {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const staleMs = options.staleMs ?? LIMITS.lockStaleMs;
	const deadline = Date.now() + timeoutMs;
	mkdirSync(dirname(lockPath), { recursive: true });

	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			// 锁内容带 nonce + expiresAt：
			// - nonce：release 前比对，防止「被抢占后旧持有者删掉新持有者的锁」；
			// - expiresAt：长任务不能被固定 stale 阈值误抢。
			const nonce = randomBytes(8).toString("hex");
			writeSync(
				fd,
				JSON.stringify({ pid: process.pid, nonce, at: new Date().toISOString(), expiresAt: Date.now() + staleMs }),
			);
			closeSync(fd);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				try {
					// 只在锁仍是自己的时候删（否则可能删掉抢占者的锁）
					const raw = readFileSync(lockPath, "utf8").trim();
					const parsed = JSON.parse(raw) as { nonce?: string };
					if (parsed.nonce && parsed.nonce !== nonce) return;
				} catch {
					return; // 读不到/已不在 = 无需删
				}
				try {
					unlinkSync(lockPath);
				} catch {
					/* 已被抢占则忽略 */
				}
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (isLockStale(lockPath, staleMs)) {
				let removed = false;
				try {
					unlinkSync(lockPath);
					removed = true;
				} catch {
					/* 删除失败（Windows EPERM/EBUSY）：必须退避，否则 100% CPU 忙等 */
				}
				if (!removed && Date.now() >= deadline) {
					throw new Error(`获取锁超时（陈旧锁无法清理）：${lockPath}`);
				}
				sleepSync(30 + Math.floor(Math.random() * 40));
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`获取锁超时：${lockPath}`);
			}
			sleepSync(20 + Math.floor(Math.random() * 30));
		}
	}
}

/** 陈旧判定：优先读锁内容的 expiresAt，无内容/内容坏才回退 mtime。 */
function isLockStale(lockPath: string, staleMs: number): boolean {
	try {
		const raw = readFileSync(lockPath, "utf8").trim();
		if (raw) {
			const parsed = JSON.parse(raw) as { expiresAt?: number };
			if (typeof parsed.expiresAt === "number") return Date.now() > parsed.expiresAt;
		}
	} catch {
		// 内容还没写入或已损坏：回退 mtime 判定（也兼容旧锁文件）
	}
	try {
		return Date.now() - statSync(lockPath).mtimeMs > staleMs;
	} catch {
		return true; // 锁已消失 = 可获取
	}
}

/** jobs.json 的读改写（跨进程安全）。 */
export function mutateJobs<T>(fn: (file: JobsFile) => T): T {
	ensureRoot();
	const release = acquireFileLock(join(paths().locksDir, "jobs.lock"));
	try {
		const file = readJobsFile();
		const result = fn(file);
		file.version = STORE_VERSION;
		writeJsonAtomic(paths().jobsFile, file);
		return result;
	} finally {
		release();
	}
}

// ── 任务 ────────────────────────────────────────────────────

/**
 * 旧数据兼容：向后兼容新增的字段在读取时补默认值，确保旧 jobs.json 不炸。
 * 只补缺失/形状不对的，不覆盖用户已写的合法值。
 */
function normalizeJob(job: Job): Job {
	if (!job || typeof job !== "object") return job;
	if (typeof job.notify !== "string") return { ...job, notify: DEFAULTS.notify };
	return job;
}

export function readJobsFile(): JobsFile {
	const file = readJsonFile<JobsFile>(paths().jobsFile, { version: STORE_VERSION, jobs: [] });
	if (!file || typeof file !== "object" || !Array.isArray(file.jobs)) {
		// 形状不对（{} / 顶层数组…）也是「真相源不可信」：隔离 + 告警，绝不静默丢任务
		const quarantine = `${paths().jobsFile}.corrupt-${Date.now()}`;
		try {
			renameSync(paths().jobsFile, quarantine);
		} catch {
			/* 忽略 */
		}
		console.error(`[pi-automation] jobs.json 结构非法，已隔离：${quarantine}`);
		return { version: STORE_VERSION, jobs: [] };
	}
	return { version: STORE_VERSION, jobs: file.jobs.map(normalizeJob) };
}

const TRIGGER_TYPES = new Set(["manual", "once", "interval", "cron"]);

/**
 * 单条 job 的最小形状校验：「文件即真相源」允许外部查看，但手动编辑改坏一条
 * 记录（如删掉 trigger）绝不能拖垮整个调度器。只查调度必需字段，其余字段
 * 交给各消费点自己兜底。
 */
function isShapedJob(job: unknown): job is Job {
	if (!job || typeof job !== "object") return false;
	const j = job as Record<string, unknown>;
	return (
		typeof j.id === "string" &&
		j.id.length > 0 &&
		typeof j.name === "string" &&
		typeof j.enabled === "boolean" &&
		!!j.trigger &&
		typeof j.trigger === "object" &&
		TRIGGER_TYPES.has((j.trigger as { type?: unknown }).type as string)
	);
}

/** 上次报告过的非法条目签名（去重：非法条目不修复就别每个 tick 都刷台账）。 */
let lastInvalidJobsSignature: string | null = null;

/** 列出任务：形状非法的条目被跳过（记 error 台账 + console，去重），不影响其他任务。 */
export function listJobs(): Job[] {
	const jobs = readJobsFile().jobs;
	const invalidIds: string[] = [];
	const valid: Job[] = [];
	for (const job of jobs) {
		if (isShapedJob(job)) {
			valid.push(job);
		} else {
			const raw = job as { id?: unknown } | null;
			invalidIds.push(typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : "(无 id)");
		}
	}
	if (invalidIds.length > 0) {
		const signature = invalidIds.join(",");
		if (signature !== lastInvalidJobsSignature) {
			lastInvalidJobsSignature = signature;
			console.error(`[pi-automation] jobs.json 中 ${invalidIds.length} 条记录形状非法，已跳过：${signature}`);
			for (const id of invalidIds) {
				appendLedger({
					at: new Date().toISOString(),
					event: "error",
					jobId: id,
					detail: "jobs.json 记录形状非法（可能被外部手动编辑），已跳过该条；修复或删除该条后恢复",
				});
			}
		}
	} else {
		lastInvalidJobsSignature = null;
	}
	return valid;
}

export function getJob(id: string): Job | undefined {
	return readJobsFile().jobs.find((job) => job.id === id);
}

export function upsertJob(job: Job): Job {
	return mutateJobs((file) => {
		const index = file.jobs.findIndex((j) => j.id === job.id);
		if (index >= 0) file.jobs[index] = job;
		else file.jobs.push(job);
		return job;
	});
}

export function patchJob(id: string, patch: Partial<Job>): Job | undefined {
	return mutateJobs((file) => {
		const index = file.jobs.findIndex((j) => j.id === id);
		if (index < 0) return undefined;
		const next = { ...file.jobs[index]!, ...patch, id };
		file.jobs[index] = next;
		return next;
	});
}

/** 批量改（调度扫描时一次写盘，避免 N 次锁竞争）。 */
export function patchJobsBatch(patches: Array<{ id: string } & Partial<Job>>): void {
	if (patches.length === 0) return;
	mutateJobs((file) => {
		for (const patch of patches) {
			const index = file.jobs.findIndex((j) => j.id === patch.id);
			if (index >= 0) file.jobs[index] = { ...file.jobs[index]!, ...patch, id: patch.id };
		}
	});
}

/**
 * 按「当前文件状态」计算补丁后原子写入。
 *
 * 与 patchJob/patchJobsBatch 的区别：补丁函数拿到的是**锁内的最新 job**，
 * 因此不会用陈旧快照覆盖并发修改（如 runCount 自增、用户刚改的 trigger）。
 * 返回 null 表示不改这个 job。
 */
export function patchJobsWith(
	jobIds: string[],
	compute: (job: Job) => Partial<Job> | null,
): Array<{ id: string; patch: Partial<Job> }> {
	if (jobIds.length === 0) return [];
	return mutateJobs((file) => {
		const applied: Array<{ id: string; patch: Partial<Job> }> = [];
		for (const id of jobIds) {
			const index = file.jobs.findIndex((j) => j.id === id);
			if (index < 0) continue;
			const current = file.jobs[index]!;
			const patch = compute(current);
			if (!patch) continue;
			file.jobs[index] = { ...current, ...patch, id };
			applied.push({ id, patch });
		}
		return applied;
	});
}

export function removeJob(id: string): boolean {
	return mutateJobs((file) => {
		const before = file.jobs.length;
		file.jobs = file.jobs.filter((j) => j.id !== id);
		return file.jobs.length < before;
	});
}

// ── 单飞锁 ──────────────────────────────────────────────────

const activeJobLocks = new Set<string>();

/** 同一 job 的执行锁；拿不到返回 null（本次跳过，不排队）。 */
export function tryAcquireRunLock(jobId: string, staleMs?: number): (() => void) | null {
	if (activeJobLocks.has(jobId)) return null;
	let releaseFile: () => void;
	try {
		releaseFile = acquireFileLock(join(paths().locksDir, `${jobId}.lock`), {
			timeoutMs: 0,
			staleMs: staleMs ?? LIMITS.lockStaleMs,
		});
	} catch {
		return null;
	}
	activeJobLocks.add(jobId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeJobLocks.delete(jobId);
		releaseFile();
	};
}

export function hasActiveRun(jobId: string): boolean {
	return activeJobLocks.has(jobId);
}

// ── 执行记录 ────────────────────────────────────────────────

export function runDir(jobId: string): string {
	return join(paths().runsRoot, jobId);
}

export function runFile(jobId: string, runId: string): string {
	return join(runDir(jobId), `${runId}.json`);
}

export function sessionDir(jobId: string): string {
	return join(paths().sessionsRoot, jobId);
}

export function writeRun(record: RunRecord): void {
	writeJsonAtomic(runFile(record.jobId, record.runId), record);
	pruneRunFiles(record.jobId, LIMITS.maxRunFilesPerJob);
}

/** 保留最近 N 个 run 文件（按 mtime），防止 runs/ 无界增长。 */
function pruneRunFiles(jobId: string, keep: number): void {
	const dir = runDir(jobId);
	if (!existsSync(dir)) return;
	try {
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		if (files.length <= keep) return;
		const stats = files
			.map((name) => {
				try {
					return { name, mtime: statSync(join(dir, name)).mtimeMs };
				} catch {
					return { name, mtime: 0 };
				}
			})
			.sort((a, b) => b.mtime - a.mtime);
		for (const stale of stats.slice(keep)) {
			try {
				unlinkSync(join(dir, stale.name));
			} catch {
				/* 忽略 */
			}
		}
	} catch {
		/* 裁剪失败不影响主流程 */
	}
}

export function readRun(jobId: string, runId: string): RunRecord | undefined {
	// 单个 run 文件读失败（EACCES/EBUSY）只应丢这一条，不应让整个历史接口 500
	try {
		return readJsonFile<RunRecord | undefined>(runFile(jobId, runId), undefined);
	} catch {
		return undefined;
	}
}

/** 跨 job 查找 run（HTTP /api/runs/:runId 用）。 */
export function findRun(runId: string, jobIds?: string[]): RunRecord | undefined {
	const ids = jobIds ?? listJobs().map((j) => j.id);
	for (const jobId of ids) {
		const record = readRun(jobId, runId);
		if (record) return record;
	}
	return undefined;
}

function compareRunsDesc(a: RunRecord, b: RunRecord): number {
	return b.startedAt.localeCompare(a.startedAt);
}

export function listRuns(jobId: string, limit: number = LIMITS.maxHistoryRows): RunRecord[] {
	const dir = runDir(jobId);
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	const records: RunRecord[] = [];
	for (const file of files) {
		const record = readJsonFile<RunRecord | undefined>(join(dir, file), undefined);
		if (record) records.push(record);
	}
	records.sort(compareRunsDesc);
	return records.slice(0, limit);
}

/** 全部任务的最新执行记录（按时间倒序，供总览）。 */
export function listAllRuns(limit: number = 50, jobIds?: string[]): RunRecord[] {
	const ids = jobIds ?? listJobs().map((j) => j.id);
	const records: RunRecord[] = [];
	for (const jobId of ids) records.push(...listRuns(jobId, limit));
	records.sort(compareRunsDesc);
	return records.slice(0, limit);
}

export function toRunSummary(record: RunRecord): RunSummary {
	const start = new Date(record.startedAt).getTime();
	const end = record.finishedAt ? new Date(record.finishedAt).getTime() : null;
	return {
		runId: record.runId,
		jobId: record.jobId,
		jobName: record.jobName,
		trigger: record.trigger,
		status: record.status,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		durationMs: end === null ? null : Math.max(0, end - start),
		model: record.model,
		permission: record.permission,
		tools: record.tools,
		sessionPath: record.sessionPath,
		command: record.command,
		forkOf: record.forkOf,
		summary: record.summary,
		error: record.error,
		usage: record.usage,
		toolCalls: record.toolCalls,
	};
}

// ── 台账 / 通知队列 ─────────────────────────────────────────

export function appendLedger(entry: LedgerEntry): void {
	ensureRoot();
	appendJsonLine(paths().ledgerFile, entry);
	trimFileLocked(paths().ledgerFile, LIMITS.maxLedgerLines);
}

/** 带锁裁剪（避免多进程同时重写同一文件而丢行）。 */
function trimFileLocked(file: string, maxLines: number): void {
	if (!existsSync(file)) return;
	let release: (() => void) | null = null;
	try {
		release = acquireFileLock(`${file}.trim.lock`, { timeoutMs: 500 });
	} catch {
		return; // 抢不到就跳过本次裁剪，下次再试
	}
	try {
		trimFile(file, maxLines);
	} finally {
		release?.();
	}
}

export function readLedger(limit: number = 100): LedgerEntry[] {
	return readJsonLines<LedgerEntry>(paths().ledgerFile, limit);
}

export function appendNotify(entry: NotifyEntry): void {
	ensureRoot();
	appendJsonLine(paths().notifyFile, entry);
	trimFileLocked(paths().notifyFile, 500);
}

export function readNotifications(limit: number = 50): NotifyEntry[] {
	return readJsonLines<NotifyEntry>(paths().notifyFile, limit);
}

// ── 会话转录（HTTP 详情用）───────────────────────────────────

export interface TranscriptEntry {
	id: string;
	role: string;
	text: string;
	toolName?: string;
	at?: string;
}

const MAX_TRANSCRIPT_ENTRIES = 200;
const MAX_TRANSCRIPT_TEXT = 8_000;

/**
 * 解析一个执行会话的 JSONL，产出精简转录（供面板展开历史）。
 * 只取 message / custom_message，忽略 compaction 等内部条目。
 */
export function readSessionTranscript(sessionPath: string, limit: number = MAX_TRANSCRIPT_ENTRIES): TranscriptEntry[] {
	if (!existsSync(sessionPath)) return [];
	let raw = "";
	try {
		raw = readFileSync(sessionPath, "utf8");
	} catch {
		return [];
	}
	const entries: TranscriptEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = parsed.type;
		if (type !== "message" && type !== "custom_message") continue;
		const message = (parsed.message ?? parsed) as {
			role?: string;
			content?: unknown;
			customType?: string;
		};
		const role = String(message.role ?? (type === "custom_message" ? "custom" : "unknown"));
		if (role === "toolResult") continue; // 工具输出噪音大，面板按需另取
		const text = extractText(message.content);
		if (!text) continue;
		entries.push({
			id: String(parsed.id ?? ""),
			role,
			text: text.length > MAX_TRANSCRIPT_TEXT ? `${text.slice(0, MAX_TRANSCRIPT_TEXT)}…(已截断)` : text,
			at: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
		});
	}
	return entries.slice(Math.max(0, entries.length - limit));
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; thinking?: string; name?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(`[thinking] ${b.thinking}`);
		else if (b.type === "toolCall" && typeof b.name === "string") parts.push(`[tool] ${b.name}`);
	}
	return parts.join("\n").trim();
}

export function isTerminalStatus(status: RunStatus): boolean {
	return status === "ok" || status === "error" || status === "timeout" || status === "aborted";
}

/** 清理某个 job 的运行目录（删除任务时用）。 */
export function purgeJobArtifacts(jobId: string): void {
	for (const dir of [runDir(jobId), sessionDir(jobId)]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 忽略 */
		}
	}
}
