/** 磁盘持久化：~/.pi/shelljob/jobs/<id>/ 下 job.json / status.json / output.log。
 * 主 pi 退出后这些文件是唯一真相，重启后据此接管遗留任务、补发通知。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const JOBS_ROOT = path.join(os.homedir(), ".pi", "shelljob", "jobs");

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
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
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
		return fs
			.readdirSync(JOBS_ROOT, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.filter((id) => fs.existsSync(jobPath(id)))
			.sort((a, b) => (readJob(b)?.createdAt ?? 0) - (readJob(a)?.createdAt ?? 0));
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
