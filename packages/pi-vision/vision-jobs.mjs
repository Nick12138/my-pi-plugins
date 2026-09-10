/**
 * vision-jobs.mjs — pi-vision 异步任务库（跨会话持久任务记录，对标 pi-anytomd 的 jobs.mjs）。
 *
 * 与 anytomd 的关键差异：视觉分析必须依赖 pi 进程内的 modelRegistry（模型解析 / 认证 /
 * 自动回退），无法拆成独立 detached 进程，因此采用「进程内后台队列 + 磁盘持久化」：
 *   - 任务记录与结果落盘 ~/.pi/vision-jobs/，跨会话仍可 status/list/读取 result.md；
 *   - 但排队/运行中的任务随 pi 进程退出而终止 —— 下个会话读到时会自动 stale 标记 failed。
 *
 * 存储结构：
 *   ~/.pi/vision-jobs/
 *     jobs/
 *       <job-id>/
 *         job.json        元数据（状态、请求摘要、时间戳、pid；data URL 不落盘）
 *         result.md       最终分析文本（成功后写入）
 *         details.json    成功/失败的详细诊断（model、attempts、imageCount 等）
 *         heartbeat       心跳时间戳文件（运行期间每 15s 刷新）
 *
 * job.json 里的 request.images 只存引用摘要：文件路径按提交任务时的 cwd 解析；data URL 只存前缀
 * + 长度说明，真实数据仅存在于提交进程的内存中。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 任务库根目录；PI_VISION_JOBS_DIR 可覆盖（测试用）。 */
export const JOBS_ROOT = process.env.PI_VISION_JOBS_DIR?.trim()
	? path.resolve(process.env.PI_VISION_JOBS_DIR.trim())
	: path.join(os.homedir(), ".pi", "vision-jobs");
export const JOBS_DIR = path.join(JOBS_ROOT, "jobs");

mkdirSync(JOBS_DIR, { recursive: true });

export const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"];
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_STALE_MS = 5 * 60_000;
const JOB_ID_PATTERN = /^seejob_\d{8}_\d{6}_[a-z0-9]{4}$/;
const PROCESS_TOKEN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 只允许本模块生成的任务 ID，避免外部传入 ../ 导致任务目录路径穿越。 */
function safeJobDir(jobId) {
	if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return null;
	return path.join(JOBS_DIR, jobId);
}

function generateJobId() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6);
	return `seejob_${ts}_${rand}`;
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

/** 心跳落盘（运行期间由扩展层的定时器调用）。 */
export function touchHeartbeat(jobId) {
	const jobDir = safeJobDir(jobId);
	if (!jobDir) return;
	try {
		writeFileSync(path.join(jobDir, "heartbeat"), String(Date.now()), "utf-8");
	} catch {
		// ignore
	}
}

/**
 * 任务引用摘要：文件路径保留绝对路径；data URL 不落盘，只记录前缀与体量。
 */
export function redactImageRef(imageRef) {
	const dataUrl = /^data:([^;,]+);base64,/.exec(imageRef ?? "");
	if (dataUrl) {
		return `data:${dataUrl[1]};base64,<${imageRef.length} 字符 base64 数据未落盘>`;
	}
	return imageRef;
}

/**
 * 读单个 job.json 并做 stale 检测：
 *   - 状态非终态但记录的 pid 不是当前进程 → 提交时的 pi 进程已退出，任务不可能再跑 → failed；
 *   - 同进程但心跳超期 5 分钟（异常悬挂兜底）→ failed。
 * 检测到 stale 时回写 job.json 并返回更新后的元数据。
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

	if (!TERMINAL_STATUSES.includes(meta.status)) {
		let staleReason;
		if (meta.pid !== process.pid || meta.processToken !== PROCESS_TOKEN) {
			staleReason = "提交任务的 pi 进程已退出（视觉分析无法跨进程续跑，stale 检测触发）";
		} else if (meta.status === "running" && meta.pid === process.pid && meta.processToken === PROCESS_TOKEN) {
			try {
				const hbPath = path.join(jobDir, "heartbeat");
				if (existsSync(hbPath)) {
					const hbTime = parseInt(readFileSync(hbPath, "utf-8"), 10);
					if (Number.isFinite(hbTime) && Date.now() - hbTime > HEARTBEAT_STALE_MS) {
						staleReason = "任务心跳超时（同进程内异常悬挂，stale 检测触发）";
					}
				}
			} catch {
				// ignore
			}
		}
		if (staleReason) {
			meta.status = "failed";
			meta.finishedAt = new Date().toISOString();
			meta.error = staleReason;
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
 * 创建任务记录（status=queued），返回 { jobId, jobDir, meta }。
 * request 中的 images 引用在落盘前做 redact 处理。
 */
export function createJob(request) {
	const jobId = generateJobId();
	const jobDir = safeJobDir(jobId);
	// jobId is generated internally; this guard also protects future refactors.
	if (!jobDir) throw new Error("生成了无效的视觉任务 ID");
	mkdirSync(jobDir, { recursive: true });

	const meta = {
		id: jobId,
		status: "queued",
		createdAt: new Date().toISOString(),
		pid: process.pid,
		processToken: PROCESS_TOKEN,
		request: {
			images: (request.images ?? []).map(redactImageRef),
			prompt: request.prompt ?? "",
			model: request.model ?? undefined,
		},
	};

	writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(meta, null, 2), "utf-8");
	return { jobId, jobDir, meta };
}

/**
 * 更新任务元数据。终态保护：任务已是终态时拒绝整个更新（防止取消后
 * 后台收尾协程覆盖为 succeeded/failed 或补写过期字段）。
 */
export function updateJob(jobId, patch) {
	const jobDir = safeJobDir(jobId);
	if (!jobDir) return null;
	const jobJsonPath = path.join(jobDir, "job.json");
	let meta;
	try {
		meta = JSON.parse(readFileSync(jobJsonPath, "utf-8"));
	} catch {
		return null;
	}

	if (patch.status && patch.status !== meta.status) {
		if (TERMINAL_STATUSES.includes(meta.status)) return { ...meta, jobDir, skipped: true };
		meta.status = patch.status;
	}
	for (const [key, value] of Object.entries(patch)) {
		if (key === "status") continue;
		if (value === undefined) continue;
		meta[key] = value;
	}

	try {
		writeFileSync(jobJsonPath, JSON.stringify(meta, null, 2), "utf-8");
	} catch {
		// ignore
	}
	return { ...meta, jobDir };
}

/** 写入结果与分析诊断（由扩展层在任务收尾时调用）。 */
export function writeJobResult(jobId, { text, details }) {
	const jobDir = safeJobDir(jobId);
	if (!jobDir) return;
	try {
		if (typeof text === "string" && text.length > 0) {
			writeFileSync(path.join(jobDir, "result.md"), text, "utf-8");
		}
		if (details) {
			writeFileSync(path.join(jobDir, "details.json"), JSON.stringify(details, null, 2), "utf-8");
		}
	} catch {
		// ignore
	}
}

/**
 * 将任务标记为取消。仅对非终态任务生效；返回 { ok, status, error? }。
 * 运行中的任务由扩展层据此触发 AbortController。
 */
export function cancelJob(jobId) {
	const meta = readJob(jobId);
	if (!meta) return { ok: false, error: `任务不存在: ${jobId}` };
	if (TERMINAL_STATUSES.includes(meta.status)) {
		return { ok: false, error: `任务已处于终态（${meta.status}），无法取消` };
	}
	updateJob(jobId, { status: "cancelled", finishedAt: new Date().toISOString(), error: "用户取消" });
	return { ok: true, jobId, status: "cancelled" };
}

/**
 * 轮询等待任务到达终态。
 */
export async function waitJob(jobId, timeoutSec = 600) {
	const start = Date.now();
	const maxMs = timeoutSec * 1000;

	while (Date.now() - start < maxMs) {
		const job = readJob(jobId);
		if (!job) return { ok: false, error: `任务不存在: ${jobId}` };
		if (TERMINAL_STATUSES.includes(job.status)) {
			return { ok: job.status === "succeeded", job };
		}
		await new Promise((r) => setTimeout(r, 800));
	}

	const cur = readJob(jobId);
	return { ok: false, error: `等待超时（${timeoutSec} 秒），任务仍在后台`, job: cur };
}

/**
 * 列出最近任务（按提交时间倒序），可按状态过滤。
 */
export function listJobs(limit = 20, statusFilter = null) {
	if (!existsSync(JOBS_DIR)) return [];
	const jobs = [];
	for (const id of readdirSync(JOBS_DIR)) {
		const meta = readJob(id);
		if (!meta) continue;
		if (statusFilter && meta.status !== statusFilter) continue;
		jobs.push(meta);
	}
	jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	return jobs.slice(0, Math.max(1, limit));
}

/** 心跳刷新间隔（扩展层设置定时器用）。 */
export const HEARTBEAT_MS = HEARTBEAT_INTERVAL_MS;
