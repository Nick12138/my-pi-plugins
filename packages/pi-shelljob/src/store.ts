/** 磁盘持久化：~/.pi/shelljob/jobs/<id>/ 下 job.json / status.json / output.log。
 * 主 pi 退出后这些文件是唯一真相，重启后据此接管遗留任务、补发通知。
 * 测试可用 SHELLJOB_JOBS_ROOT 重定向到临时目录：与运行中的宿主共享同一目录时，
 * 宿主的监控循环会把测试任务误判为僵尸接管、通知路由也会串台。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const JOBS_ROOT = process.env.SHELLJOB_JOBS_ROOT?.trim() || path.join(os.homedir(), ".pi", "shelljob", "jobs");

/** 默认单任务日志保护上限（超过后保护性 kill，防失控输出塞满磁盘） */
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface ShellJob {
	id: string;
	title: string;
	command: string;
	cwd: string;
	/** 单任务超时（毫秒），超时自动 kill；undefined = 不限（用全局默认） */
	timeoutMs?: number;
	/** 发起会话 id：通知路由 / shell_wait 归属过滤以此为准 */
	sessionId?: string;
	createdAt: number;
}

export type ShellJobStatus = "running" | "succeeded" | "failed" | "killed" | "interrupted";

export interface ShellJobStatusData {
	status: ShellJobStatus;
	pid?: number;
	exitCode?: number;
	startedAt: number;
	finishedAt?: number;
	/** 终态通知已投递确认 */
	notified?: boolean;
	/** 因超时被 kill */
	timedOut?: boolean;
	/** killed 来源："user" = 用户界面手动停止，"agent" = agent 主动 kill；仅 status 为 killed 时有意义 */
	killedBy?: "user" | "agent";
	errorMessage?: string;
}

export interface ShellJobRecord {
	job: ShellJob;
	status: ShellJobStatusData;
}

export function jobDir(jobId: string): string {
	return path.join(JOBS_ROOT, jobId);
}

export function jobPath(jobId: string): string {
	return path.join(jobDir(jobId), "job.json");
}

export function statusPath(jobId: string): string {
	return path.join(jobDir(jobId), "status.json");
}

export function outputPath(jobId: string): string {
	return path.join(jobDir(jobId), "output.log");
}

export function ensureJobDir(jobId: string): void {
	fs.mkdirSync(jobDir(jobId), { recursive: true });
}

function writeJson(file: string, data: unknown): void {
	// 原子写（临时文件 + rename）：崩溃/断电时不会留下半截 JSON 导致任务“消失”
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tmp, file);
		// 同毫秒同长度重写时 mtime+size 版本戳不会变，写入方必须显式失效。
		jsonCache.delete(file);
		versionMemo.delete(file);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* 清理失败不影响主流程 */
		}
		throw err;
	}
}

/**
 * 读缓存：按 (mtimeMs, size) 失效。
 *
 * 监控循环每 2s 把全部 job 的 job.json/status.json 读一遍（loadAllJobs 一次、
 * enforceLogLimits 与 takeoverOrphans 各一次），宿主侧 shelljob-watcher 还每 2s
 * 全量 reread 一遍。文件只在状态变化时被原子重写，stat 比 open+parse 便宜得多。
 */
type JsonCacheEntry = { version: string; value: unknown };
const jsonCache = new Map<string, JsonCacheEntry>();

/** 版本戳短 TTL：同一次 loadAllJobs 里 scanJobs 与 loadJobRecord 会重复 stat。 */
const VERSION_TTL_MS = 1500;
const versionMemo = new Map<string, { version: string | null; at: number }>();

function jsonFileVersion(file: string): string | null {
	const now = Date.now();
	const memo = versionMemo.get(file);
	if (memo && now - memo.at < VERSION_TTL_MS) return memo.version;
	let version: string | null = null;
	try {
		const stat = fs.statSync(file);
		version = `${stat.mtimeMs}:${stat.size}`;
	} catch {
		version = null;
		jsonCache.delete(file);
	}
	versionMemo.set(file, { version, at: now });
	return version;
}

function readJson<T>(file: string): T | null {
	const version = jsonFileVersion(file);
	if (version === null) return null;
	const cached = jsonCache.get(file);
	if (cached && cached.version === version) return cached.value as T | null;
	let value: T | null = null;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		value = null;
	}
	jsonCache.set(file, { version, value });
	return value;
}

/** 测试/外部改写后清空读缓存。 */
export function resetStoreCache(): void {
	jsonCache.clear();
	versionMemo.clear();
}

export function writeJob(job: ShellJob): void {
	writeJson(jobPath(job.id), job);
}

export function readJob(jobId: string): ShellJob | null {
	return readJson<ShellJob>(jobPath(jobId));
}

export function writeStatus(jobId: string, status: ShellJobStatusData): void {
	writeJson(statusPath(jobId), status);
}

export function readStatus(jobId: string): ShellJobStatusData | null {
	return readJson<ShellJobStatusData>(statusPath(jobId));
}

/** 读取日志尾部。maxLines 上限 2000。 */
export function readOutputTail(jobId: string, maxLines: number): { lines: string[]; total: number } {
	const limit = Math.max(1, Math.min(2000, maxLines));
	try {
		const raw = fs.readFileSync(outputPath(jobId), "utf-8");
		const all = raw.split("\n");
		if (all.length > 0 && all[all.length - 1] === "") all.pop();
		return { lines: all.slice(-limit), total: all.length };
	} catch {
		return { lines: [], total: 0 };
	}
}

/** 当前日志文件大小（字节）；文件不存在返回 0 */
export function outputLogSize(jobId: string): number {
	try {
		return fs.statSync(outputPath(jobId)).size;
	} catch {
		return 0;
	}
}

/** 扫描所有 job 目录，按创建时间倒序 */
export function scanJobs(): string[] {
	try {
		const ids = fs
			.readdirSync(JOBS_ROOT, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
		// createdAt 先读进 Map 再排序：旧实现在 sort 比较器里 readJob()，
		// 目录越多，额外 I/O 越多（99 个 job ≈ 600 次 job.json 读取/tick）。
		const created = new Map<string, number>();
		for (const id of ids) {
			const job = readJob(id);
			if (job) created.set(id, typeof job.createdAt === "number" ? job.createdAt : 0);
		}
		return [...created.keys()].sort((a, b) => (created.get(b) ?? 0) - (created.get(a) ?? 0));
	} catch {
		return [];
	}
}

export function loadJobRecord(jobId: string): ShellJobRecord | null {
	const job = readJob(jobId);
	if (!job) return null;
	const status = readStatus(jobId);
	if (!status) return null;
	return { job, status };
}

export function loadAllJobs(): ShellJobRecord[] {
	return scanJobs()
		.map((id) => loadJobRecord(id))
		.filter((r): r is ShellJobRecord => r !== null);
}

/** 终态判定 */
export function isTerminal(status: ShellJobStatusData): boolean {
	return status.status !== "running";
}

export function STATUS_LABEL(status: ShellJobStatus): string {
	switch (status) {
		case "running":
			return "运行中";
		case "succeeded":
			return "已完成";
		case "failed":
			return "失败";
		case "killed":
			return "已终止";
		case "interrupted":
			return "已中断";
	}
}
