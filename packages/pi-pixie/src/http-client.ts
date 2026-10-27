/**
 * Pixie 环回 HTTP 客户端（node:http 直连 127.0.0.1）。
 *
 * 必须用 node:http 而不是全局 fetch：桌面宿主会给进程注入代理设置，
 * 全局 fetch 走系统代理会被拦截，环回控制面必须直连。这里只负责请求构造
 * （method/path/body/headers）、超时控制（默认 3 秒）与原始响应读取，
 * 不做业务语义映射（响应映射见 protocol.ts）。
 */
import { request as httpRequest, type IncomingMessage } from "node:http";

/** Host 侧环回控制面端口经此环境变量下发。 */
export const PIXIE_PORT_ENV = "PI_PIXIE_HTTP_PORT";
/** 旧版桌面宿主的遗留变量名（新名未设置时兑底读取，跨版本兼容）。 */
export const PIXIE_PORT_ENV_LEGACY = "PIABYSS_PIXIE_HTTP_PORT";
/** 控制面鉴权 token（v4：Host 启动生成，经此环境变量下发）。 */
export const PIXIE_TOKEN_ENV = "PI_PIXIE_HTTP_TOKEN";
export const PIXIE_TOKEN_ENV_LEGACY = "PIABYSS_PIXIE_HTTP_TOKEN";
/** 常驻小精灵会话标记（v3 兼容：Host 在该会话注入；v4 由 cwd 比较接管）。 */
export const PIXIE_RESIDENT_ENV = "PI_PIXIE_RESIDENT";
export const PIXIE_RESIDENT_ENV_LEGACY = "PIABYSS_PIXIE_RESIDENT";

/** 单请求超时：3 秒。 */
export const PIXIE_HTTP_TIMEOUT_MS = 3000;
/**
 * dispatch 单独放宽到 15 秒：委派是「受理」语义，Host 侧最重的一步是打开
 * 目标工作区的后台图（实测 0.9–3.3s，冷启动更久），3 秒预算会让请求实际
 * 已被受理却回「委派失败」，进而诱发重复派单。
 */
export const PIXIE_DISPATCH_TIMEOUT_MS = 15_000;
export const PIXIE_LOOPBACK_HOST = "127.0.0.1";

/** 读取并校验环回控制面端口；未设置或非法返回 null。 */
export function readPixiePort(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env[PIXIE_PORT_ENV] ?? env[PIXIE_PORT_ENV_LEGACY];
	if (!raw) return null;
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return port;
}

/** 读取并校验环回控制面 token；未设置返回 null（请求不带鉴权头）。 */
export function readPixieToken(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env[PIXIE_TOKEN_ENV] ?? env[PIXIE_TOKEN_ENV_LEGACY];
	const trimmed = raw?.trim();
	return trimmed ? trimmed : null;
}

export type PixieHttpResult = { status: number; body: string };

export type PixieRequestMethod = "GET" | "POST";

export type PixieRequestOptions = {
	port: number;
	method: PixieRequestMethod;
	path: string;
	/** POST JSON body（会被序列化）；GET 不传。 */
	body?: unknown;
	timeoutMs?: number;
	/** 鉴权 token；缺省读 PI_PIXIE_HTTP_TOKEN。 */
	token?: string | null;
};

/** 组装请求 headers（独立出来便于测试请求构造）。 */
export function buildRequestHeaders(
	method: PixieRequestMethod,
	body: unknown,
	token: string | null = readPixieToken(),
): Record<string, string> {
	const headers: Record<string, string> = { host: `${PIXIE_LOOPBACK_HOST}` };
	if (token) {
		// 双头下发：`x-pixie-token` 是通用命名；`x-piabyss-pixie-token` 是旧版
		// 桌面宿主的鉴权头，保留为跨版本兼容（宿主只认其一即可）。
		headers["x-pixie-token"] = token;
		headers["x-piabyss-pixie-token"] = token;
	}
	if (method === "POST") {
		headers["content-type"] = "application/json";
		headers["content-length"] = String(Buffer.byteLength(JSON.stringify(body ?? {}), "utf8"));
	}
	return headers;
}

/** 序列化请求体（POST 专用，独立出来便于测试请求构造）。 */
export function serializeRequestBody(body: unknown): string {
	return JSON.stringify(body ?? {});
}

/**
 * 发起一次环回请求并读取完整响应体。
 * 超时或 socket 错误时 reject，错误消息可读（含 method 与 path）；
 * 非 2xx 不算传输错误，由调用方结合 status/body 做业务映射。
 */
export function pixieRequest(options: PixieRequestOptions): Promise<PixieHttpResult> {
	const timeoutMs = options.timeoutMs ?? PIXIE_HTTP_TIMEOUT_MS;
	const hasBody = options.method === "POST";
	const payload = hasBody ? serializeRequestBody(options.body) : undefined;
	return new Promise<PixieHttpResult>((resolve, reject) => {
		const req = httpRequest({
			host: PIXIE_LOOPBACK_HOST,
			port: options.port,
			method: options.method,
			path: options.path,
			headers: buildRequestHeaders(options.method, options.body, options.token ?? readPixieToken()),
		});
		let settled = false;
		// 墙钟总时长兑底：req.setTimeout 只是 socket 空闲超时，Host 缓慢
		// 持续发送时总耗时无上界，这里保证单请求绝不超过 timeoutMs。
		const wallClock = setTimeout(() => {
			if (settled) return;
			settled = true;
			req.destroy();
			reject(new Error(`环回请求超时（${timeoutMs}ms）：${options.method} ${options.path}`));
		}, timeoutMs);
		const settle = <T>(fn: () => void): void => {
			clearTimeout(wallClock);
			if (settled) return;
			settled = true;
			fn();
		};
		const fail = (error: Error): void => {
			settle(() => reject(new Error(`环回请求失败：${error.message}（${options.method} ${options.path}）`)));
		};
		req.setTimeout(timeoutMs, () => {
			if (settled) return;
			req.destroy();
			fail(new Error(`超时（${timeoutMs}ms）`));
		});
		req.on("error", fail);
		req.on("response", (res: IncomingMessage) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("error", fail);
			res.on("end", () => {
				settle(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			});
		});
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}
