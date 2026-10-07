/**
 * pixie_report 的激活门控扩展。
 *
 * 语义（照搬原 pixie-tool.ts 的激活扩展）：工具注册在每个会话上，但在
 * before_agent_start 里按门控结果把它加入/移出 active tools——普通工作区
 * 会话永远看不到该工具。
 *
 * 门控来源：Host 侧环回控制面 GET /api/pixie/dispatch-state?sessionId=<当前
 * 会话id>，响应 { armed: boolean }。端口环境变量缺失或请求失败一律视为未
 * armed（不激活），且不得让 agent 启动失败。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PIXIE_REPORT_NAME } from "./pixie-tools.js";
import { readPixiePort, pixieRequest } from "./http-client.js";
import { PIXIE_DISPATCH_STATE_PATH, mapDispatchStateResponse } from "./protocol.js";

/** 从事件 ctx 安全取当前会话 id（拿不到返回 null，绝不抛出）。 */
export function sessionIdFromCtx(ctx?: ExtensionContext): string | null {
	try {
		return ctx?.sessionManager?.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

/** 查询 Host：本会话是否有进行中的委派（armed）。任何失败都视为未 armed。 */
export async function queryPixieDispatchArmed(input: {
	port: number | null;
	sessionId: string | null;
}): Promise<boolean> {
	return (await queryPixieDispatchState(input)).armed;
}

export type DispatchStateResult = { armed: boolean; ok: boolean };

/**
 * 查询 armed 状态并区分「确认未 armed」与「查询失败」：ok=false 表示传输
 * 失败（超时/连接拒绝/非 200/非法 JSON），调用方可据此做退避。
 */
export async function queryPixieDispatchState(input: {
	port: number | null;
	sessionId: string | null;
}): Promise<DispatchStateResult> {
	if (input.port === null || !input.sessionId) return { armed: false, ok: false };
	try {
		const result = await pixieRequest({
			port: input.port,
			method: "GET",
			path: `${PIXIE_DISPATCH_STATE_PATH}?sessionId=${encodeURIComponent(input.sessionId)}`,
		});
		return { ...mapDispatchStateResponse(result), ok: true };
	} catch {
		return { armed: false, ok: false };
	}
}

/** 会话 id 读取器：默认从 before_agent_start 的 ctx 取，测试可注入。 */
export type SessionIdReader = (ctx?: ExtensionContext) => string | null;

/**
 * 创建激活扩展工厂：每个会话实例在 before_agent_start 重新评估门控，
 * armed → report 工具进入 active tools；否则从 active tools 剪除。
 * 门控查询失败/超时绝不抛出（不能让 agent 启动失败）。
 */
export function createPixieReportActivationExtension(options: {
	getPort?: () => number | null;
	getSessionId?: SessionIdReader;
	/** 查询失败后的退避间隔；Host 挂死时避免每轮都阻塞 3 秒。 */
	failureBackoffMs?: number;
} = {}): (pi: ExtensionAPI) => void {
	const getPort = options.getPort ?? readPixiePort;
	const getSessionId: SessionIdReader = options.getSessionId ?? sessionIdFromCtx;
	const failureBackoffMs = options.failureBackoffMs ?? 30_000;
	let lastFailureAt = Number.NEGATIVE_INFINITY;
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (_event, ctx) => {
			let armed = false;
			try {
				const port = getPort();
				const sessionId = getSessionId(ctx);
				// 退避窗口内的失败不再重复查询（视为未 armed）；Host 健康时仍每轮实时评估。
				const skipBackoff = Date.now() - lastFailureAt < failureBackoffMs;
				if (port !== null && sessionId !== null && !skipBackoff) {
					const state = await queryPixieDispatchState({ port, sessionId });
					if (state.ok) {
						armed = state.armed;
					} else {
						lastFailureAt = Date.now();
					}
				}
			} catch {
				armed = false;
			}
			// 门控查询之后再读 active tools：await 期间集合可能变化，以最新为准。
			let active: string[];
			try {
				active = pi.getActiveTools();
			} catch {
				return;
			}
			const hasReport = active.includes(PIXIE_REPORT_NAME);
			if (armed && !hasReport) {
				pi.setActiveTools([...active, PIXIE_REPORT_NAME]);
			} else if (!armed && hasReport) {
				pi.setActiveTools(active.filter((name) => name !== PIXIE_REPORT_NAME));
			}
		});
	};
}
