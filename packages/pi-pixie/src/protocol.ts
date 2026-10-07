/**
 * Pixie 环回控制面的响应映射与工具文本格式。
 *
 * 文本格式与 PiAbyss 内置实现（packages/pi-host/src/pixie-tool.ts）逐字节一致：
 * - dispatch 成功：`已派发到工作区会话（sessionId: …）。等待其回调 pixie_report 后再向用户转述。`
 * - dispatch 失败：`委派失败：…`（isError）
 * - report 成功：`已回调小精灵。…`
 * - report 失败：`Error: …`（isError，沿用原 report 工具的错误前缀）
 */
import type { PixieHttpResult } from "./http-client.js";

/** 环回控制面端点路径。 */
export const PIXIE_DISPATCH_PATH = "/api/pixie/dispatch";
export const PIXIE_REPORT_PATH = "/api/pixie/report";
export const PIXIE_DISPATCH_STATE_PATH = "/api/pixie/dispatch-state";

export type PixieDispatchSuccess = {
	ok: true;
	dispatchId: string;
	sessionId: string;
	sessionPath: string;
	queued: boolean;
};
export type PixieDispatchFailure = { ok: false; error: string };
export type PixieDispatchResolution = PixieDispatchSuccess | PixieDispatchFailure;

export type PixieReportResolution = { ok: true } | { ok: false; error: string };

/**
 * GET /api/pixie/dispatch-state 响应 → { armed, dispatchId }。
 * 非 200 / 解析失败 / 缺字段一律视为未 armed（激活门控与 report 执行的保守语义）。
 * armed 时应携带 dispatchId（Host 侧登记的进行中委派记录 id），供 report 回填。
 */
export type PixieDispatchState = { armed: boolean; dispatchId: string | null };

export function mapDispatchStateResponse(result: PixieHttpResult): PixieDispatchState {
	if (result.status !== 200) return { armed: false, dispatchId: null };
	const parsed = parseJsonBody(result.body);
	if (!parsed.ok) return { armed: false, dispatchId: null };
	const value = parsed.value;
	if (!isRecord(value) || typeof value.armed !== "boolean") return { armed: false, dispatchId: null };
	const dispatchId = typeof value.dispatchId === "string" && value.dispatchId.trim() ? value.dispatchId : null;
	return { armed: value.armed, dispatchId };
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

/**
 * GET /api/pixie/dispatch-state 响应 → { armed }。
 * 非 200 / 解析失败 / 缺字段一律视为未 armed（激活门控的保守语义）。
 * 映射见上方 mapDispatchStateResponse（dispatch-state 响应含可选 dispatchId）。
 */

// ── 工具文本格式（与原 pixie-tool.ts 逐字节一致）──────────────

/** pixie_dispatch 成功文本（含 queued 与否的区分文案）。 */
export function formatDispatchSuccessText(resolution: { sessionId: string; queued: boolean }): string {
	return `已派发到工作区会话（sessionId: ${resolution.sessionId}${resolution.queued ? "，该会话当前忙，任务已排队" : ""}）。等待其回调 pixie_report 后再向用户转述。`;
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
