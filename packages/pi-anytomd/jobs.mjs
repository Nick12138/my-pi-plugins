/**
 * jobs.mjs — AnyToMD 异步任务管理器（跨会话持久任务库）。
 *
 * 存储结构：
 *   ~/.pi/anytomd-jobs/
 *     jobs/
 *       <job-id>/
 *         job.json        元数据（状态、参数、时间戳、pid，不含密码）
 *         result.md       最终产物 Markdown（成功后写入）
 *         details.json    详细诊断信息
 *         worker.log      worker 执行日志
 *         heartbeat       心跳时间戳文件
 *         cancel.flag     取消标志文件（存在即取消）
 *
 * 核心对标 myagents-anydoc：
 *   - submit : 提交任务（立即返回 job-id，后台独立进程运行，跨会话存活）
 *   - status : 查看单个任务状态（含 stale 检测：心跳超期/PID死亡自动标记 failed）
 *   - wait   : 轮询等待直到终态（succeeded/failed/cancelled）
 *   - cancel : 取消任务（taskkill 杀进程树 + 标记 cancelled）
 *   - list   : 列出最近任务（按时间倒序）
 */

import { spawnSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	rmSync,
	openSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "worker.mjs");

export const JOBS_ROOT = path.join(os.homedir(), ".pi", "anytomd-jobs");
export const JOBS_DIR = path.join(JOBS_ROOT, "jobs");

// 确保根目录存在
mkdirSync(JOBS_DIR, { recursive: true });

function generateJobId() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6);
	return `job_${ts}_${rand}`;
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

/**
 * 杀死 Windows 进程树（taskkill /PID <pid> /T /F）。
 */
export function killProcessTree(pid) {
	if (!pid) return;
	try {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
	} catch {
		// ignore
	}
}

/**
 * 读单个 job.json 并做 stale 检测。
 */
export function readJob(jobId) {
	const jobDir = path.join(JOBS_DIR, jobId);
	const jobJsonPath = path.join(jobDir, "job.json");
	if (!existsSync(jobJsonPath)) return null;

	let meta;
	try {
		meta = JSON.parse(readFileSync(jobJsonPath, "utf-8"));
	} catch {
		return null;
	}

	// stale 判定：状态为 running 但心跳超期（>60s）且进程已死
	if (meta.status === "running") {
		const hbPath = path.join(jobDir, "heartbeat");
		let isDead = false;
		if (meta.pid && !isProcessAlive(meta.pid)) {
			isDead = true;
		} else if (existsSync(hbPath)) {
			try {
				const hbTime = parseInt(readFileSync(hbPath, "utf-8"), 10);
				if (Date.now() - hbTime > 60_000) {
					isDead = !isProcessAlive(meta.pid);
				}
			} catch {
				// ignore
			}
		}
		if (isDead) {
			meta.status = "failed";
			meta.finishedAt = new Date().toISOString();
			meta.error = "worker 进程已终止（stale 检测触发）";
			try {
				writeFileSync(jobJsonPath, JSON.stringify(meta, null, 2), "utf-8");
			} catch {
				// ignore
			}
		}
	}

	return { ...meta, jobDir };
}

/**
 * 提交任务（异步）。
 * 返回 { jobId, status, jobDir }
 */
export function submitJob(opts) {
	const {
		file,
		paths,
		password,
		method,
		accuracy,
		concurrency,
		range,
		outputPath,
		workspace,
	} = opts;

	const allPaths = paths || (file ? [file] : []);
	if (!allPaths.length) throw new Error("缺少输入文件路径（file 或 paths）");

	const jobId = generateJobId();
	const jobDir = path.join(JOBS_DIR, jobId);
	mkdirSync(jobDir, { recursive: true });

	const jobJsonPath = path.join(jobDir, "job.json");
	const logPath = path.join(jobDir, "worker.log");

	// 注意：密码绝不写入 job.json
	const meta = {
		id: jobId,
		status: "queued",
		createdAt: new Date().toISOString(),
		spec: {
			paths: allPaths,
			method,
			accuracy,
			concurrency,
			range,
			outputPath,
			workspace: workspace || process.cwd(),
		},
	};

	writeFileSync(jobJsonPath, JSON.stringify(meta, null, 2), "utf-8");

	// 启动分离式后台 worker
	const logFd = openSync(logPath, "a");
	const childEnv = {
		...process.env,
		ELECTRON_RUN_AS_NODE: "1",
	};
	if (password) {
		childEnv.ANYTOMD_JOB_PASSWORD = password;
	}

	const child = spawn(process.execPath, [WORKER_SCRIPT, "--job", jobDir], {
		detached: true,
		windowsHide: true,
		stdio: ["ignore", logFd, logFd],
		env: childEnv,
		cwd: workspace || process.cwd(),
	});
	child.unref();

	return { jobId, status: "queued", jobDir };
}

/**
 * 取消任务。
 */
export function cancelJob(jobId) {
	const jobDir = path.join(JOBS_DIR, jobId);
	const meta = readJob(jobId);
	if (!meta) return { ok: false, error: `任务不存在: ${jobId}` };

	// 写入取消标志文件
	const cancelFlag = path.join(jobDir, "cancel.flag");
	writeFileSync(cancelFlag, "1", "utf-8");

	// 如果正在运行，强杀进程树
	if (meta.pid && isProcessAlive(meta.pid)) {
		killProcessTree(meta.pid);
	}

	meta.status = "cancelled";
	meta.finishedAt = new Date().toISOString();
	meta.error = "用户取消";
	const jobJsonPath = path.join(jobDir, "job.json");
	writeFileSync(jobJsonPath, JSON.stringify(meta, null, 2), "utf-8");

	return { ok: true, jobId, status: "cancelled" };
}

/**
 * 等待任务到达终态。
 */
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
 * 列出最近任务。
 */
export function listJobs(limit = 20, statusFilter = null) {
	if (!existsSync(JOBS_DIR)) return [];
	const entries = readdirSync(JOBS_DIR);
	const jobs = [];

	for (const id of entries) {
		const meta = readJob(id);
		if (!meta) continue;
		if (statusFilter && meta.status !== statusFilter) continue;
		jobs.push(meta);
	}

	jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	return jobs.slice(0, limit);
}
