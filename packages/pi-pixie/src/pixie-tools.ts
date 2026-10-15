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
import { pixieRequest, PIXIE_DISPATCH_TIMEOUT_MS, readPixiePort } from "./http-client.js";
import {
	PIXIE_ASK_PATH,
	PIXIE_DISPATCHES_PATH,
	PIXIE_DISPATCH_PATH,
	PIXIE_DISPATCH_STATE_PATH,
	PIXIE_INTERJECT_PATH,
	PIXIE_REPORT_PATH,
	PIXIE_REST_PATH,
	PIXIE_RETRY_PATH,
	PIXIE_SESSIONS_PATH,
	PIXIE_STOP_PATH,
	PIXIE_ASK_SUCCESS_TEXT,
	PIXIE_REPORT_SUCCESS_TEXT,
	PIXIE_REST_SUCCESS_TEXT,
	formatAskFailureText,
	formatDispatchFailureText,
	formatDispatchSuccessText,
	formatReportFailureText,
	formatRestFailureText,
	formatSessionListText,
	mapAskResponse,
	mapDispatchListResponse,
	mapDispatchResponse,
	mapDispatchStateResponse,
	mapReportResponse,
	mapRestResponse,
	mapRetryResponse,
	mapSessionListResponse,
	mapStopResponse,
} from "./protocol.js";
import { recallSegmentsText, sessionPathFromCtx } from "./segments.js";

export const PIXIE_DISPATCH_NAME = "pixie_dispatch";
export const PIXIE_REPORT_NAME = "pixie_report";
export const PIXIE_ASK_NAME = "pixie_ask";
export const PIXIE_REST_NAME = "pixie_rest";
export const PIXIE_STATUS_NAME = "pixie_dispatch_status";
export const PIXIE_SESSIONS_NAME = "pixie_sessions";
export const PIXIE_INTERJECT_NAME = "pixie_interject";
export const PIXIE_STOP_NAME = "pixie_stop";
export const PIXIE_RETRY_NAME = "pixie_retry";
export const PIXIE_RECALL_NAME = "pixie_recall";

/** pixie_recall 走本地会话目录，不经环回控制面，失败文案单独一套。 */
function formatRecallFailureText(error: string): string {
	return `Error: ${error}`;
}

const DispatchParams = Type.Object({
	cwd: Type.String({
		description:
			"目标工作区的绝对路径（用户提到哪个项目就填哪个项目的 cwd；必须是 <pixie-context> 已知工作区列表中的路径或用户当前打开的工作区）。",
	}),
	task: Type.String({
		description:
			"委派提示词：包含任务目标、必要的上下文、完成后的回调要求（调用 pixie_report 报告「已完成 + 结果摘要」；需要用户决策时调用 pixie_ask）。若任务源自某条备忘录，还应要求被委派 Agent 完成后用 piabyss_memo complete 回填。",
	}),
	taskName: Type.Optional(
		Type.String({
			description:
				"任务名（几个词，≤20 字，如「门店数据对账」）：前端的委派列表只显示它 + 状态，不显示完整提示词。每派一条新任务都传——复用既有会话也算一条新任务。往进行中的任务追加消息不算新任务，用 pixie_interject（不带任务名）。省略则由 Host 截取任务前缀兜底。",
		}),
	),
	sessionName: Type.Optional(
		Type.String({
			description:
				"会话名（几个词，≤20 字，如「门店数据整理」）：【本次会新开会话】时才传，成为新会话的名字兼前端委派列表的分组标题——即填了 newSession: true，或该工作区里还没有小精灵自己创建的会话。复用既有会话（包括用 sessionId 指定时）不要传，会话沿用原名。不确定会不会新开就照常传：Host 只在真正新建会话时采用它，复用既有会话时忽略。省略且确实新开会话时由 Host 截取任务前缀兜底（不会留下「新会话」这种无名字）。",
		}),
	),
	sessionId: Type.Optional(
		Type.String({
			description:
				"⚠️ 仅在用户在对话中明确给出了会话 id 时才传（用户自己的会话不能被自动复用）。填了就以该会话为落点——哪怕它是用户在 UI 里创建的会话；找不到会直接报错，绝不会改落到别的会话上。",
		}),
	),
	newSession: Type.Optional(
		Type.Boolean({
			description:
				"true = 强制新开一个干净会话。默认 false：复用目标工作区里【小精灵自己创建的】既有会话（用户自己创建的会话永远不会被自动复用），没有可复用的就自动新开一个。查询/一次性任务建议传 true。",
		}),
	),
	batchId: Type.Optional(
		Type.String({
			description:
				"批次标记：一次向多个工作区并行派发一组相关任务时，给同批任务填同一个自定义批次号（如 batch-20260101-a），回调与查岗会带出该标记便于聚合转述。单个任务省略。",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"指定执行模型（provider/id，如 anthropic/claude-sonnet-4-5）。⚠️ 仅当用户在对话中明确指定了模型时才传此参数；用户没说就用默认（省略本参数，跟随目标会话当前模型）——未经用户明确授权不得主动更换模型。",
		}),
	),
	thinkingLevel: Type.Optional(
		Type.String({
			description:
				"指定推理深度（off|minimal|low|medium|high|xhigh|max）。⚠️ 仅当用户在对话中明确指定了推理深度时才传；用户没说就省略（跟随会话默认）——未经用户明确授权不得主动更换。",
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
	kind: Type.Optional(
		Type.String({
			description:
				"回调种类：final（默认，任务终态完成/失败）或 progress（进度检查点汇报——非终态，任务继续运行或按指示暂停，仅收到 <pixie-interject> checkpoint 信封时使用）。",
		}),
	),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "本任务产出/修改的文件绝对路径列表（有产物时填写，便于用户直接打开）。",
		}),
	),
	pause: Type.Optional(
		Type.Boolean({
			description: "仅 kind=progress 时有效：true = 汇报后暂停本轮等待用户指令（checkpoint wait）。",
		}),
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

/** 名称类参数只保留非空值：空串会让 Host 的「截取任务前缀」兜底失效。 */
function normalizeName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * pixie_dispatch 工具壳：执行 = POST /api/pixie/dispatch。
 * 成功响应 { ok: true, dispatchId, sessionId, sessionPath, queued }；
 * 失败响应 { ok: false, error } → isError + 「委派失败：{error}」。
 */
export function buildPixieDispatchTool(
	options: { getPort?: PixiePortReader; timeoutMs?: number } = {},
): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	const timeoutMs = options.timeoutMs ?? PIXIE_DISPATCH_TIMEOUT_MS;
	return defineTool({
		name: PIXIE_DISPATCH_NAME,
		label: "Pixie dispatch",
		description:
			"委派任务到某个工作区的正式会话执行（重活专用）。落点规则：默认复用该工作区里【小精灵自己创建的】会话，没有就新开一个；用户自己在 UI 里创建的会话不会被自动复用，除非用户在对话中明确给出该会话 id（那时用 sessionId 参数）。委派后立即返回受理结果；目标会话完成后会通过 pixie_report 回调，你收到回调后再向用户转述。每条新任务都用 taskName 起个短名，本次要新开会话时再用 sessionName 给会话起名——用户在界面上看的是这两个名字，不是完整提示词。",
		promptSnippet: "Delegate a task to a workspace session and wait for its callback",
		parameters: DispatchParams,
		async execute(_toolCallId, params: DispatchParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult(formatDispatchFailureText("未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。"));
			}
			const taskName = normalizeName(params.taskName);
			const sessionName = normalizeName(params.sessionName);
			const body: {
				cwd: string;
				task: string;
				taskName?: string;
				sessionName?: string;
				newSession?: boolean;
				sessionId?: string | null;
				batchId?: string | null;
				model?: string | null;
				thinkingLevel?: string | null;
			} = {
				cwd: params.cwd,
				task: params.task,
				...(taskName !== undefined ? { taskName } : {}),
				...(sessionName !== undefined ? { sessionName } : {}),
				...(params.newSession !== undefined ? { newSession: params.newSession } : {}),
				...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
				...(params.batchId !== undefined ? { batchId: params.batchId } : {}),
				...(params.model !== undefined ? { model: params.model } : {}),
				...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
			};
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_DISPATCH_PATH,
					body,
					timeoutMs,
				});
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
 *  2. POST /api/pixie/report，body { dispatchId, summary, success, kind?, files?, pause? }。
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
			"向「小精灵」回调委派任务的结果（仅在被委派的任务会话中使用）。完成任务后调用：报告已完成状态与结果摘要，小精灵会把结果转述给用户。需要用户决策时不要用本工具干等，改用 pixie_ask。",
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
			const kind =
				params.kind === "progress"
					? "progress"
					: params.kind === "final" || params.kind === undefined
						? undefined
						: null;
			if (kind === null) {
				return errorResult(formatReportFailureText("kind 必须是 final 或 progress。"));
			}
			const files =
				params.files && params.files.length > 0
					? params.files.filter((file) => typeof file === "string" && file.trim())
					: undefined;
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_REPORT_PATH,
					body: {
						dispatchId,
						summary,
						success,
						...(kind ? { kind } : {}),
						...(files ? { files } : {}),
						...(kind === "progress" && params.pause !== undefined ? { pause: params.pause } : {}),
					},
				});
				const resolution = mapReportResponse(result);
				if (!resolution.ok) {
					return errorResult(formatReportFailureText(resolution.error));
				}
				return okResult(kind === "progress" ? "进度汇报已转交小精灵。" : PIXIE_REPORT_SUCCESS_TEXT);
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

/** 按 armed 门控解析当前会话的 dispatchId（report/ask 共用的查找步骤）。 */
async function resolveArmedDispatchId(getPort: PixiePortReader, ctx?: unknown): Promise<string | null> {
	const port = getPort();
	if (port === null) return null;
	const sessionId = defaultReportSessionId(ctx);
	if (!sessionId) return null;
	try {
		const state = mapDispatchStateResponse(
			await pixieRequest({
				port,
				method: "GET",
				path: `${PIXIE_DISPATCH_STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
			}),
		);
		return state.armed ? state.dispatchId : null;
	} catch {
		return null;
	}
}

const AskParams = Type.Object({
	question: Type.String({
		description:
			"要转述给用户的问题（一句话说清需要用户决策什么）。用户会在小精灵对话里看到并直接回复，答复以 <pixie-reply> 信封回到本会话。",
	}),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "可选项（如方案 A/B/C）。没有自然选项时省略，让用户自由回答。",
		}),
	),
});

type AskParamsType = Static<typeof AskParams>;

const RestParams = Type.Object({
	title: Type.Optional(
		Type.String({
			description:
				"本段会话的内容标题（几个词概括这段聊了什么，≤20字）。打盹后它会成为本段的归档会话名，让会话列表能认出每一段。建议必填。",
		}),
	),
	phrase: Type.Optional(
		Type.String({
			description: "睡觉短语（分隔符文案），如「我先打个盹~」「出去转一圈」。省略则由 Host 从内置短语池随机挑选。",
		}),
	),
	handoff: Type.Optional(
		Type.String({
			description:
				"写给下一段自己的一句话提示（当前话题聊到哪了、有什么没说完）。只写「光看正文看不出来」的事：进行中的承诺、用户还没拍板的决定。上一段正文不会丢，新段会自动带上段索引和收尾，细节由 pixie_recall 回读，所以不必在这里复述历史。",
		}),
	),
});

type RestParamsType = Static<typeof RestParams>;

/**
 * pixie_ask 工具壳：需要用户决策时调用。执行流与 report 一致——先按 armed
 * 门控解析 dispatchId，再 POST /api/pixie/ask；激活由扩展在
 * before_agent_start 据 Host 的 dispatch-state 门控（activation.ts）。
 */
export function buildPixieAskTool(options: {
	getPort?: PixiePortReader;
} = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_ASK_NAME,
		label: "Pixie ask",
		description:
			"向「小精灵」提问并等待用户决策（仅在被委派的任务会话中使用）。需要用户选择方案、补充信息或确认操作时调用；问题会由小精灵转述给用户，用户答复会回到本会话。",
		promptSnippet: "Ask the user a question through the pixie helper and wait for the reply",
		parameters: AskParams,
		async execute(_toolCallId, params: AskParamsType, _signal, _onUpdate, ctx) {
			const port = getPort();
			if (port === null) {
				return errorResult(formatAskFailureText("未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。"));
			}
			const dispatchId = await resolveArmedDispatchId(getPort, ctx);
			if (!dispatchId) {
				return errorResult(formatAskFailureText("当前会话没有进行中的小精灵委派。"));
			}
			const question = params.question.trim();
			if (!question) {
				return errorResult(formatAskFailureText("question 不能为空。"));
			}
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_ASK_PATH,
					body: {
						dispatchId,
						question,
						...(params.options ? { options: params.options } : {}),
					},
				});
				const resolution = mapAskResponse(result);
				if (!resolution.ok) {
					return errorResult(formatAskFailureText(resolution.error));
				}
				return okResult(PIXIE_ASK_SUCCESS_TEXT);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(formatAskFailureText(message));
			}
		},
	});
}

/**
 * pixie_rest 工具壳：仅在小精灵工作区会话激活（cwd 匹配，由扩展门控）。
 * 执行 = POST /api/pixie/rest；Host 在本回合结束（agent_settled）时收尾当前
 * 会话段，下一条用户消息自动开启新段。
 */
export function buildPixieRestTool(options: { getPort?: PixiePortReader } = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_REST_NAME,
		label: "Pixie rest",
		description:
			"结束当前会话段并打个盹（仅小精灵自己使用）。当话题收束、上下文变得臃肿、或用户说「新开一个话题」时调用：title 用几个词概括本段聊了什么（打盹后成为本段的归档会话名），phrase 填睡觉短语，handoff 写给下一段自己一句话交接。",
		promptSnippet: "End the current conversation segment and take a nap",
		parameters: RestParams,
		async execute(_toolCallId, params: RestParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult(formatRestFailureText("未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。"));
			}
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_REST_PATH,
					body: {
						...(params.title !== undefined ? { title: params.title } : {}),
						...(params.phrase !== undefined ? { phrase: params.phrase } : {}),
						...(params.handoff !== undefined ? { handoff: params.handoff } : {}),
					},
				});
				const resolution = mapRestResponse(result);
				if (!resolution.ok) {
					return errorResult(formatRestFailureText(resolution.error));
				}
				return okResult(PIXIE_REST_SUCCESS_TEXT);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(formatRestFailureText(message));
			}
		},
	});
}

const RecallParams = Type.Object({
	mode: Type.Optional(
		Type.String({
			description:
				"index = 只列历史段清单；tail = 读某一段的收尾（默认）；search = 按关键词在某一段里找原文。",
		}),
	),
	segment: Type.Optional(
		Type.String({
			description:
				"读哪一段：省略或 \"0\" = 上一段，\"1\"/\"2\" = 往前第 N 段（序号取自首轮注入的段索引）；也可以填段名关键词或会话 id 前缀。",
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "mode=search 的关键词（不区分大小写的子串匹配，命中处会带前后一条作上下文）。",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "条数上限：tail 默认 12 条，search 默认 8 处命中。",
		}),
	),
});

type RecallParamsType = Static<typeof RecallParams>;

/**
 * pixie_recall 工具壳：回读小精灵工作区里历史会话段的正文（仅小精灵会话激活）。
 * 执行完全在插件侧——直接读 Pi 的会话目录 <sessionDir>/*.jsonl，不经过 Host 控制面。
 * 打盹只是换了活动会话文件，上一段正文一直在盘上；本工具负责把它按需取回来。
 */
export function buildPixieRecallTool(): ToolDefinition {
	return defineTool({
		name: PIXIE_RECALL_NAME,
		label: "Pixie recall",
		description:
			"回读小精灵自己历史会话段的正文（仅小精灵使用）。每个会话段都存在本机 Pi 会话目录里，打盹不会删掉上一段。用法：mode=index 先看有哪些段；mode=tail 读某一段的收尾（segment 省略 = 上一段）；mode=search 带 query 在指定段里按关键词找原文。新段首轮系统已自动注入段索引与上一段收尾，只有需要更早的段或细节不够时才调用本工具。",
		promptSnippet: "Read back the text of your previous conversation segments",
		parameters: RecallParams,
		async execute(_toolCallId, params: RecallParamsType, _signal, _onUpdate, ctx) {
			const sessionDir = sessionPathFromCtx(ctx, "getSessionDir");
			if (!sessionDir) {
				return errorResult(formatRecallFailureText("拿不到当前会话目录（ctx.sessionManager.getSessionDir 不可用）。"));
			}
			const mode = params.mode === undefined || params.mode === "" ? "tail" : params.mode;
			if (mode !== "index" && mode !== "tail" && mode !== "search") {
				return errorResult(formatRecallFailureText("mode 只能是 index、tail 或 search。"));
			}
			const result = recallSegmentsText({
				sessionDir,
				currentFile: sessionPathFromCtx(ctx, "getSessionFile"),
				mode,
				segment: params.segment,
				query: params.query,
				limit: params.limit,
			});
			if (!result.ok) return errorResult(formatRecallFailureText(result.error));
			return okResult(result.text);
		},
	});
}

const StatusParams = Type.Object({
	dispatchId: Type.Optional(
		Type.String({
			description: "要查询的委派记录 id。省略则返回全部委派（最近 20 条，含进行中与最近结束的）。",
		}),
	),
});

type StatusParamsType = Static<typeof StatusParams>;

function formatTimestamp(ms: number | null): string {
	if (!ms) return "—";
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDispatchSummaryLine(item: {
	id: string;
	status: string;
	kind: string | null;
	cwd: string;
	task: string;
	createdAt: number;
	lastActiveAt: number | null;
	stale: boolean;
	batchId: string | null;
	failCount: number;
	progressSummary: string | null;
	report: string | null;
}): string {
	const statusText =
		item.status === "dispatched"
			? "运行中"
			: item.status === "queued"
				? "排队中"
				: item.status === "paused"
					? "已暂停（等指令）"
					: item.status === "awaiting_user"
						? "等用户答复"
						: item.status === "reported"
							? "已完成"
							: item.status === "failed"
								? "出错"
								: item.status === "stopped"
									? "被叫停"
									: item.status === "cancelled"
										? "已取消"
										: item.status;
	const lines = [
		`- [${statusText}] ${item.task.slice(0, 80)}${item.task.length > 80 ? "…" : ""}`,
		`  dispatchId: ${item.id}  cwd: ${item.cwd}`,
		`  派发: ${formatTimestamp(item.createdAt)}  最后活跃: ${formatTimestamp(item.lastActiveAt)}${item.stale ? "  ⚠️ 失联超时" : ""}`,
	];
	if (item.batchId) lines.push(`  批次: ${item.batchId}`);
	if (item.failCount > 0) lines.push(`  累计失败: ${item.failCount} 次`);
	if (item.progressSummary) lines.push(`  最新进度: ${item.progressSummary.slice(0, 160)}`);
	if (item.status === "reported" && item.report) lines.push(`  结果: ${item.report.slice(0, 200)}`);
	return lines.join("\n");
}

/**
 * pixie_dispatch_status 工具壳（查岗）：GET /api/pixie/dispatches。
 * 返回委派记录的状态/进度摘要/时间信息，解决「沉默 = 不知道」的盲目问题。
 */
export function buildPixieStatusTool(options: { getPort?: PixiePortReader } = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_STATUS_NAME,
		label: "Pixie dispatch status",
		description:
			"查询委派任务的当前状态（仅小精灵自己使用）。用户问「那个任务跑得怎么样了」或你需要检查委派进度时调用：返回排队中/运行中/已完成/被叫停/出错等状态，附一句话进度摘要、派发时间与最后活跃时间；失败次数 ≥3 时应升级报告用户。",
		promptSnippet: "Check the status of delegated tasks",
		parameters: StatusParams,
		async execute(_toolCallId, params: StatusParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult("Error: 未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。");
			}
			try {
				const result = await pixieRequest({
					port,
					method: "GET",
					path: `${PIXIE_DISPATCHES_PATH}?limit=20`,
				});
				const resolution = mapDispatchListResponse(result);
				if (!resolution.ok) {
					return errorResult(`Error: ${resolution.error}`);
				}
				if (resolution.dispatches.length === 0) {
					return okResult("当前没有任何委派记录。");
				}
				const wanted = params.dispatchId?.trim();
				const items = wanted
					? resolution.dispatches.filter((item) => item.id === wanted)
					: resolution.dispatches;
				if (items.length === 0) {
					return okResult(`没有找到 dispatchId 为 ${wanted} 的委派记录。`);
				}
				return okResult(
					["委派任务状态：", ...items.map((item) => formatDispatchSummaryLine(item))].join("\n"),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`Error: ${message}`);
			}
		},
	});
}

const SessionsParams = Type.Object({
	cwd: Type.Optional(
		Type.String({
			description: "只看某个工作区的会话（绝对路径）；省略 = 全部工作区。",
		}),
	),
});

type SessionsParamsType = Static<typeof SessionsParams>;

/**
 * pixie_sessions 工具壳（会话缓存）：GET /api/pixie/sessions[?cwd=]。
 *
 * 数据源是 Host 侧的 sessions-cache.json：小精灵自己创建的会话（可自动复用）+
 * 被委托会话（含用户显式指定的会话）的简介与最近结果。用途是挑会话继续派活，
 * 以及向用户交代"之前那个任务落在哪个会话里"。
 */
export function buildPixieSessionsTool(options: { getPort?: PixiePortReader } = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_SESSIONS_NAME,
		label: "Pixie sessions",
		description:
			"查看小精灵的会话缓存（仅小精灵自己使用）：列出小精灵自己创建的会话（可自动复用）与用户自己创建的会话（只有用户在对话中明确给出 sessionId 时才能委托），含所属工作区、会话简介与最近结果。用户问「那个任务是在哪个会话里跑的」「有哪些会话可以接着用」，或你要挑一个会话继续派活时调用。",
		promptSnippet: "List cached pixie sessions (own + delegated) with summaries",
		parameters: SessionsParams,
		async execute(_toolCallId, params: SessionsParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult("Error: 未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。");
			}
			const cwd = params.cwd?.trim();
			try {
				const result = await pixieRequest({
					port,
					method: "GET",
					path: cwd
						? `${PIXIE_SESSIONS_PATH}?cwd=${encodeURIComponent(cwd)}`
						: PIXIE_SESSIONS_PATH,
				});
				const resolution = mapSessionListResponse(result);
				if (!resolution.ok) return errorResult(`Error: ${resolution.error}`);
				return okResult(formatSessionListText(resolution.sessions, cwd));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`Error: ${message}`);
			}
		},
	});
}

const InterjectParams = Type.Object({
	dispatchId: Type.String({
		description: "要插话的委派记录 id（先用 pixie_dispatch_status 查到它）。",
	}),
	text: Type.String({
		description:
			"插入的消息：补充约束、修正方向，或要求汇报进度。这不是新任务——原任务继续执行。",
	}),
	mode: Type.Optional(
		Type.String({
			description:
				"append（默认，补充/修正，任务继续）或 checkpoint（进度检查点：要求被委派方先汇报进度，之后继续或暂停）。",
		}),
	),
	after: Type.Optional(
		Type.String({
			description: "仅 checkpoint 有效：continue（汇报后自动继续，默认）或 wait（汇报后暂停等用户指令）。",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"替换执行模型（provider/id）：下一轮起生效（同界面手动切换时机）。⚠️ 仅当用户明确授权更换模型时才传；缺省保持当前模型。",
		}),
	),
	thinkingLevel: Type.Optional(
		Type.String({
			description:
				"替换推理深度（off|minimal|low|medium|high|xhigh|max）：下一轮起生效。⚠️ 仅当用户明确授权时才传；缺省保持当前。",
		}),
	),
});

type InterjectParamsType = Static<typeof InterjectParams>;

/**
 * pixie_interject 工具壳（插话）：POST /api/pixie/interject。
 * 附属于进行中委派，非新任务；排队中/已结束的委派会收到可读错误。
 */
export function buildPixieInterjectTool(options: { getPort?: PixiePortReader } = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_INTERJECT_NAME,
		label: "Pixie interject",
		description:
			"向正在执行的委派任务插话（仅小精灵自己使用）。用户说「让它先汇报下进度」「补充一个要求」「先别动 X」时调用：append 模式补充约束不打断任务；checkpoint 模式要求对方汇报进度（after=wait 可让其汇报后暂停）。排队中或已结束的任务不能插话。",
		promptSnippet: "Interject a message into a running delegation",
		parameters: InterjectParams,
		async execute(_toolCallId, params: InterjectParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult("Error: 未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。");
			}
			const mode = params.mode === "checkpoint" ? "checkpoint" : "append";
			const after = params.after === "wait" ? "wait" : params.after === "continue" ? "continue" : undefined;
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_INTERJECT_PATH,
					body: {
						dispatchId: params.dispatchId,
						text: params.text,
						mode,
						...(mode === "checkpoint" && after ? { after } : {}),
						...(params.model !== undefined ? { model: params.model } : {}),
						...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
					},
				});
				const resolution = mapReportResponse(result);
				if (!resolution.ok) {
					return errorResult(`Error: ${resolution.error}`);
				}
				const modelNote =
					params.model || params.thinkingLevel
						? `模型/推理深度替换已应用（下一轮起生效）。`
						: "";
				return okResult(
					(mode === "checkpoint"
						? "检查点请求已送达：对方会先汇报进度，然后按你的指示继续或暂停。"
						: "插话已送达：对方在当前轮次结束后会收到你的补充。") + modelNote,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`Error: ${message}`);
			}
		},
	});
}

const StopParams = Type.Object({
	dispatchId: Type.String({
		description: "要叫停的委派记录 id（先用 pixie_dispatch_status 查到它）。",
	}),
	reason: Type.Optional(
		Type.String({ description: "叫停原因（会转述给用户，如「方向跑偏了」「派错了工作区」）。" }),
	),
});

type StopParamsType = Static<typeof StopParams>;

/**
 * pixie_stop 工具壳（叫停）：POST /api/pixie/stop。回执明确：
 * aborted（运行中已中断）/ already-stopped（本已停止）/ cancelled（排队中被取消）。
 */
export function buildPixieStopTool(options: { getPort?: PixiePortReader } = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_STOP_NAME,
		label: "Pixie stop",
		description:
			"叫停一个委派任务（仅小精灵自己使用）。用户说「把那个任务停了」「这个派错了」时调用：运行中的任务会被中断，排队中的会被取消。返回明确回执（停止成功/本已停止/排队已取消），停掉的不要自动重发。",
		promptSnippet: "Stop a delegated task with an explicit receipt",
		parameters: StopParams,
		async execute(_toolCallId, params: StopParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult("Error: 未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。");
			}
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_STOP_PATH,
					body: { dispatchId: params.dispatchId },
				});
				const resolution = mapStopResponse(result);
				if (!resolution.ok) {
					return errorResult(`Error: ${resolution.error}`);
				}
				const actionText =
					resolution.action === "aborted"
						? "已停止（执行中的任务被中断）"
						: resolution.action === "cancelled"
							? "已取消（排队中的任务被摘除，尚未开始执行）"
							: "该任务本已停止，无需重复操作";
				return okResult(`回执：${actionText}。${params.reason ? `原因已记录：${params.reason}` : ""}请向用户确认，不要自动重发该任务。`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`Error: ${message}`);
			}
		},
	});
}

const RetryParams = Type.Object({
	dispatchId: Type.String({
		description: "要重试的失败/被叫停委派记录 id。",
	}),
	mode: Type.Optional(
		Type.String({
			description:
				"resume（原地续跑：会话还活着时首选，从断点继续、上下文零丢失）或 redispatch（重派：会话已死时重新发起一条新委派）。省略则 Host 自动判定。",
		}),
	),
});

type RetryParamsType = Static<typeof RetryParams>;

/**
 * pixie_retry 工具壳（重试）：POST /api/pixie/retry。失败决策流的执行入口。
 */
export function buildPixieRetryTool(options: { getPort?: PixiePortReader } = {}): ToolDefinition {
	const getPort: PixiePortReader = options.getPort ?? readPixiePort;
	return defineTool({
		name: PIXIE_RETRY_NAME,
		label: "Pixie retry",
		description:
			"重试一个失败或被叫停的委派任务（仅小精灵自己使用）。会话活着用 resume 原地续跑（上下文零丢失）；会话死了用 redispatch 重派。方向性错误时先调整任务描述重新 pixie_dispatch，而不是盲目重试；同一任务失败 ≥3 次不要再重试，升级报告用户。",
		promptSnippet: "Retry a failed or stopped delegation",
		parameters: RetryParams,
		async execute(_toolCallId, params: RetryParamsType) {
			const port = getPort();
			if (port === null) {
				return errorResult("Error: 未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。");
			}
			const mode =
				params.mode === "resume" || params.mode === "redispatch" ? params.mode : undefined;
			try {
				const result = await pixieRequest({
					port,
					method: "POST",
					path: PIXIE_RETRY_PATH,
					body: {
						dispatchId: params.dispatchId,
						...(mode ? { mode } : {}),
					},
				});
				const resolution = mapRetryResponse(result);
				if (!resolution.ok) {
					return errorResult(`Error: ${resolution.error}`);
				}
				return okResult(
					`已重试（${mode === "redispatch" ? "重派新记录" : "原地续跑"}，dispatchId: ${resolution.dispatchId}）。等待其回调后转述结果。`,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`Error: ${message}`);
			}
		},
	});
}
