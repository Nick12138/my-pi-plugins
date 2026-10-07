/**
 * Pixie 环回 HTTP 客户端（node:http 直连 127.0.0.1）。
 *
 * 必须用 node:http 而不是全局 fetch：PiAbyss Host 会给进程注入代理设置，
 * 全局 fetch 走系统代理会被拦截，环回控制面必须直连。这里只负责请求构造
 * （method/path/body/headers）、超时控制（默认 3 秒）与原始响应读取，
 * 不做业务语义映射（响应映射见 protocol.ts）。
 */
import { request as httpRequest, type IncomingMessage } from "node:http";

/** Host 侧环回控制面端口经此环境变量下发。 */
export const PIXIE_PORT_ENV = "PIABYSS_PIXIE_HTTP_PORT";
/** 常驻小精灵会话标记（Host 在该会话注入）。 */
export const PIXIE_RESIDENT_ENV = "PIABYSS_PIXIE_RESIDENT";

/** 单请求超时：3 秒。 */
export const PIXIE_HTTP_TIMEOUT_MS = 3000;
export const PIXIE_LOOPBACK_HOST = "127.0.0.1";

/** 读取并校验环回控制面端口；未设置或非法返回 null。 */
export function readPixiePort(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env[PIXIE_PORT_ENV];
	if (!raw) return null;
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return port;
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
};

/** 组装请求 headers（独立出来便于测试请求构造）。 */
export function buildRequestHeaders(method: PixieRequestMethod, body: unknown): Record<string, string> {
	const headers: Record<string, string> = { host: `${PIXIE_LOOPBACK_HOST}` };
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
			headers: buildRequestHeaders(options.method, options.body),
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
