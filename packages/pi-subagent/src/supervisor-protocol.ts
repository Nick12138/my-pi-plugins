/** supervisor 文件信箱协议：子代理(contact_supervisor) ↔ 主代理(subagent_supervisor) 的跨进程通道。
 *
 * 消息载体是文件系统（%TEMP%/pi-subagent-supervisor-channels/<runId>-<agent>/），
 * 与子代理进程完全解耦：子代理写 requests/<uuid>.json，主代理写 replies/<uuid>.json。
 * 子代理侧通过环境变量获得通道目录与主会话元数据（见 runner.ts spawnChild）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── 常量 ────────────────────────────────────────────────────

export const SUPERVISOR_CHANNEL_ROOT = path.join(os.tmpdir(), "pi-subagent-supervisor-channels");

export const REQUESTS_DIR = "requests";
export const REPLIES_DIR = "replies";

/** 注入子代理的环境变量 */
export const ENV_CHANNEL_DIR = "PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR";
export const ENV_ORCHESTRATOR_SESSION_ID = "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID";
export const ENV_RUN_ID = "PI_SUBAGENT_RUN_ID";
export const ENV_CHILD_AGENT = "PI_SUBAGENT_CHILD_AGENT";
export const ENV_SUPERVISOR_TIMEOUT_MS = "PI_SUBAGENT_SUPERVISOR_TIMEOUT_MS";

/** 工具名 */
export const SUPERVISOR_TOOL_CLIENT = "contact_supervisor";
export const SUPERVISOR_TOOL_SERVER = "subagent_supervisor";

export const DEFAULT_SUPERVISOR_TIMEOUT_MS = 10 * 60 * 1000; // 等回复超时
export const WAIT_REPLY_POLL_MS = 250; // 子代理轮询回复
export const SERVER_POLL_MS = 500; // 主代理扫描请求
const MAX_MESSAGE_BYTES = 64 * 1024;

export type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

// ── 消息结构 ────────────────────────────────────────────────

export interface SupervisorRequest {
	type: "subagent.supervisor.request";
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: SupervisorReason;
	message: string;
	expectsReply: boolean;
	orchestratorSessionId: string;
	runId: string;
	agent: string;
	childIndex: number;
	interview?: unknown;
}

export interface SupervisorReply {
	type: "subagent.supervisor.reply";
	requestId: string;
	createdAt: number;
	message: string;
}

// ── 路径与工具函数 ──────────────────────────────────────────

export function safeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function channelDir(runId: string, agent: string, childIndex = 0): string {
	return path.join(SUPERVISOR_CHANNEL_ROOT, `${safeSegment(runId)}-${safeSegment(agent)}-${childIndex}`);
}

export function ensureChannelDir(dir: string): void {
	fs.mkdirSync(path.join(dir, REQUESTS_DIR), { recursive: true });
	fs.mkdirSync(path.join(dir, REPLIES_DIR), { recursive: true });
}

export function requestPath(dir: string, requestId: string): string {
	return path.join(dir, REQUESTS_DIR, `${safeSegment(requestId)}.json`);
}

export function replyPath(dir: string, requestId: string): string {
	return path.join(dir, REPLIES_DIR, `${safeSegment(requestId)}.json`);
}

/** 原子写 JSON：先写 .tmp 再 rename，避免读者看到半写文件。 */
export function writeAtomicJson(file: string, data: unknown): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

export function supervisorTimeoutMs(): number {
	const parsed = Number(process.env[ENV_SUPERVISOR_TIMEOUT_MS]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUPERVISOR_TIMEOUT_MS;
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

/** 解析并校验请求文件内容 */
export function parseRequestFile(file: string): SupervisorRequest | undefined {
	const parsed = readJson<Partial<SupervisorRequest>>(file);
	if (!parsed || parsed.type !== "subagent.supervisor.request") return undefined;
	if (typeof parsed.id !== "string" || !parsed.id) return undefined;
	if (parsed.reason !== "need_decision" && parsed.reason !== "interview_request" && parsed.reason !== "progress_update") return undefined;
	if (typeof parsed.message !== "string" || !parsed.message) return undefined;
	if (typeof parsed.runId !== "string" || typeof parsed.agent !== "string" || typeof parsed.childIndex !== "number") return undefined;
	if (typeof parsed.orchestratorSessionId !== "string" || !parsed.orchestratorSessionId) return undefined;
	return parsed as SupervisorRequest;
}

/** 序列化体积保护 */
export function assertMessageSize(obj: Record<string, unknown>): void {
	const bytes = Buffer.byteLength(JSON.stringify(obj), "utf-8");
	if (bytes > MAX_MESSAGE_BYTES) throw new Error("Supervisor message is too large (>64KB).");
}
