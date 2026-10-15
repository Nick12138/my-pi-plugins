/**
 * pi-pixie 会话角色判定 + report/ask 激活门控扩展。
 *
 * 角色判定（v4）：每个 before_agent_start 按 ctx.cwd 与解析后的小精灵工作区
 * 路径比较（Windows 大小写归一），命中 → 小精灵会话（dispatch/rest 常驻
 * active）；否则 → 普通会话。PIABYSS_PIXIE_RESIDENT=1 保留为旧 Host 的兼容
 * 判定（v3 环境变量窗口）。工作区路径来自 PIABYSS_PIXIE_WORKSPACE（支持
 * {agentDir} 占位符），留空 = <agentDir>/workspace/pixie。
 *
 * 激活门控（普通会话）：report/ask 工具注册在每个会话上，但在
 * before_agent_start 里按门控结果统一加入/移出 active tools——普通工作区
 * 会话永远看不到这两个工具。门控来源：Host 侧环回控制面 GET
 * /api/pixie/dispatch-state?sessionId=<当前会话id>，响应 { armed, kind }。
 * 端口环境变量缺失或请求失败一律视为未 armed（不激活），且不得让 agent
 * 启动失败。401（token 不匹配/旧插件）同样落入保守降级。
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	PIXIE_ASK_NAME,
	PIXIE_DISPATCH_NAME,
	PIXIE_INTERJECT_NAME,
	PIXIE_RECALL_NAME,
	PIXIE_REPORT_NAME,
	PIXIE_REST_NAME,
	PIXIE_RETRY_NAME,
	PIXIE_SESSIONS_NAME,
	PIXIE_STATUS_NAME,
	PIXIE_STOP_NAME,
} from "./pixie-tools.js";
import { readPixiePort, pixieRequest } from "./http-client.js";
import { PIXIE_DISPATCH_STATE_PATH, mapDispatchStateResponse } from "./protocol.js";

/** 小精灵工作区路径环境变量（与 plugins.json config[].env 对应）。 */
export const PIXIE_WORKSPACE_ENV = "PIABYSS_PIXIE_WORKSPACE";

/** 解析小精灵工作区路径（与 Host 侧 resolvePixieWorkspacePath 同构）。 */
export function resolvePixieWorkspacePath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME ?? env.USERPROFILE ?? ".", ".pi", "agent");
	const configured = env[PIXIE_WORKSPACE_ENV]?.trim();
	if (!configured) return join(agentDir, "workspace", "pixie");
	return join(configured.replaceAll("{agentDir}", agentDir));
}

function normalizePathForCompare(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/** cwd 是否为小精灵工作区（Windows 忽略大小写）。 */
export function isPixieWorkspaceCwd(cwd: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!cwd) return false;
	return normalizePathForCompare(cwd) === normalizePathForCompare(resolvePixieWorkspacePath(env));
}

/** 从事件 ctx 安全取当前会话 id（拿不到返回 null，绝不抛出）。 */
export function sessionIdFromCtx(ctx?: ExtensionContext): string | null {
	try {
		return ctx?.sessionManager?.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

/** 本会话是否为常驻小精灵会话（工作区 cwd 匹配，或旧 Host 的 env 标记）。 */
export function isPixieResidentSession(ctx?: ExtensionContext): boolean {
	try {
		return isPixieWorkspaceCwd(ctx?.cwd) || process.env.PIABYSS_PIXIE_RESIDENT === "1";
	} catch {
		return false;
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
 * 失败（超时/连接拒绝/非 200/非法 JSON/401），调用方可据此做退避。
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
 * 创建激活扩展工厂：每个会话实例在 before_agent_start 重新评估角色与门控。
 *
 * - 小精灵工作区会话（cwd 匹配或旧 env 标记）：dispatch/rest 钉回 active
 *   tools，report/ask 移出——委派工具从第一轮就可用。
 * - 普通会话：dispatch/rest 移出；armed → report/ask 进入 active tools，
 *   否则剪除。门控查询失败/超时绝不抛出（不能让 agent 启动失败）。
 */
export function createPixieReportActivationExtension(options: {
	getPort?: () => number | null;
	getSessionId?: SessionIdReader;
	isResident?: (ctx?: ExtensionContext) => boolean;
	/** 查询失败后的退避间隔；Host 挂死时避免每轮都阻塞 3 秒。 */
	failureBackoffMs?: number;
} = {}): (pi: ExtensionAPI) => void {
	const getPort = options.getPort ?? readPixiePort;
	const getSessionId: SessionIdReader = options.getSessionId ?? sessionIdFromCtx;
	const isResident = options.isResident ?? isPixieResidentSession;
	const failureBackoffMs = options.failureBackoffMs ?? 30_000;
	let lastFailureAt = Number.NEGATIVE_INFINITY;
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (_event, ctx) => {
			const resident = (() => {
				try {
					return isResident(ctx);
				} catch {
					return false;
				}
			})();
			let armed = false;
			if (!resident) {
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
			}
			// 门控查询之后再读 active tools：await 期间集合可能变化，以最新为准。
			let active: string[];
			try {
				active = pi.getActiveTools();
			} catch {
				return;
			}
			const residentTools = [
				PIXIE_DISPATCH_NAME,
				PIXIE_REST_NAME,
				PIXIE_RECALL_NAME,
				PIXIE_STATUS_NAME,
				PIXIE_SESSIONS_NAME,
				PIXIE_INTERJECT_NAME,
				PIXIE_STOP_NAME,
				PIXIE_RETRY_NAME,
			];
			const delegatedTools = [PIXIE_REPORT_NAME, PIXIE_ASK_NAME];
			let next = active;
			if (resident) {
				for (const name of delegatedTools) {
					next = next.filter((tool) => tool !== name);
				}
				for (const name of residentTools) {
					if (!next.includes(name)) next = [...next, name];
				}
			} else {
				for (const name of residentTools) {
					next = next.filter((tool) => tool !== name);
				}
				for (const name of delegatedTools) {
					const has = next.includes(name);
					const wanted = armed;
					if (wanted && !has) next = [...next, name];
					else if (!wanted && has) next = next.filter((tool) => tool !== name);
				}
			}
			if (next.length !== active.length || next.some((tool, index) => tool !== active[index])) {
				pi.setActiveTools(next);
			}
		});
	};
}
