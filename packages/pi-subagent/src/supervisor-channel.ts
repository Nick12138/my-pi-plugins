/**
 * 主代理侧 supervisor 服务端：轮询扫描通道目录，把子代理的请求转交给主 agent，
 * 并提供 subagent_supervisor 工具让主 agent 回复（写入 replies/，子代理随即解除阻塞）。
 *
 * 注意：工具注册（registerSupervisorTool）必须在扩展加载阶段调用（与 subagent 工具
 * 同时机），否则会话工具列表快照不会包含它；轮询（createSupervisorChannel().start()）
 * 在 session_start 启动、session_shutdown 时 dispose。
 * Windows 上 fs.watch 对 %TEMP% 目录不可靠，统一用轮询（500ms）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	REPLIES_DIR,
	REQUESTS_DIR,
	SERVER_POLL_MS,
	SUPERVISOR_CHANNEL_ROOT,
	SUPERVISOR_TOOL_SERVER,
	parseRequestFile,
	replyPath,
	requestPath,
	type SupervisorRequest,
} from "./supervisor-protocol.ts";

const ServerParams = Type.Object(
	{
		action: StringEnum(["reply", "pending", "list", "status"] as const, { description: "操作：reply=回复某个请求；pending/list=列出待回复请求；status=通道状态", default: "status" }),
		replyTo: Type.Optional(Type.String({ description: "reply 时指定请求 id（或前缀/agent 名）" })),
		message: Type.Optional(Type.String({ description: "reply 时的回复内容（必填）" })),
	},
	{ additionalProperties: false },
);
type ServerParamsT = Static<typeof ServerParams>;

export interface SupervisorChannelDeps {
	/** 当前主会话 id，用于校验请求属于本会话 */
	getSessionId: () => string | undefined;
	/** 新请求到达（含期望回复或进度通知）时的回调：负责唤醒主 agent */
	onRequest: (request: SupervisorRequest, visibleText: string) => void;
}

interface PendingEntry {
	request: SupervisorRequest;
	file: string;
	channelDir: string;
}

export interface SupervisorChannel {
	start(): void;
	dispose(): void;
	pendingCount(): number;
}

// ── 模块级共享状态（工具与轮询共用）─────────────────────────

const pending = new Map<string, PendingEntry>();
const seenFiles = new Set<string>();
let currentDeps: SupervisorChannelDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

function listRequestFiles(): Array<{ channelDir: string; file: string }> {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: Array<{ channelDir: string; file: string }> = [];
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		const channelDir = path.join(SUPERVISOR_CHANNEL_ROOT, entry.name);
		const requestsDir = path.join(channelDir, REQUESTS_DIR);
		let requestEntries: fs.Dirent[];
		try {
			requestEntries = fs.readdirSync(requestsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const requestEntry of requestEntries) {
			if (requestEntry.isFile() && requestEntry.name.endsWith(".json") && !requestEntry.name.endsWith(".tmp")) {
				files.push({ channelDir, file: path.join(requestsDir, requestEntry.name) });
			}
		}
	}
	return files;
}

function requestExpiresAt(request: SupervisorRequest): number {
	return typeof request.expiresAt === "number" && Number.isFinite(request.expiresAt) ? request.expiresAt : request.createdAt + 10 * 60 * 1000;
}

function removeFile(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* best-effort */
	}
}

function writeReply(entry: PendingEntry, message: string): void {
	if (!message.trim()) throw new Error("message is required for supervisor replies.");
	const reply = {
		type: "subagent.supervisor.reply",
		requestId: entry.request.id,
		createdAt: Date.now(),
		message: message.trim(),
	};
	const file = replyPath(entry.channelDir, entry.request.id);
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(reply, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
	removeFile(entry.file);
	pending.delete(entry.request.id);
}

function refreshPending(): void {
	const now = Date.now();
	for (const [id, entry] of pending) {
		if (fs.existsSync(replyPath(entry.channelDir, id))) {
			removeFile(entry.file);
			pending.delete(id);
			continue;
		}
		if (entry.request.expectsReply && now > requestExpiresAt(entry.request)) {
			removeFile(entry.file);
			pending.delete(id);
		}
	}
}

function poll(): void {
	const deps = currentDeps;
	if (!deps) return;
	const sessionId = deps.getSessionId();
	if (!sessionId) return;
	refreshPending();
	const now = Date.now();
	for (const { channelDir, file } of listRequestFiles()) {
		if (seenFiles.has(file)) continue;
		seenFiles.add(file);
		const request = parseRequestFile(file);
		if (!request || request.orchestratorSessionId !== sessionId) continue;

		if (!request.expectsReply) {
			// 进度通知：交给主 agent 后即清理（不驻留 pending）
			deps.onRequest(request, request.message);
			removeFile(file);
			continue;
		}
		if (now > requestExpiresAt(request)) {
			removeFile(file);
			continue;
		}
		if (fs.existsSync(replyPath(channelDir, request.id))) {
			removeFile(file);
			continue;
		}
		pending.set(request.id, { request, file, channelDir });
		deps.onRequest(request, request.message);
	}
}

function startPolling(): void {
	if (timer) return;
	timer = setInterval(() => {
		try {
			poll();
		} catch {
			/* 单次扫描失败不中断轮询 */
		}
	}, SERVER_POLL_MS);
	timer.unref?.();
}

function resolvePending(replyTo: string | undefined): PendingEntry {
	const entries = scanPendingRequests();
	if (replyTo) {
		const normalized = replyTo.trim().toLowerCase();
		const matches = entries.filter((e) =>
			e.request.id.toLowerCase().startsWith(normalized)
			|| e.request.agent.toLowerCase() === normalized
			|| e.request.runId.toLowerCase().startsWith(normalized),
		);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Multiple pending supervisor requests match '${replyTo}'. Use full requestId.`);
		throw new Error(`No pending supervisor request found for '${replyTo}'.`);
	}
	if (entries.length === 1) return entries[0]!;
	if (entries.length === 0) throw new Error("No pending supervisor requests need a reply.");
	throw new Error("Multiple pending supervisor requests need replies. Use replyTo.");
}

/** 直接扫描文件系统：所有未过期、无回复的期望回复请求（不依赖内存 pending，工具与 poll 解耦） */
function scanPendingRequests(): PendingEntry[] {
	const now = Date.now();
	const entries: PendingEntry[] = [];
	for (const { channelDir, file } of listRequestFiles()) {
		const request = parseRequestFile(file);
		if (!request || !request.expectsReply) continue;
		if (now > requestExpiresAt(request)) {
			removeFile(file);
			continue;
		}
		if (fs.existsSync(replyPath(channelDir, request.id))) {
			removeFile(file);
			continue;
		}
		entries.push({ request, file, channelDir });
	}
	return entries;
}

function buildServerTool(): ToolDefinition<typeof ServerParams, Record<string, unknown>> {
	return {
		name: SUPERVISOR_TOOL_SERVER,
		label: "Subagent Supervisor",
		description: "子代理 supervisor 通道：回复子代理的待处理请求（action: reply），或查看待回复列表（pending/list）与通道状态（status）。",
		parameters: ServerParams,
		async execute(_id, params) {
			const input = params as ServerParamsT;
			if (input.action === "status") {
				return {
					content: [{ type: "text", text: `Supervisor channel active. Pending replies: ${scanPendingRequests().length}.` }],
					details: { active: true, pending: scanPendingRequests().length, root: SUPERVISOR_CHANNEL_ROOT },
				};
			}
			if (input.action === "pending" || input.action === "list") {
				const entries = scanPendingRequests();
				if (entries.length === 0) return { content: [{ type: "text", text: "No pending supervisor requests." }], details: { pending: [] } };
				const lines = entries.map((e) => {
					const replyHint = ` Reply: ${SUPERVISOR_TOOL_SERVER}({ action: "reply", replyTo: "${e.request.id}", message: "..." })`;
					return `- ${e.request.id}: ${e.request.agent} [${e.request.runId}] ${e.request.reason}.${replyHint}`;
				});
				return {
					content: [{ type: "text", text: `Pending supervisor requests (${entries.length}):\n${lines.join("\n")}` }],
					details: { pending: entries.map((e) => ({ id: e.request.id, runId: e.request.runId, agent: e.request.agent, reason: e.request.reason })) },
				};
			}
			if (input.action === "reply") {
				const target = resolvePending(input.replyTo);
				writeReply(target, input.message ?? "");
				return { content: [{ type: "text", text: `Replied to supervisor request ${target.request.id}.` }], details: { replyTo: target.request.id, runId: target.request.runId, agent: target.request.agent } };
			}
			throw new Error(`Unsupported supervisor action: ${input.action}`);
		},
	};
}

/**
 * 注册 subagent_supervisor 工具。必须在扩展加载阶段调用（与 subagent 工具同时机），
 * 否则会话工具列表快照不会包含它。幂等：同名工具已存在时跳过。
 */
export function registerSupervisorTool(pi: ExtensionAPI): void {
	try {
		if (pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === SUPERVISOR_TOOL_SERVER) === true) return;
	} catch {
		/* 拿不到工具列表则直接注册 */
	}
	try {
		pi.registerTool(buildServerTool());
	} catch (error) {
		console.error(`[pi-subagent] registerSupervisorTool failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 创建 supervisor 轮询通道（单例）。扩展在 session_start 调用 start()，session_shutdown 调用 dispose()。 */
export function createSupervisorChannel(_pi: ExtensionAPI, deps: SupervisorChannelDeps): SupervisorChannel {
	currentDeps = deps;
	return {
		start: () => {
			if (started) return;
			started = true;
			try {
				fs.mkdirSync(SUPERVISOR_CHANNEL_ROOT, { recursive: true });
			} catch {
				/* 目录创建失败则靠轮询重试 */
			}
			try {
				poll();
			} catch (error) {
				console.error(`[pi-subagent] supervisor poll failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			startPolling();
		},
		dispose: () => {
			started = false;
			if (timer) clearInterval(timer);
			timer = null;
			pending.clear();
			seenFiles.clear();
			currentDeps = null;
		},
		pendingCount: () => pending.size,
	};
}

/** 诊断信息（HTTP API 用） */
export function supervisorDiagnostics(): Record<string, unknown> {
	let sessionId: string | undefined;
	try {
		sessionId = currentDeps?.getSessionId();
	} catch {
		sessionId = "(getSessionId threw)";
	}
	return {
		started,
		timerActive: timer !== null,
		pending: pending.size,
		seenFiles: seenFiles.size,
		root: SUPERVISOR_CHANNEL_ROOT,
		sessionId: sessionId ?? null,
		rootExists: (() => {
			try {
				return fs.existsSync(SUPERVISOR_CHANNEL_ROOT);
			} catch {
				return false;
			}
		})(),
	};
}

export function visibleRequestText(request: SupervisorRequest): string {
	const lines = [
		`子代理请求（${request.agent} · ${request.runId}）：`,
		"",
		request.message,
	];
	if (request.expectsReply) {
		lines.push("", `回复方式：调用 ${SUPERVISOR_TOOL_SERVER}({ action: "reply", replyTo: "${request.id}", message: "..." })`);
	}
	return lines.join("\n");
}
