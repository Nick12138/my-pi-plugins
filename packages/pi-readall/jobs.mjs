/**
 * jobs.mjs — pi-readall 异步任务管理器（跨会话持久任务库，继承 pi-anytomd 的 jobs.mjs 设计）。
 *
 * 存储结构：
 *   ~/.pi/readall-jobs/
 *     jobs/
 *       <job-id>/
 *         job.json        元数据（状态、参数、时间戳、pid，不含密码）
 *         result.md       最终产物 Markdown（成功后写入）
 *         details.json    详细诊断信息
 *         worker.log      worker 执行日志
 *         heartbeat       心跳时间戳文件
 *         cancel.flag     取消标志文件（存在即取消）
 *
 * 语义：
 *   - submit : 提交任务（立即返回 job-id，后台独立进程运行，跨会话存活）
 *   - status : 查看单个任务状态（含 stale 检测：进程死亡自动标记 failed）
 *   - wait   : 轮询等待直到终态（succeeded/failed/cancelled）
 *   - cancel : 取消任务（taskkill 杀进程树 + 标记 cancelled）
 *   - list   : 列出最近任务（按时间倒序）
 *
 * 注意：异步 job 跑在分离进程里，没有视觉模型兜底（见 worker.mjs 头注释）；
 *       批量图片 + 视觉兜底场景请用同步 read 分批执行。
 */

import { spawnSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	openSync,
	closeSync,
	rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "worker.mjs");

export const JOBS_ROOT = process.env.READALL_JOBS_DIR?.trim()
	? path.resolve(process.env.READALL_JOBS_DIR.trim())
	: path.join(os.homedir(), ".pi", "readall-jobs");
export const JOBS_DIR = path.join(JOBS_ROOT, "jobs");

mkdirSync(JOBS_DIR, { recursive: true });

const JOB_ID_PATTERN = /^readjob_\d{8}_\d{6}_[a-z0-9]{4}$/;

function generateJobId() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6);
	return `readjob_${ts}_${rand}`;
}

function safeJobDir(jobId) {
	if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return null;
	return path.join(JOBS_DIR, jobId);
}

export function isProcessAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function killProcessTree(pid) {
	if (!pid) return;
	try {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
	} catch {
		// ignore
	}
}

/**
 * 读单个 job.json 并做 stale 检测：
 *   状态为 running 但记录的 pid 已死 → 标记 failed（提交时的进程可能已退出）。
 */
export function readJob(jobId) {
	const jobDir = safeJobDir(jobId);
	if (!jobDir) return null;
	const jobJsonPath = path.join(jobDir, "job.json");
	if (!existsSync(jobJsonPath)) return null;

	let meta;
	try {
		meta = JSON.parse(readFileSync(jobJsonPath, "utf-8"));
	} catch {
		return null;
	}

	if (meta.status === "running" && meta.pid && !isProcessAlive(meta.pid)) {
		meta.status = "failed";
		meta.finishedAt = new Date().toISOString();
		meta.error = "worker 进程已终止（stale 检测触发）";
		try {
			writeFileSync(jobJsonPath, JSON.stringify(meta, null, 2), "utf-8");
		} catch {
			// ignore
		}
	}

	return { ...meta, jobDir };
}

/**
 * 提交任务（异步）。返回 { jobId, status, jobDir }
 */
export function submitJob(opts) {
	const { paths, password, method, range, outputPath, workspace } = opts;

	const allPaths = paths || [];
	if (!allPaths.length) throw new Error("缺少输入文件路径（paths）");

	const jobId = generateJobId();
	const jobDir = path.join(JOBS_DIR, jobId);
	mkdirSync(jobDir, { recursive: true });

	const jobJsonPath = path.join(jobDir, "job.json");
	const logPath = path.join(jobDir, "worker.log");

	// 密码绝不写入 job.json
	const meta = {
		id: jobId,
		status: "queued",
		createdAt: new Date().toISOString(),
		spec: {
			paths: allPaths,
			method,
			range,
			outputPath,
			workspace: workspace || process.cwd(),
		},
	};

	writeFileSync(jobJsonPath, JSON.stringify(meta, null, 2), "utf-8");

	const logFd = openSync(logPath, "a");
	const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	if (password) childEnv.READALL_JOB_PASSWORD = password;

	const child = spawn(process.execPath, [WORKER_SCRIPT, "--job", jobDir], {
		detached: true,
		windowsHide: true,
		stdio: ["ignore", logFd, logFd],
		env: childEnv,
		cwd: workspace || process.cwd(),
	});
	child.unref();
	// 子进程已继承了句柄，父进程不关会每提交一次泄一个 fd
	try {
		closeSync(logFd);
	} catch {
		// ignore
	}

	// 顺手回收旧任务目录，避免 ~/.pi/readall-jobs 无限长大
	try {
		pruneJobs();
	} catch {
		// 回收失败不影响提交
	}

	return { jobId, status: "queued", jobDir };
}

export function cancelJob(jobId) {
	const jobDir = safeJobDir(jobId);
	if (!jobDir) return { ok: false, error: `非法任务 id: ${jobId}` };
	const meta = readJob(jobId);
	if (!meta) return { ok: false, error: `任务不存在: ${jobId}` };

	// 已经跑完的任务不要被「取消」覆写成 cancelled（会让人以为没产物）
	if (["succeeded", "failed", "cancelled"].includes(meta.status)) {
		return { ok: false, error: `任务已处于终态（${meta.status}），无需取消`, job: meta };
	}

	try {
		writeFileSync(path.join(jobDir, "cancel.flag"), "1", "utf-8");
	} catch {
		// ignore
	}

	if (meta.pid && isProcessAlive(meta.pid)) {
		killProcessTree(meta.pid);
	}

	meta.status = "cancelled";
	meta.finishedAt = new Date().toISOString();
	meta.error = "用户取消";
	writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(meta, null, 2), "utf-8");

	return { ok: true, jobId, status: "cancelled" };
}

export async function waitJob(jobId, timeoutSec = 600) {
	const start = Date.now();
	const maxMs = timeoutSec * 1000;

	while (Date.now() - start < maxMs) {
		const job = readJob(jobId);
		if (!job) return { ok: false, error: `任务不存在: ${jobId}` };

		if (["succeeded", "failed", "cancelled"].includes(job.status)) {
			return { ok: job.status === "succeeded", job };
		}
		await new Promise((r) => setTimeout(r, 1000));
	}

	const cur = readJob(jobId);
	return { ok: false, error: `等待超时（${timeoutSec} 秒），任务仍在后台运行`, job: cur };
}

/**
 * 回收旧任务目录：默认保留最近 7 天且最多 50 条（环境变量 READALL_JOBS_KEEP_DAYS / READALL_JOBS_KEEP_MAX）。
 * 只删终态（succeeded/failed/cancelled）且超期或超量的，运行中的任务绝不碰。
 * @returns {{ removed: number }}
 */
export function pruneJobs(opts = {}) {
	const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : parseInt(process.env.READALL_JOBS_KEEP_DAYS || "7", 10);
	const keepMax = Number.isFinite(opts.keepMax) ? opts.keepMax : parseInt(process.env.READALL_JOBS_KEEP_MAX || "50", 10);
	if (!existsSync(JOBS_DIR)) return { removed: 0 };

	const metas = [];
	for (const id of readdirSync(JOBS_DIR)) {
		const meta = readJob(id);
		if (meta) metas.push(meta);
	}
	metas.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

	const now = Date.now();
	const maxAgeMs = (Number.isFinite(keepDays) ? keepDays : 7) * 24 * 3600 * 1000;
	let removed = 0;
	metas.forEach((meta, index) => {
		if (!["succeeded", "failed", "cancelled"].includes(meta.status)) return;
		const tooOld = now - new Date(meta.createdAt).getTime() > maxAgeMs;
		const tooMany = index >= (Number.isFinite(keepMax) ? keepMax : 50);
		if (!tooOld && !tooMany) return;
		try {
			rmSync(meta.jobDir, { recursive: true, force: true });
			removed++;
		} catch {
			// ignore
		}
	});
	return { removed };
}

export function listJobs(limit = 20) {
	if (!existsSync(JOBS_DIR)) return [];
	const entries = readdirSync(JOBS_DIR);
	const jobs = [];

	for (const id of entries) {
		const meta = readJob(id);
		if (!meta) continue;
		jobs.push(meta);
	}

	jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	return jobs.slice(0, limit);
}
