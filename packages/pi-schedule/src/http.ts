/**
 * 本地 HTTP 控制面（127.0.0.1），供 PiAbyss 面板 / 外部工具控制定时任务。
 *
 * 为什么用 HTTP 而不是只读文件：
 * - 控制（创建/立即执行/续聊）需要**即时**生效，文件轮询有延迟；
 * - 与 pi-subagent 的既有模式一致（面板读盘 + HTTP 控制）。
 *
 * 数据面仍然是文件：jobs.json / runs/*.json / sessions/*.jsonl 由 PiAbyss 直接读。
 */
import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createJob, deleteJob, describeJob, setEnabled, updateJob, type JobInput, type JobPatch } from "./jobs.ts";
import type { Scheduler } from "./scheduler.ts";
import { assertPermissionTier } from "./permissions.ts";
import {
	findRun,
	getJob,
	listAllRuns,
	listJobs,
	listRuns,
	paths,
	readLedger,
	readNotifications,
	readSessionTranscript,
	toRunSummary,
} from "./store.ts";
import { assertTimeoutOk, isValidTimezone, ScheduleError, systemTimezone } from "./schedule.ts";
import { cronHasFutureRun, parseCron } from "./cron.ts";
import { DEFAULTS, LIMITS, PORT_ENV, TOKEN_ENV, type Job, type Trigger } from "./types.ts";

const MAX_BODY_BYTES = 128 * 1024;

/**
 * 本地控制面的鉴权 token。
 *
 * 必要性：仅监听 127.0.0.1 **不是**安全边界——任意网页都能发起跨源请求
 * （简单请求免预检），若不加鉴权，一个恶意页面就能创建 full 权限任务 = 任意命令执行。
 * 所以：默认不允许跨源（不发 ACAO），且非 health 接口一律要求 token。
 * PiAbyss 侧读 `~/.pi/schedule/token` 并带上 `X-Pi-Schedule-Token` 头即可。
 */
export function resolveToken(): string {
	const fromEnv = process.env[TOKEN_ENV]?.trim();
	if (fromEnv) return fromEnv;
	const file = `${paths().root}/token`;
	try {
		if (existsSync(file)) {
			const existing = readFileSync(file, "utf8").trim();
			if (existing) return existing;
		}
	} catch {
		/* 读失败则重新生成 */
	}
	const token = randomBytes(24).toString("hex");
	try {
		writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
	} catch {
		/* 写不了就只在内存里生效 */
	}
	return token;
}

let authToken: string | null = null;

function token(): string {
	if (!authToken) authToken = resolveToken();
	return authToken;
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
	const body = JSON.stringify(data);
	// 不下发 Access-Control-Allow-Origin：浏览器默认跨源读不到响应。
	res.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(body);
}

function isLoopbackHost(host: string | undefined): boolean {
	if (!host) return false;
	const name = host.split(":")[0]?.toLowerCase() ?? "";
	return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * 鉴权规则：
 * - 头部 `X-Pi-Schedule-Token` 总是有效；
 * - `?token=` 仅对**只读 GET** 有效——写操作走 query 会被当成「简单请求」绕过 CORS 预检，
 *   属于 CSRF 面，故写操作必须用头部。
 */
function authorized(req: http.IncomingMessage, url: URL): boolean {
	const header = req.headers["x-pi-schedule-token"];
	const fromHeader = (Array.isArray(header) ? header[0] : header) ?? "";
	if (fromHeader && safeEqual(fromHeader, token())) return true;
	const isReadOnly = req.method === "GET" || req.method === "HEAD";
	if (!isReadOnly) return false;
	const fromQuery = url.searchParams.get("token") ?? "";
	return fromQuery.length > 0 && safeEqual(fromQuery, token());
}

function errorResponse(res: http.ServerResponse, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	// 单飞冲突 → 409（不是服务器错误，重试或等下一次即可）
	if (/正在执行中/.test(message)) {
		json(res, 409, { error: message });
		return;
	}
	const code = error instanceof ScheduleError ? 400 : 500;
	json(res, code, { error: message });
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	// 写操作必须声明 JSON：避免被当作 CORS「简单请求」绕过预检
	const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
	if (contentType && !contentType.includes("application/json")) {
		throw new ScheduleError("Content-Type 必须是 application/json");
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new ScheduleError(`请求体过大（>${MAX_BODY_BYTES} 字节）`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (!raw) return resolve({});
			try {
				const parsed = JSON.parse(raw) as unknown;
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					return reject(new ScheduleError("请求体必须是 JSON 对象"));
				}
				resolve(parsed as Record<string, unknown>);
			} catch {
				reject(new ScheduleError("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

/** 把 HTTP 传入的 trigger 归一为 Trigger。 */
function toTrigger(raw: unknown): Trigger {
	if (!raw || typeof raw !== "object") throw new ScheduleError("缺少 trigger 对象");
	const obj = raw as Record<string, unknown>;
	const type = String(obj.type ?? "");
	switch (type) {
		case "manual":
			return { type: "manual" };
		case "once": {
			const at = String(obj.at ?? "");
			if (!at) throw new ScheduleError("trigger.type=once 需要 at（ISO 时间）");
			return { type: "once", at };
		}
		case "interval": {
			const every = String(obj.every ?? "");
			if (!every) throw new ScheduleError("trigger.type=interval 需要 every（如 30m / 2h / 1d）");
			return { type: "interval", every };
		}
		case "cron": {
			const cron = String(obj.cron ?? "");
			if (!cron) throw new ScheduleError("trigger.type=cron 需要 cron（5 段表达式）");
			return { type: "cron", cron, timezone: obj.timezone ? String(obj.timezone) : undefined };
		}
		default:
			throw new ScheduleError(`trigger.type 非法：${type}（manual/once/interval/cron）`);
	}
}

function toJobInput(body: Record<string, unknown>): JobInput {
	return {
		name: String(body.name ?? ""),
		prompt: String(body.prompt ?? ""),
		cwd: String(body.cwd ?? process.cwd()),
		trigger: toTrigger(body.trigger),
		permission: body.permission ? (String(body.permission) as JobInput["permission"]) : undefined,
		model: body.model ? (body.model as JobInput["model"]) : null,
		missedWindow: body.missedWindow ? (String(body.missedWindow) as JobInput["missedWindow"]) : undefined,
		timeoutMs: body.timeoutMs === undefined ? undefined : Number(body.timeoutMs),
		maxRuns: body.maxRuns === undefined ? undefined : body.maxRuns === null ? null : Number(body.maxRuns),
		loadExtensions: body.loadExtensions === undefined ? undefined : Boolean(body.loadExtensions),
		tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t)) : undefined,
		enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
	};
}

function toJobPatch(body: Record<string, unknown>): JobPatch {
	const patch: JobPatch = {};
	if (body.name !== undefined) patch.name = String(body.name);
	if (body.prompt !== undefined) patch.prompt = String(body.prompt);
	if (body.cwd !== undefined) patch.cwd = String(body.cwd);
	if (body.trigger !== undefined) patch.trigger = toTrigger(body.trigger);
	if (body.permission !== undefined) patch.permission = String(body.permission) as JobPatch["permission"];
	if (body.model !== undefined) patch.model = body.model === null ? null : (body.model as JobPatch["model"]);
	if (body.missedWindow !== undefined) patch.missedWindow = String(body.missedWindow) as JobPatch["missedWindow"];
	if (body.timeoutMs !== undefined) patch.timeoutMs = Number(body.timeoutMs);
	if (body.maxRuns !== undefined) patch.maxRuns = body.maxRuns === null ? null : Number(body.maxRuns);
	if (body.loadExtensions !== undefined) patch.loadExtensions = Boolean(body.loadExtensions);
	if (body.tags !== undefined && Array.isArray(body.tags)) patch.tags = body.tags.map((t) => String(t));
	if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
	return patch;
}

let server: http.Server | null = null;

/**
 * 启动 HTTP 服务（进程级单例，幂等）。
 *
 * 返回实际监听端口；**监听失败会 reject**（不再谎报端口）。
 */
export function startHttpServer(scheduler: Scheduler, port = resolvePort()): Promise<number> {
	if (server) return Promise.resolve(actualPort(server));

	return new Promise<number>((resolve, reject) => {
		const instance = http.createServer((req, res) => {
			void handle(req, res, scheduler).catch((error: unknown) => errorResponse(res, error));
		});
		instance.once("error", (error: Error) => {
			server = null;
			reject(error);
		});
		instance.once("listening", () => {
			server = instance;
			resolve(actualPort(instance));
		});
		instance.listen(port, "127.0.0.1");
	});
}

export function stopHttpServer(): void {
	if (!server) return;
	try {
		server.close();
	} catch {
		/* 忽略 */
	}
	server = null;
}

export function resolvePort(): number {
	const raw = process.env[PORT_ENV]?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0 && parsed < 65_536) return parsed;
	}
	return DEFAULTS.httpPort;
}

export function serverPort(): number | null {
	return server ? actualPort(server) : null;
}

function actualPort(instance: http.Server): number {
	const address = instance.address();
	if (address && typeof address === "object") return address.port;
	return resolvePort();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, scheduler: Scheduler): Promise<void> {
	// 防 DNS rebinding：只接受回环 Host
	if (!isLoopbackHost(req.headers.host)) {
		json(res, 403, { error: "仅允许回环地址访问" });
		return;
	}

	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
	if (parts[0] !== "api") {
		json(res, 404, { error: "未知路径" });
		return;
	}
	const seg = parts.slice(1);

	// 预检不发 CORS 许可：跨源请求会被浏览器拦下（本面板是同源/本地客户端，不需要 CORS）
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const isHealth = seg[0] === "health" && seg.length === 1;
	if (!isHealth && !authorized(req, url)) {
		json(res, 401, {
			error: "缺少或错误的 token",
			hint: `读取 ${paths().root}/token，并通过 X-Pi-Schedule-Token 头传入`,
		});
		return;
	}

	// GET /api/health
	if (req.method === "GET" && seg[0] === "health" && seg.length === 1) {
		json(res, 200, {
			ok: true,
			root: paths().root,
			port: serverPort(),
			activeJobs: scheduler.activeJobIds(),
			tickMs: scheduler.status().tickMs,
			maxConcurrent: scheduler.status().maxConcurrent,
		});
		return;
	}

	// GET /api/cron/validate?cron=...&timezone=...
	if (req.method === "GET" && seg[0] === "cron" && seg[1] === "validate") {
		const cron = url.searchParams.get("cron") ?? "";
		const timezone = url.searchParams.get("timezone") ?? undefined;
		try {
			if (timezone && !isValidTimezone(timezone)) {
				json(res, 200, { valid: false, reason: `未知时区：${timezone}` });
				return;
			}
			const expr = parseCron(cron);
			const tz = timezone ?? systemTimezone();
			const valid = cronHasFutureRun(expr, new Date(), tz);
			json(res, 200, { valid, reason: valid ? null : "该表达式在 1500 天内不会触发" });
		} catch (error) {
			json(res, 200, { valid: false, reason: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// GET /api/jobs
	if (req.method === "GET" && seg[0] === "jobs" && seg.length === 1) {
		const jobs = listJobs();
		json(res, 200, {
			jobs,
			root: paths().root,
			activeJobs: scheduler.activeJobIds(),
			limits: { maxJobs: LIMITS.maxJobs },
		});
		return;
	}

	// POST /api/jobs
	if (req.method === "POST" && seg[0] === "jobs" && seg.length === 1) {
		const body = await readBody(req);
		const job = createJob(toJobInput(body), { by: String(body.by ?? "piabyss") });
		void scheduler.tick("tick").catch(() => undefined);
		json(res, 201, { job });
		return;
	}

	const jobId = seg[1];
	if (seg[0] === "jobs" && jobId) {
		const existing = getJob(jobId);
		// 除创建外，针对具体 job 的操作都要求它存在（返回 404，而不是 400/静默成功）
		if (!existing) {
			json(res, 404, { error: `任务不存在：${jobId}` });
			return;
		}
		// PATCH/POST /api/jobs/:id
		if ((req.method === "PATCH" || req.method === "POST") && seg.length === 2) {
			const body = await readBody(req);
			const job = updateJob(jobId, toJobPatch(body), { by: String(body.by ?? "piabyss") });
			void scheduler.tick("tick").catch(() => undefined);
			json(res, 200, { job });
			return;
		}
		// DELETE /api/jobs/:id?purge=1
		if (req.method === "DELETE" && seg.length === 2) {
			const purge = url.searchParams.get("purge") === "1";
			deleteJob(jobId, { by: "piabyss" }, { purgeArtifacts: purge });
			json(res, 200, { removed: true, purged: purge });
			return;
		}
		// GET /api/jobs/:id
		if (req.method === "GET" && seg.length === 2) {
			json(res, 200, { job: existing, description: describeJob(existing) });
			return;
		}
		// GET /api/jobs/:id/runs?limit=
		if (req.method === "GET" && seg[2] === "runs" && seg.length === 3) {
			const limit = clampLimit(url.searchParams.get("limit"));
			json(res, 200, { runs: listRuns(jobId, limit).map(toRunSummary) });
			return;
		}
		// POST /api/jobs/:id/run_now
		if (req.method === "POST" && seg[2] === "run_now") {
			const body = await readBody(req);
			// 覆盖参数必须校验：未知 permission 曾被当作「不传白名单」= full 权限（踩过）
			const permission = body.permission === undefined ? undefined : assertPermissionTier(String(body.permission));
			const timeoutMs =
				body.timeoutMs === undefined ? undefined : assertTimeoutOk(Number(body.timeoutMs));
			const record = await scheduler.trigger(existing, {
				trigger: "manual",
				permissionOverride: permission,
				timeoutMsOverride: timeoutMs,
			});
			json(res, 200, { run: toRunSummary(record) });
			return;
		}
		// POST /api/jobs/:id/enable | /disable
		if (req.method === "POST" && (seg[2] === "enable" || seg[2] === "disable")) {
			const job = setEnabled(jobId, seg[2] === "enable", { by: "piabyss" });
			json(res, 200, { job });
			return;
		}
	}

	// GET /api/runs?limit=
	if (req.method === "GET" && seg[0] === "runs" && seg.length === 1) {
		const limit = clampLimit(url.searchParams.get("limit"));
		json(res, 200, { runs: listAllRuns(limit).map(toRunSummary) });
		return;
	}

	// GET /api/runs/:runId  |  GET /api/runs/:runId/transcript
	const runId = seg[1];
	if (seg[0] === "runs" && runId) {
		const record = findRun(runId);
		if (!record) {
			json(res, 404, { error: `执行记录不存在：${runId}` });
			return;
		}
		if (req.method === "GET" && seg.length === 2) {
			json(res, 200, { run: record, summary: toRunSummary(record) });
			return;
		}
		if (req.method === "GET" && seg[2] === "transcript") {
			const entries = record.sessionPath ? readSessionTranscript(record.sessionPath) : [];
			json(res, 200, { runId, sessionPath: record.sessionPath, entries });
			return;
		}
		// POST /api/runs/:runId/reply  —— 续聊（fork 语义，源会话只读不改）
		if (req.method === "POST" && seg[2] === "reply") {
			const body = await readBody(req);
			const replyText = String(body.text ?? "").trim();
			if (!replyText) {
				json(res, 400, { error: "reply 需要 text" });
				return;
			}
			const job = getJob(record.jobId);
			if (!job) {
				json(res, 404, { error: `任务已被删除：${record.jobId}` });
				return;
			}
			if (!record.sessionPath || !existsSync(record.sessionPath)) {
				json(res, 409, { error: "该执行没有可续聊的会话文件（可能已被清理）" });
				return;
			}
			const next = await scheduler.trigger(job, {
				trigger: "reply",
				forkFromSessionPath: record.sessionPath,
				forkOfRunId: record.runId,
				replyText,
			});
			json(res, 200, { run: toRunSummary(next) });
			return;
		}
	}

	// GET /api/ledger?limit=
	if (req.method === "GET" && seg[0] === "ledger" && seg.length === 1) {
		json(res, 200, { entries: readLedger(clampLimit(url.searchParams.get("limit"))) });
		return;
	}

	// GET /api/notifications?limit=  |  (可选) DELETE 清空
	if (seg[0] === "notifications" && seg.length === 1) {
		if (req.method === "GET") {
			json(res, 200, { entries: readNotifications(clampLimit(url.searchParams.get("limit"))) });
			return;
		}
	}

	json(res, 404, { error: `未知接口：${req.method} /${parts.join("/")}` });
}

function clampLimit(raw: string | null): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 50;
	return Math.min(LIMITS.maxHistoryRows, parsed);
}
