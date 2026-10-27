/**
 * Pixie 环回控制面的响应映射与工具文本格式。
 *
 * 文本格式与桌面宿主内置实现（pixie-tool.ts）逐字节一致：
 * - dispatch 成功：`已派发到工作区会话（sessionId: …）。等待其回调 pixie_report 后再向用户转述。`
 * - dispatch 失败：`委派失败：…`（isError）
 * - report 成功：`已回调小精灵。…`
 * - report 失败：`Error: …`（isError，沿用原 report 工具的错误前缀）
 */
import type { PixieHttpResult } from "./http-client.js";

/** 环回控制面端点路径。 */
export const PIXIE_DISPATCH_PATH = "/api/pixie/dispatch";
export const PIXIE_REPORT_PATH = "/api/pixie/report";
export const PIXIE_ASK_PATH = "/api/pixie/ask";
export const PIXIE_NAME_PATH = "/api/pixie/name";
export const PIXIE_INJECT_PATH = "/api/pixie/inject";
export const PIXIE_DISPATCH_STATE_PATH = "/api/pixie/dispatch-state";
export const PIXIE_INTERJECT_PATH = "/api/pixie/interject";
export const PIXIE_STOP_PATH = "/api/pixie/stop";
export const PIXIE_RETRY_PATH = "/api/pixie/retry";
export const PIXIE_DISPATCHES_PATH = "/api/pixie/dispatches";
/** v4.3：小精灵会话缓存（自己创建的会话 + 被委托会话的简介/结果）。 */
export const PIXIE_SESSIONS_PATH = "/api/pixie/sessions";

export type PixieDispatchSuccess = {
	ok: true;
	dispatchId: string;
	sessionId: string;
	sessionPath: string;
	queued: boolean;
	/**
	 * v4.3：true = 复用了既有会话（是小精灵自己创建的会话）；false = 新开会话。
	 * 旧 Host 不给该字段时省略（回执文案退化为不标落点）。
	 */
	reused?: boolean;
	/** queued=true 时 Host 给出的排队说明（等待/取消/新会话并行提示）。 */
	queuedNote?: string;
};
export type PixieDispatchFailure = { ok: false; error: string };
export type PixieDispatchResolution = PixieDispatchSuccess | PixieDispatchFailure;

export type PixieReportResolution = { ok: true } | { ok: false; error: string };

export type PixieAskResolution = { ok: true } | { ok: false, error: string };
export type PixieNameResolution = { ok: true } | { ok: false; error: string };

/** pixie_stop 的回执动作。 */
export type PixieStopAction = "aborted" | "already-stopped" | "cancelled";
export type PixieStopResolution =
	| { ok: true; action: PixieStopAction }
	| { ok: false; error: string };

/** pixie_retry 的回执（resume → 原 dispatchId；redispatch → 新 dispatchId）。 */
export type PixieRetryResolution =
	| { ok: true; dispatchId: string }
	| { ok: false; error: string };

/** 查岗返回的单条委派记录（Host PixieDispatchRecord 的宽松投影）。 */
export type PixieDispatchSummary = {
	id: string;
	status: string;
	kind: string | null;
	cwd: string;
	sessionId: string | null;
	task: string;
	report: string | null;
	question: string | null;
	options: string[];
	createdAt: number;
	startedAt: number | null;
	reportedAt: number | null;
	lastActiveAt: number | null;
	stale: boolean;
	batchId: string | null;
	failCount: number;
	progressSummary: string | null;
	files: string[] | null;
	retryOf: string | null;
};

export type PixieDispatchListResolution =
	| { ok: true; dispatches: PixieDispatchSummary[] }
	| { ok: false; error: string };

/** 会话缓存条目（Host PixieSessionCacheEntry 的宽松投影）。 */
export type PixieSessionSummary = {
	sessionId: string;
	sessionPath: string;
	/** 所属工作区（规范化 cwd）。 */
	cwd: string;
	/** pixie = 小精灵创建（自动落点可复用）；user = 用户创建（仅显式给出 id 时可委托）。 */
	owner: "pixie" | "user";
	/** pixie = 小精灵自己的工作区会话；delegated = 被委托干活的工作区会话。 */
	role: "pixie" | "delegated";
	/** 会话简介（≤120 字）。 */
	summary: string;
	/** 最近结果摘要（来自委派回调）。 */
	result: string | null;
	createdAt: number;
	lastActiveAt: number;
	dispatchIds: string[];
	reuseCount: number;
};

export type PixieSessionListResolution =
	| { ok: true; sessions: PixieSessionSummary[] }
	| { ok: false; error: string };

/**
 * GET /api/pixie/dispatch-state 响应 → { armed, dispatchId, kind? }。
 * 非 200（含 401 鉴权失败）/ 解析失败 / 缺字段一律视为未 armed（激活门控与
 * report/ask 执行的保守语义）。armed 时应携带 dispatchId（Host 侧登记的进行
 * 中委派记录 id），供 report/ask 回填；kind 为该记录当前的回调种类（可缺省，
 * 旧 Host 兼容；v4.1 扩展 progress/stopped）。
 */
export type PixieDispatchState = {
	armed: boolean;
	dispatchId: string | null;
	kind: "done" | "error" | "ask" | "progress" | "stopped" | null;
};

export function mapDispatchStateResponse(result: PixieHttpResult): PixieDispatchState {
	if (result.status !== 200) return { armed: false, dispatchId: null, kind: null };
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { armed: false, dispatchId: null, kind: null };
	const value = parsed.value;
	if (!isRecord(value) || typeof value.armed !== "boolean") {
		return { armed: false, dispatchId: null, kind: null };
	}
	const dispatchId = typeof value.dispatchId === "string" && value.dispatchId.trim() ? value.dispatchId : null;
	const kind =
		value.kind === "done" ||
		value.kind === "error" ||
		value.kind === "ask" ||
		value.kind === "progress" ||
		value.kind === "stopped"
			? value.kind
			: null;
	return { armed: value.armed, dispatchId, kind };
}

function snippet(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "(空响应体)";
	return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function readErrorField(value: unknown): string {
	if (typeof value === "string" && value.trim()) return value;
	return "未知错误";
}

/** 解析响应体 JSON；失败给出可读错误。 */
export function parseJsonBody(body: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(body) as unknown };
	} catch {
		return { ok: false, error: `环回控制面响应不是合法 JSON：${snippet(body)}` };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POST /api/pixie/dispatch 响应 → 工具结果（非 200/解析失败/ok:false 都归一为失败）。 */
export function mapDispatchResponse(result: PixieHttpResult): PixieDispatchResolution {
	if (result.status !== 200) {
		return { ok: false, error: `环回控制面返回非 200（${result.status}）：${snippet(result.body)}` };
	}
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const value = parsed.value;
	if (!isRecord(value)) {
		return { ok: false, error: `环回控制面响应结构不符合预期：${snippet(result.body)}` };
	}
	if (value.ok !== true) {
		return { ok: false, error: readErrorField(value.error) };
	}
	if (
		typeof value.dispatchId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.sessionPath !== "string" ||
		typeof value.queued !== "boolean"
	) {
		return { ok: false, error: `环回控制面成功响应缺少必要字段：${snippet(result.body)}` };
	}
	return {
		ok: true,
		dispatchId: value.dispatchId,
		sessionId: value.sessionId,
		sessionPath: value.sessionPath,
		queued: value.queued,
		...(typeof value.reused === "boolean" ? { reused: value.reused } : {}),
		...(typeof value.queuedNote === "string" && value.queuedNote ? { queuedNote: value.queuedNote } : {}),
	};
}

/** POST /api/pixie/report 响应 → 工具结果。 */
export function mapReportResponse(result: PixieHttpResult): PixieReportResolution {
	if (result.status !== 200) {
		return { ok: false, error: `环回控制面返回非 200（${result.status}）：${snippet(result.body)}` };
	}
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const value = parsed.value;
	if (!isRecord(value)) {
		return { ok: false, error: `环回控制面响应结构不符合预期：${snippet(result.body)}` };
	}
	if (value.ok !== true) {
		return { ok: false, error: readErrorField(value.error) };
	}
	return { ok: true };
}

/** POST /api/pixie/ask 响应 → 工具结果（与 report 同构）。 */
export function mapAskResponse(result: PixieHttpResult): PixieAskResolution {
	return mapReportResponse(result);
}

/** POST /api/pixie/name 响应 → 工具结果（与 report 同构）。 */
export function mapNameResponse(result: PixieHttpResult): PixieNameResolution {
	return mapReportResponse(result);
}

/** POST /api/pixie/stop 响应 → 回执（aborted / already-stopped / cancelled）。 */
export function mapStopResponse(result: PixieHttpResult): PixieStopResolution {
	if (result.status !== 200) {
		return { ok: false, error: `环回控制面返回非 200（${result.status}）：${snippet(result.body)}` };
	}
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const value = parsed.value;
	if (!isRecord(value) || value.ok !== true) {
		return { ok: false, error: isRecord(value) ? readErrorField(value.error) : snippet(result.body) };
	}
	const action =
		value.action === "aborted" || value.action === "already-stopped" || value.action === "cancelled"
			? value.action
			: null;
	if (!action) {
		return { ok: false, error: `停止回执缺少 action 字段：${snippet(result.body)}` };
	}
	return { ok: true, action };
}

/** POST /api/pixie/retry 响应 → 回执（resume 原记录 / redispatch 新记录）。 */
export function mapRetryResponse(result: PixieHttpResult): PixieRetryResolution {
	if (result.status !== 200) {
		return { ok: false, error: `环回控制面返回非 200（${result.status}）：${snippet(result.body)}` };
	}
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const value = parsed.value;
	if (!isRecord(value) || value.ok !== true) {
		return { ok: false, error: isRecord(value) ? readErrorField(value.error) : snippet(result.body) };
	}
	if (typeof value.dispatchId !== "string" || !value.dispatchId) {
		return { ok: false, error: `重试回执缺少 dispatchId：${snippet(result.body)}` };
	}
	return { ok: true, dispatchId: value.dispatchId };
}

/** GET /api/pixie/dispatches 响应 → 委派记录列表（查岗数据源）。 */
export function mapDispatchListResponse(result: PixieHttpResult): PixieDispatchListResolution {
	if (result.status !== 200) {
		return { ok: false, error: `环回控制面返回非 200（${result.status}）：${snippet(result.body)}` };
	}
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const value = parsed.value;
	if (!isRecord(value) || value.ok !== true || !Array.isArray(value.dispatches)) {
		return { ok: false, error: `环回控制面响应结构不符合预期：${snippet(result.body)}` };
	}
	const dispatches: PixieDispatchSummary[] = [];
	for (const item of value.dispatches) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.task !== "string") continue;
		dispatches.push({
			id: item.id,
			status: typeof item.status === "string" ? item.status : "unknown",
			kind: typeof item.kind === "string" ? item.kind : null,
			cwd: typeof item.cwd === "string" ? item.cwd : "",
			sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
			task: item.task,
			report: typeof item.report === "string" ? item.report : null,
			question: typeof item.question === "string" ? item.question : null,
			options: Array.isArray(item.options)
				? item.options.filter((option): option is string => typeof option === "string")
				: [],
			createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
			startedAt: typeof item.startedAt === "number" ? item.startedAt : null,
			reportedAt: typeof item.reportedAt === "number" ? item.reportedAt : null,
			lastActiveAt: typeof item.lastActiveAt === "number" ? item.lastActiveAt : null,
			stale: item.stale === true,
			batchId: typeof item.batchId === "string" ? item.batchId : null,
			failCount: typeof item.failCount === "number" ? item.failCount : 0,
			progressSummary: typeof item.progressSummary === "string" ? item.progressSummary : null,
			files: Array.isArray(item.files)
				? item.files.filter((file): file is string => typeof file === "string")
				: null,
			retryOf: typeof item.retryOf === "string" ? item.retryOf : null,
		});
	}
	return { ok: true, dispatches };
}

/** GET /api/pixie/sessions 响应 → 会话缓存列表（会话缓存工具的数据源）。 */
export function mapSessionListResponse(result: PixieHttpResult): PixieSessionListResolution {
	if (result.status !== 200) {
		return { ok: false, error: `环回控制面返回非 200（${result.status}）：${snippet(result.body)}` };
	}
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const value = parsed.value;
	if (!isRecord(value) || value.ok !== true || !Array.isArray(value.sessions)) {
		return { ok: false, error: `环回控制面响应结构不符合预期：${snippet(result.body)}` };
	}
	const sessions: PixieSessionSummary[] = [];
	for (const item of value.sessions) {
		if (!isRecord(item) || typeof item.sessionId !== "string") continue;
		sessions.push({
			sessionId: item.sessionId,
			sessionPath: typeof item.sessionPath === "string" ? item.sessionPath : "",
			cwd: typeof item.cwd === "string" ? item.cwd : "",
			owner: item.owner === "user" ? "user" : "pixie",
			role: item.role === "pixie" ? "pixie" : "delegated",
			summary: typeof item.summary === "string" ? item.summary : "",
			result: typeof item.result === "string" ? item.result : null,
			createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
			lastActiveAt: typeof item.lastActiveAt === "number" ? item.lastActiveAt : 0,
			dispatchIds: Array.isArray(item.dispatchIds)
				? item.dispatchIds.filter((id): id is string => typeof id === "string")
				: [],
			reuseCount: typeof item.reuseCount === "number" ? item.reuseCount : 0,
		});
	}
	return { ok: true, sessions };
}

function formatClock(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "未知";
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 会话缓存列表 → 工具文本。按归属分两组：可自动复用的（小精灵自己建的）与
 * 用户会话（仅在用户明确给出 id 时才可委托）。
 */
export function formatSessionListText(sessions: PixieSessionSummary[], cwd?: string): string {
	const scope = cwd ? `（工作区：${cwd}）` : "";
	if (sessions.length === 0) {
		return `小精灵的会话缓存里还没有记录${scope}：该工作区尚无小精灵创建的会话（下次委派会自动新开一个并登记）。`;
	}
	const owned = sessions.filter((item) => item.owner === "pixie");
	const users = sessions.filter((item) => item.owner === "user");
	const lines: string[] = [`小精灵会话缓存${scope}（共 ${sessions.length} 条）：`];
	const describe = (item: PixieSessionSummary): string[] => {
		const head = [
			`- [${item.role === "pixie" ? "小精灵会话" : "委派会话"}] ${item.cwd}`,
			`  sessionId: ${item.sessionId}${item.reuseCount > 0 ? `  复用 ${item.reuseCount} 次` : ""}  最近活跃: ${formatClock(item.lastActiveAt)}`,
		];
		if (item.summary) head.push(`  简介: ${item.summary}`);
		if (item.result) head.push(`  结果: ${item.result}`);
		return head;
	};
	if (owned.length > 0) {
		lines.push("【可自动复用：小精灵自己创建的会话】", ...owned.flatMap(describe));
	}
	if (users.length > 0) {
		lines.push(
			"【用户自己的会话：只有用户在此对话里明确给出其 sessionId 时才能委托】",
			...users.flatMap(describe),
		);
	}
	return lines.join("\n");
}

/**
 * GET /api/pixie/dispatch-state 响应 → { armed }。
 * 非 200 / 解析失败 / 缺字段一律视为未 armed（激活门控的保守语义）。
 * 映射见上方 mapDispatchStateResponse（dispatch-state 响应含可选 dispatchId）。
 */

// ── 工具文本格式（与原 pixie-tool.ts 逐字节一致）──────────────

/** pixie_dispatch 成功文本（直接执行 / 引擎排队两种语义）。 */
export function formatDispatchSuccessText(resolution: {
	dispatchId?: string;
	sessionId: string;
	queued: boolean;
	reused?: boolean;
	queuedNote?: string;
}): string {
	// 落点必须让用户看得见：复用既有会话 / 新开会话（旧 Host 无 reused 时不标）。
	const landing =
		resolution.reused === undefined
			? ""
			: resolution.reused
				? "（复用了该工作区里小精灵自己创建的会话）"
				: "（新开了一个干净会话）";
	if (resolution.queued && resolution.queuedNote) {
		return `已受理（dispatchId: ${resolution.dispatchId ?? ""}）。${resolution.queuedNote}`;
	}
	if (resolution.queued) {
		return `已派发到工作区会话（sessionId: ${resolution.sessionId}${landing}，该会话当前忙，任务已排队）。等待其回调 pixie_report 后再向用户转述。`;
	}
	return `已派发到工作区会话（sessionId: ${resolution.sessionId}${landing}）。等待其回调 pixie_report 后再向用户转述。`;
}

/** pixie_dispatch 失败文本。 */
export function formatDispatchFailureText(error: string): string {
	return `委派失败：${error}`;
}

/** pixie_report 成功文本。 */
export const PIXIE_REPORT_SUCCESS_TEXT =
	"已回调小精灵。用户会在小精灵对话里看到你的结果转述；本会话可以继续接受新任务。";

/** pixie_report 失败文本（沿用原 report 工具的 Error: 前缀）。 */
export function formatReportFailureText(error: string): string {
	return `Error: ${error}`;
}

/** pixie_ask 成功文本。 */
export const PIXIE_ASK_SUCCESS_TEXT =
	"问题已转交小精灵转述给用户。用户答复会以 <pixie-reply> 信封回到本会话，届时请继续执行。";

/** pixie_ask 失败文本。 */
export function formatAskFailureText(error: string): string {
	return `Error: ${error}`;
}

/** pixie_name 成功文本。 */
export function formatNameSuccessText(name: string): string {
	return `已把本段会话名设为「${name}」。`;
}

/** pixie_name 失败文本。 */
export function formatNameFailureText(error: string): string {
	return `Error: ${error}`;
}
