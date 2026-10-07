/**
 * pixie_dispatch / pixie_report 工具的插件侧壳。
 *
 * 参数 schema 与文本格式照搬 PiAbyss 内置实现
 * （packages/pi-host/src/pixie-tool.ts）的口径，区别只在执行方式：委派引擎
 * 仍在 Host 侧，工具通过环回 HTTP 控制面（PIABYSS_PIXIE_HTTP_PORT）转发。
 *
 * - pixie_dispatch：仅在常驻小精灵会话激活（扩展入口据 PIABYSS_PIXIE_RESIDENT
 *   控制注册；普通会话不注册该工具）。
 * - pixie_report：注册后被激活门控保持在 active tools 之外（见 activation.ts），
 *   普通工作区会话看不到该工具。
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { readPixiePort, pixieRequest } from "./http-client.js";
import {
	PIXIE_DISPATCH_PATH,
	PIXIE_DISPATCH_STATE_PATH,
	PIXIE_REPORT_PATH,
	PIXIE_REPORT_SUCCESS_TEXT,
	formatDispatchFailureText,
	formatDispatchSuccessText,
	formatReportFailureText,
	mapDispatchResponse,
	mapDispatchStateResponse,
	mapReportResponse,
} from "./protocol.js";

export const PIXIE_DISPATCH_NAME = "pixie_dispatch";
export const PIXIE_REPORT_NAME = "pixie_report";

const DispatchParams = Type.Object({
	cwd: Type.String({
		description: "目标工作区的绝对路径（用户提到哪个项目就填哪个项目的 cwd）。",
	}),
	task: Type.String({
		description:
			"委派提示词：包含任务目标、必要的上下文、完成后的回调要求（调用 pixie_report 报告「已完成 + 结果摘要」）。若任务源自某条备忘录，还应要求被委派 Agent 完成后用 piabyss_memo complete 回填。",
	}),
	newSession: Type.Optional(
		Type.Boolean({
			description: "true = 不复用目标工作区的既有会话，强制新开一个会话执行。默认 false。",
		}),
	),
});

type DispatchParamsType = Static<typeof DispatchParams>;

const ReportParams = Type.Object({
	result: Type.String({
		description:
			"结果摘要（Markdown）：已完成 + 关键结果与数据。控制在 500 字以内，不要粘贴全文——全文留在本会话里，用户可随时打开查看。",
	}),
	success: Type.Optional(
		Type.Boolean({ description: "任务是否成功完成。默认 true；失败或部分完成时设为 false。" }),
	),
});

type ReportParamsType = Static<typeof ReportParams>;

function errorResult(text: string): {
	content: [{ type: "text"; text: string }];
	details: undefined;
	isError: true;
} {
	return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

function okResult(text: string): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/** 端口读取器：默认读环境变量（延迟读取，便于测试替换）。 */
export type PixiePortReader = () => number | null;

/**
 * pixie_dispatch 工具壳：执行 = POST /api/pixie/dispatch。
 * 成功响应 { ok: true, dispatchId, sessionId, sessionPath, queued }；
 * 失败响应 { ok: false, error } → isError + 「委派失败：{error}」。
 */
export function buildPixieDispatchTool(options: { getPort?: PixiePortReader } = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_DISPATCH_NAME,
		label: "Pixie dispatch",
		description:
			"委派任务到某个工作区的正式会话执行（重活专用）。委派后立即返回受理结果；目标会话完成后会通过 pixie_report 回调，你收到回调后再向用户转述。",
		promptSnippet: "Delegate a task to a workspace session and wait for its callback",
		parameters: DispatchParams,
		async execute(_toolCallId, params: DispatchParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult(formatDispatchFailureText("未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。"));
			}
			const body: { cwd: string; task: string; newSession?: boolean } = {
				cwd: params.cwd,
				task: params.task,
				...(params.newSession !== undefined ? { newSession: params.newSession } : {}),
			};
			try {
				const result = await pixieRequest({ port, method: "POST", path: PIXIE_DISPATCH_PATH, body });
				const resolution = mapDispatchResponse(result);
				if (!resolution.ok) {
					return errorResult(formatDispatchFailureText(resolution.error));
				}
				return okResult(formatDispatchSuccessText(resolution));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(formatDispatchFailureText(message));
			}
		},
	});
}

/**
 * pixie_report 工具壳：参数与错误/成功文本照搬原 pixie-tool.ts
 * （{ result, success? }，dispatchId 对模型透明）。执行流：
 *  1. GET /api/pixie/dispatch-state?sessionId=<当前会话id> 解析 dispatchId
 *     （对应原实现的 findDispatch；未 armed / 无记录 → 「Error: 当前会话没有进行中的小精灵委派。」）
 *  2. POST /api/pixie/report，body { dispatchId, summary, success }。
 * 激活由扩展在 before_agent_start 据 Host 的 dispatch-state 门控（activation.ts）。
 */
export function buildPixieReportTool(options: {
	getPort?: PixiePortReader;
	/** 当前会话 id 读取器：默认从 execute 的 ctx.sessionManager 取，测试可注入。 */
	getSessionId?: (ctx?: unknown) => string | null;
} = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	const getSessionId = options.getSessionId ?? defaultReportSessionId;
	return defineTool({
		name: PIXIE_REPORT_NAME,
		label: "Pixie report",
		description:
			"向「小精灵」回调委派任务的结果（仅在被委派的任务会话中使用）。完成任务后调用：报告已完成状态与结果摘要，小精灵会把结果转述给用户。",
		promptSnippet: "Report a delegated task's result back to the pixie helper",
		parameters: ReportParams,
		async execute(_toolCallId, params: ReportParamsType, _signal, _onUpdate, ctx) {
			const port = getPort();
			if (port === null) {
				return errorResult(formatReportFailureText("未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。"));
			}
			// 对应原实现的 findDispatch：按会话解析进行中的委派。
			const sessionId = getSessionId(ctx);
			let dispatchId: string | null = null;
			if (sessionId) {
				try {
					const state = mapDispatchStateResponse(
						await pixieRequest({
							port,
							method: "GET",
							path: `${PIXIE_DISPATCH_STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
						}),
					);
					dispatchId = state.armed ? state.dispatchId : null;
				} catch {
					dispatchId = null;
				}
			}
			if (!dispatchId) {
				return errorResult(formatReportFailureText("当前会话没有进行中的小精灵委派。"));
			}
			const summary = params.result.trim();
			if (!summary) {
				return errorResult(formatReportFailureText("result 摘要不能为空。"));
			}
			const success = params.success ?? true;
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_REPORT_PATH,
					body: { dispatchId, summary, success },
				});
				const resolution = mapReportResponse(result);
				if (!resolution.ok) {
					return errorResult(formatReportFailureText(resolution.error));
				}
				return okResult(PIXIE_REPORT_SUCCESS_TEXT);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(formatReportFailureText(message));
			}
		},
	});
}

/** 从 execute ctx 安全取会话 id（拿不到返回 null，绝不抛出）。 */
function defaultReportSessionId(ctx?: unknown): string | null {
	try {
		const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
		const id = manager?.getSessionId?.();
		return typeof id === "string" && id ? id : null;
	} catch {
		return null;
	}
}
