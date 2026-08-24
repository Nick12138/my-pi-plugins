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
}
function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
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

/** 扫描所有 run 目录，返回 id 列表（按创建时间排序，新的在前） */
export function scanRuns(): string[] {
	try {
		return fs
			.readdirSync(RUNS_ROOT, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.filter((id) => fs.existsSync(taskPath(id)))
			.sort((a, b) => {
				const ta = readTask(a)?.createdAt ?? 0;
				const tb = readTask(b)?.createdAt ?? 0;
				return tb - ta;
			});
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

export function loadAllRuns(): RunRecord[] {
	return scanRuns()
		.map((id) => loadRun(id))
		.filter((r): r is RunRecord => r !== null);
}
