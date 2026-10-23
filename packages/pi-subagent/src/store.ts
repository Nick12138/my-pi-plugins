/** 磁盘持久化：runs/<id>/ 下所有文件的读写。主 pi 退出后这些数据是唯一真相。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunRecord, RunResultData, RunStatusData, RunTask } from "./types.ts";

export const RUNS_ROOT = path.join(os.homedir(), ".pi", "subagent", "runs");

export function runDir(runId: string): string {
	return path.join(RUNS_ROOT, runId);
}

export function taskPath(runId: string): string {
	return path.join(runDir(runId), "task.json");
}
export function statusPath(runId: string): string {
	return path.join(runDir(runId), "status.json");
}
export function resultPath(runId: string): string {
	return path.join(runDir(runId), "result.json");
}
export function eventsPath(runId: string): string {
	return path.join(runDir(runId), "events.jsonl");
}
export function stderrPath(runId: string): string {
	return path.join(runDir(runId), "stderr.log");
}
export function sessionDir(runId: string): string {
	return path.join(runDir(runId), "sessions");
}

export function ensureRunDir(runId: string): void {
	fs.mkdirSync(runDir(runId), { recursive: true });
	fs.mkdirSync(sessionDir(runId), { recursive: true });
}

function writeJson(file: string, data: unknown): void {
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
	// 同一毫秒内同长度重写时 mtime+size 版本戳不会变，写入方必须显式失效。
	jsonCache.delete(file);
	versionMemo.delete(file);
}
/**
 * 读缓存：按 (mtimeMs, size) 失效。
 *
 * 宿主每 750ms 拉一次 /api/runs，每次都会把所有 run 的 task/status/result
 * 重新读一遍（88 个 run ≈ 34ms 同步 I/O/tick，实测占空闲 CPU 的 10%）。
 * 这些文件只在状态变化时被原子重写，所以 stat 一次比 open+read+parse 便宜得多。
 */
type JsonCacheEntry = { version: string; value: unknown };
const jsonCache = new Map<string, JsonCacheEntry>();

/**
 * 版本戳的短 TTL 记忆：同一次 poll 里 scanRuns 与 loadRun 会对同一个
 * task.json stat 两遍。150ms 内的重复 stat 直接复用（轮询间隔 750ms，
 * 这点滞后对面板无感，但把每 tick 的 stat 次数几乎砍半）。
 */
const VERSION_TTL_MS = 1500;
const versionMemo = new Map<string, { version: string | null; at: number }>();

/** 文件版本戳；不存在返回 null（同时清掉缓存项）。 */
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

/** 测试用：清空读缓存（外部直接改写文件而不改 mtime 时也用它）。 */
export function resetStoreCache(): void {
	jsonCache.clear();
	versionMemo.clear();
}

export function writeTask(task: RunTask): void {
	writeJson(taskPath(task.id), task);
}
export function readTask(runId: string): RunTask | null {
	return readJson<RunTask>(taskPath(runId));
}

export function writeStatus(runId: string, status: RunStatusData): void {
	writeJson(statusPath(runId), status);
}
export function readStatus(runId: string): RunStatusData | null {
	return readJson<RunStatusData>(statusPath(runId));
}

export function writeResult(runId: string, result: RunResultData): void {
	writeJson(resultPath(runId), result);
}
export function readResult(runId: string): RunResultData | null {
	return readJson<RunResultData>(resultPath(runId));
}

/** 追加一行原始 NDJSON 事件（子代理 stdout 流） */
export function appendEvent(runId: string, line: string): void {
	if (!line.trim()) return;
	fs.appendFileSync(eventsPath(runId), line + "\n", "utf-8");
}

/** 追加 stderr 原文 */
export function appendStderr(runId: string, chunk: string): void {
	if (!chunk) return;
	fs.appendFileSync(stderrPath(runId), chunk, "utf-8");
}

/** 读取 events.jsonl，支持 offset（跳过前 N 行）。返回行数组与总行数。 */
export function readEvents(runId: string, offset = 0): { lines: string[]; total: number } {
	try {
		const raw = fs.readFileSync(eventsPath(runId), "utf-8");
		const all = raw.split("\n").filter((l) => l.trim().length > 0);
		return { lines: all.slice(offset), total: all.length };
	} catch {
		return { lines: [], total: 0 };
	}
}

/** 扫描所有 run 目录，返回 id 列表（按创建时间排序，新的在前）。
 *
 * createdAt 先一次性读进 Map 再排序：旧实现在 sort 比较器里 readTask()，
 * 88 个 run 的排序会额外触发约 500 次 task.json 读取。 */
export function scanRuns(): string[] {
	try {
		const ids = fs
			.readdirSync(RUNS_ROOT, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
		const created = new Map<string, number>();
		for (const id of ids) {
			const task = readTask(id);
			if (task) created.set(id, typeof task.createdAt === "number" ? task.createdAt : 0);
		}
		return [...created.keys()].sort((a, b) => (created.get(b) ?? 0) - (created.get(a) ?? 0));
	} catch {
		return [];
	}
}

export function loadRun(runId: string): RunRecord | null {
	const task = readTask(runId);
	if (!task) return null;
	const status = readStatus(runId) ?? {
		status: "interrupted" as const,
		notified: false,
		resumeCount: 0,
		retryLeft: task.retry,
	};
	return { task, status, result: readResult(runId) ?? undefined };
}

/** 全部 run（新的在前）；limit 只截断返回条数，排序仍覆盖全部 run。 */
export function loadAllRuns(options: { limit?: number } = {}): RunRecord[] {
	const ids = scanRuns();
	const limited = options.limit && options.limit > 0 ? ids.slice(0, options.limit) : ids;
	return limited
		.map((id) => loadRun(id))
		.filter((r): r is RunRecord => r !== null);
}
