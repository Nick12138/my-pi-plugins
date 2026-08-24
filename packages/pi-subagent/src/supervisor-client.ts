/**
 * 子代理侧 supervisor 客户端扩展（由 runner 以 --extension 注入子进程）。
 *
 * 注册 contact_supervisor 工具：子代理需要主代理决策/结构化输入/进度通知时，
 * 写入 requests/<uuid>.json；需要回复时阻塞轮询 replies/ 直到主代理用
 * subagent_supervisor 工具回复（默认 10 分钟超时），然后继续任务。
 *
 * 非子代理进程（无通道环境变量）加载本扩展时直接跳过，不注册任何东西。
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ENV_CHANNEL_DIR,
	ENV_CHILD_AGENT,
	ENV_ORCHESTRATOR_SESSION_ID,
	ENV_RUN_ID,
	REPLIES_DIR,
	SUPERVISOR_TOOL_CLIENT,
	WAIT_REPLY_POLL_MS,
	assertMessageSize,
	channelDir,
	ensureChannelDir,
	parseRequestFile,
	replyPath,
	requestPath,
	supervisorTimeoutMs,
	type SupervisorReason,
	type SupervisorRequest,
	type SupervisorReply,
} from "./supervisor-protocol.ts";

const ContactSupervisorParams = Type.Object(
	{
		reason: StringEnum(["need_decision", "interview_request", "progress_update"] as const, {
			description: "联系主代理的原因：need_decision=需要决策/批准（阻塞等回复）；interview_request=要结构化输入；progress_update=进度通知（不等待）",
		}),
		message: Type.Optional(Type.String({ description: "给主代理的消息内容（need_decision 必填）" })),
		interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true }, { description: "interview_request 时希望主代理按此结构回复的 JSON 模板" })),
	},
	{ additionalProperties: false },
);
type ContactSupervisorParamsT = Static<typeof ContactSupervisorParams>;

interface ChildMetadata {
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorSessionId: string;
}

function readChildMetadata(): ChildMetadata | undefined {
	const channelDirValue = process.env[ENV_CHANNEL_DIR]?.trim();
	const runId = process.env[ENV_RUN_ID]?.trim();
	const agent = process.env[ENV_CHILD_AGENT]?.trim();
	const orchestratorSessionId = process.env[ENV_ORCHESTRATOR_SESSION_ID]?.trim();
	if (!channelDirValue || !runId || !agent || !orchestratorSessionId) return undefined;
	return {
		channelDir: channelDirValue,
		runId,
		agent,
		childIndex: 0,
		orchestratorSessionId,
	};
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Supervisor request cancelled."));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer) clearTimeout(timer);
			reject(new Error("Supervisor request cancelled."));
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForReply(channelDirValue: string, requestId: string, deadline: number, signal?: AbortSignal): Promise<SupervisorReply> {
	const file = replyPath(channelDirValue, requestId);
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error("Supervisor request cancelled.");
		const reply = parseReplyFile(file);
		if (reply) return reply;
		await delay(WAIT_REPLY_POLL_MS, signal);
	}
	throw new Error("Timed out waiting for supervisor reply.");
}

function parseReplyFile(file: string): SupervisorReply | undefined {
	try {
		if (!fs.existsSync(file)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorReply>;
		if (parsed.type === "subagent.supervisor.reply" && typeof parsed.requestId === "string" && typeof parsed.message === "string") {
			return parsed as SupervisorReply;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function reasonHeading(reason: SupervisorReason): string {
	if (reason === "interview_request") return "Subagent requests a structured supervisor interview.";
	if (reason === "progress_update") return "Subagent progress update.";
	return "Subagent needs a supervisor decision.";
}

function formatChildMessage(meta: ChildMetadata, reason: SupervisorReason, message: string | undefined, interview: unknown): string {
	const lines = [
		reasonHeading(reason),
		`Run: ${meta.runId}`,
		`Agent: ${meta.agent}`,
		"",
	];
	if (message?.trim()) lines.push(message.trim());
	if (reason === "interview_request") {
		lines.push("", "Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.");
		if (interview !== undefined) lines.push(JSON.stringify(interview, null, "\t"));
	}
	return lines.join("\n").trimEnd();
}

async function sendSupervisorRequest(params: ContactSupervisorParamsT, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const meta = readChildMetadata();
	if (!meta) throw new Error("Supervisor channel is not available in this process.");
	if (params.reason !== "progress_update" && !params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor decisions.");
	}

	ensureChannelDir(meta.channelDir);
	const requestId = randomUUID();
	const expectsReply = params.reason !== "progress_update";
	const createdAt = Date.now();
	const replyDeadline = createdAt + supervisorTimeoutMs();
	const request: SupervisorRequest = {
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt,
		...(expectsReply ? { expiresAt: replyDeadline } : {}),
		reason: params.reason,
		message: formatChildMessage(meta, params.reason, params.message, params.interview),
		expectsReply,
		orchestratorSessionId: meta.orchestratorSessionId,
		runId: meta.runId,
		agent: meta.agent,
		childIndex: meta.childIndex,
		...(params.interview !== undefined ? { interview: params.interview } : {}),
	};
	assertMessageSize(request as unknown as Record<string, unknown>);
	writeRequest(requestPath(meta.channelDir, requestId), request);

	if (!expectsReply) {
		return {
			content: [{ type: "text", text: "Supervisor progress update queued." }],
			details: { delivered: true, requestId, reason: params.reason },
		};
	}

	try {
		const reply = await waitForReply(meta.channelDir, requestId, replyDeadline, signal);
		const details: Record<string, unknown> = { requestId, reason: params.reason };
		if (params.reason === "interview_request") {
			const trimmed = reply.message.trim();
			const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
			try {
				details.structuredReply = JSON.parse(fenced ?? trimmed);
			} catch {
				/* 保留原文 */
			}
		}
		return {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.message}` }],
			details,
		};
	} catch (error) {
		// 超时/中止：删掉自己的请求，避免主代理侧残留过期请求
		try {
			fs.rmSync(requestPath(meta.channelDir, requestId), { force: true });
		} catch {
			/* best-effort */
		}
		throw error;
	}
}

function writeRequest(file: string, request: SupervisorRequest): void {
	// 复用协议模块的原子写（避免引入循环依赖，这里直接用 fs 原子写）
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(request, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === name) === true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI): void {
	// 只有子代理进程（注入了通道环境变量）才注册工具
	const meta = readChildMetadata();
	if (!meta || hasTool(pi, SUPERVISOR_TOOL_CLIENT)) return;

	const tool: ToolDefinition<typeof ContactSupervisorParams, Record<string, unknown>> = {
		name: SUPERVISOR_TOOL_CLIENT,
		label: "Contact Supervisor",
		description: [
			"联系主代理（supervisor）：用于需要决策、结构化输入或进度通知的场景。",
			"- need_decision：需要主代理决策/批准/澄清，阻塞等待回复（默认 10 分钟超时）",
			"- interview_request：请求主代理按 interview 结构回复 JSON",
			"- progress_update：单向进度通知，不等待回复",
			"除非必须与主代理协调，否则完成时直接返回任务结果即可，不要用它做例行汇报。",
		].join("\n"),
		parameters: ContactSupervisorParams,
		execute(_id, params, signal) {
			return sendSupervisorRequest(params as ContactSupervisorParamsT, signal);
		},
	};
	pi.registerTool(tool);
}
