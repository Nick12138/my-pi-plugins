/**
 * pixie 环回 HTTP 契约测试：用 node:http 起本地 mock 环回服务，
 * 覆盖 dispatch 成功（queued 两种文案）/失败/3 秒超时/非 200、
 * report 成功/失败、dispatch-state 门控，以及请求构造。
 * 工具文本格式与原 pixie-tool.ts 逐字节对照。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	PIXIE_HTTP_TIMEOUT_MS,
	buildRequestHeaders,
	serializeRequestBody,
} from "../src/http-client.js";
import { buildPixieDispatchTool, buildPixieReportTool } from "../src/pixie-tools.js";
import { queryPixieDispatchArmed } from "../src/activation.js";
import {
	PIXIE_REPORT_SUCCESS_TEXT,
	formatDispatchFailureText,
	formatDispatchSuccessText,
	formatReportFailureText,
} from "../src/protocol.js";

// ── mock 环回服务 ────────────────────────────────────────────

type RecordedRequest = { method: string; path: string; body: string };
type MockHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startMockServer(handler: MockHandler): Promise<{
	port: number;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}> {
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: req.method ?? "", path: req.url ?? "", body });
			handler(req, res, body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const requests: RecordedRequest[] = [];
	return {
		port,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

function execute(
	tool: ReturnType<typeof buildPixieDispatchTool | typeof buildPixieReportTool>,
	params: unknown,
	ctx?: unknown,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true; details: unknown }> {
	return (tool.execute as (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown>)(
		"tool-call-1",
		params,
		undefined,
		undefined,
		ctx,
	) as Promise<{ content: Array<{ type: string; text: string }>; isError?: true; details: unknown }>;
}

// ── 文本格式逐字节对照（原 pixie-tool.ts）────────────────────

describe("tool text format (byte-exact vs PiAbyss pixie-tool.ts)", () => {
	it("dispatch success text (queued)", () => {
		expect(formatDispatchSuccessText({ sessionId: "sess-1", queued: true })).toBe(
			"已派发到工作区会话（sessionId: sess-1，该会话当前忙，任务已排队）。等待其回调 pixie_report 后再向用户转述。",
		);
	});

	it("dispatch success text (not queued)", () => {
		expect(formatDispatchSuccessText({ sessionId: "sess-1", queued: false })).toBe(
			"已派发到工作区会话（sessionId: sess-1）。等待其回调 pixie_report 后再向用户转述。",
		);
	});

	it("dispatch failure text", () => {
		expect(formatDispatchFailureText("目标工作区未打开（D:/ws）。")).toBe(
			"委派失败：目标工作区未打开（D:/ws）。",
		);
	});

	it("report success text", () => {
		expect(PIXIE_REPORT_SUCCESS_TEXT).toBe(
			"已回调小精灵。用户会在小精灵对话里看到你的结果转述；本会话可以继续接受新任务。",
		);
	});

	it("report failure text", () => {
		expect(formatReportFailureText("委派记录不存在或已结束")).toBe("Error: 委派记录不存在或已结束");
	});
});

// ── 请求构造 ─────────────────────────────────────────────────

describe("request construction", () => {
	it("serializes POST body and headers", () => {
		const body = { cwd: "D:/ws", task: "t" };
		expect(serializeRequestBody(body)).toBe(JSON.stringify(body));
		const headers = buildRequestHeaders("POST", body);
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["content-length"]).toBe(String(Buffer.byteLength(JSON.stringify(body), "utf8")));
		expect(headers.host).toBe("127.0.0.1");
	});

	it("omits body headers for GET", () => {
		const headers = buildRequestHeaders("GET", undefined);
		expect(headers["content-type"]).toBeUndefined();
		expect(headers["content-length"]).toBeUndefined();
	});
});

// ── dispatch 契约 ────────────────────────────────────────────

describe("pixie_dispatch contract", () => {
	let server: Awaited<ReturnType<typeof startMockServer>>;

	beforeAll(async () => {
		server = await startMockServer((_req, res, body) => {
			const parsed = JSON.parse(body) as { cwd: string; task: string; newSession?: boolean };
			if (parsed.task === "boom") {
				json(res, 200, { ok: false, error: "目标工作区未打开（D:/ws）。" });
				return;
			}
			if (parsed.task === "http500") {
				json(res, 500, { error: "internal" });
				return;
			}
			json(res, 200, {
				ok: true,
				dispatchId: "pix_1",
				sessionId: "sess-1",
				sessionPath: "D:/s1.jsonl",
				queued: parsed.task === "busy",
			});
		});
	});

	afterAll(async () => {
		await server.close();
	});

	const dispatchTool = () => buildPixieDispatchTool({ getPort: () => server.port });

	it("queued=false 成功文案（逐字节）", async () => {
		const out = await execute(dispatchTool(), { cwd: "D:/ws", task: "idle" });
		expect(out.isError).toBeUndefined();
		expect(out.content[0]?.text).toBe(
			"已派发到工作区会话（sessionId: sess-1）。等待其回调 pixie_report 后再向用户转述。",
		);
	});

	it("queued=true 成功文案（逐字节）", async () => {
		const out = await execute(dispatchTool(), { cwd: "D:/ws", task: "busy" });
		expect(out.isError).toBeUndefined();
		expect(out.content[0]?.text).toBe(
			"已派发到工作区会话（sessionId: sess-1，该会话当前忙，任务已排队）。等待其回调 pixie_report 后再向用户转述。",
		);
	});

	it("newSession 仅在显式传入时进入请求体", async () => {
		await execute(dispatchTool(), { cwd: "D:/ws", task: "idle", newSession: true });
		const last = server.requests.at(-1)!;
		expect(JSON.parse(last.body)).toEqual({ cwd: "D:/ws", task: "idle", newSession: true });
		await execute(dispatchTool(), { cwd: "D:/ws", task: "idle" });
		const lastOmitted = server.requests.at(-1)!;
		expect(JSON.parse(lastOmitted.body)).toEqual({ cwd: "D:/ws", task: "idle" });
		expect(lastOmitted.path).toBe("/api/pixie/dispatch");
		expect(lastOmitted.method).toBe("POST");
	});

	it("{ok:false} 失败 → isError + 委派失败文案", async () => {
		const out = await execute(dispatchTool(), { cwd: "D:/ws", task: "boom" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe("委派失败：目标工作区未打开（D:/ws）。");
	});

	it("非 200 → isError + 明确错误文本", async () => {
		const out = await execute(dispatchTool(), { cwd: "D:/ws", task: "http500" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe("委派失败：环回控制面返回非 200（500）：{\"error\":\"internal\"}");
	});

	it("端口缺失 → isError（不发起请求）", async () => {
		const tool = buildPixieDispatchTool({ getPort: () => null });
		const out = await execute(tool, { cwd: "D:/ws", task: "idle" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toContain("PIABYSS_PIXIE_HTTP_PORT");
	});

	it("mock 服务挂起 → 3 秒超时，isError 文案可读", async () => {
		const hung = await startMockServer(() => {
			/* 挂起：永不响应 */
		});
		try {
			const tool = buildPixieDispatchTool({ getPort: () => hung.port });
			const started = Date.now();
			const out = await execute(tool, { cwd: "D:/ws", task: "idle" });
			const elapsed = Date.now() - started;
			expect(out.isError).toBe(true);
			expect(out.content[0]?.text).toBe(
				`委派失败：环回请求超时（${PIXIE_HTTP_TIMEOUT_MS}ms）：POST /api/pixie/dispatch`,
			);
			expect(elapsed).toBeGreaterThanOrEqual(PIXIE_HTTP_TIMEOUT_MS - 100);
			expect(elapsed).toBeLessThan(PIXIE_HTTP_TIMEOUT_MS + 1500);
		} finally {
			await hung.close();
		}
	});

	it("连接拒绝 → isError（可读错误文本）", async () => {
		const tool = buildPixieDispatchTool({ getPort: () => 1 }); // 端口 1 无服务
		const out = await execute(tool, { cwd: "D:/ws", task: "idle" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toContain("委派失败：环回请求失败");
		expect(out.content[0]?.text).toContain("POST /api/pixie/dispatch");
	});
});

// ── report 契约 ──────────────────────────────────────────────

describe("pixie_report contract", () => {
	let server: Awaited<ReturnType<typeof startMockServer>>;

	beforeAll(async () => {
		server = await startMockServer((req, res, body) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method === "GET" && url.pathname === "/api/pixie/dispatch-state") {
				const sessionId = url.searchParams.get("sessionId") ?? "";
				if (sessionId === "sess-1") {
					json(res, 200, { armed: true, dispatchId: "pix_resolved" });
					return;
				}
				if (sessionId === "bad-json") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end("{not json");
					return;
				}
				json(res, 200, { armed: false });
				return;
			}
			const parsed = JSON.parse(body) as { dispatchId: string; summary: string };
			if (parsed.dispatchId === "pix_gone") {
				json(res, 200, { ok: false, error: "委派记录不存在或已结束" });
				return;
			}
			json(res, 200, { ok: true });
		});
	});

	afterAll(async () => {
		await server.close();
	});

	const reportTool = () =>
		buildPixieReportTool({ getPort: () => server.port, getSessionId: () => "sess-1" });

	it("成功 → 照搬原实现的回调成功文案（dispatchId 由 dispatch-state 解析）", async () => {
		const out = await execute(reportTool(), { result: "已完成：全部通过" });
		expect(out.isError).toBeUndefined();
		expect(out.content[0]?.text).toBe(
			"已回调小精灵。用户会在小精灵对话里看到你的结果转述；本会话可以继续接受新任务。",
		);
	});

	it("请求体为 { dispatchId, summary, success }，summary 去除首尾空白，success 默认 true", async () => {
		await execute(reportTool(), { result: "  摘要  " });
		const last = server.requests.at(-1)!;
		expect(last.method).toBe("POST");
		expect(last.path).toBe("/api/pixie/report");
		expect(JSON.parse(last.body)).toEqual({ dispatchId: "pix_resolved", summary: "摘要", success: true });
	});

	it("success=false 透传到请求体", async () => {
		await execute(reportTool(), { result: "失败摘要", success: false });
		const last = server.requests.at(-1)!;
		expect(JSON.parse(last.body)).toEqual({ dispatchId: "pix_resolved", summary: "失败摘要", success: false });
	});

	it("失败 → isError + Error: 前缀文案", async () => {
		// Host 侧在 report 阶段判定记录已结束（对应原实现的报告回调错误路径）。
		const armed = await startMockServer((req, res, body) => {
			if (req.method === "GET") {
				json(res, 200, { armed: true, dispatchId: "pix_gone" });
				return;
			}
			const parsed = JSON.parse(body) as { dispatchId: string };
			if (parsed.dispatchId === "pix_gone") {
				json(res, 200, { ok: false, error: "委派记录不存在或已结束" });
				return;
			}
			json(res, 200, { ok: true });
		});
		try {
			const tool = buildPixieReportTool({
				getPort: () => armed.port,
				getSessionId: () => "sess-1",
			});
			const out = await execute(tool, { result: "x" });
			expect(out.isError).toBe(true);
			expect(out.content[0]?.text).toBe("Error: 委派记录不存在或已结束");
		} finally {
			await armed.close();
		}
	});

	it("未 armed / 无进行中委派 → Error: 当前会话没有进行中的小精灵委派。", async () => {
		const tool = buildPixieReportTool({
			getPort: () => server.port,
			getSessionId: () => "idle-session",
		});
		const out = await execute(tool, { result: "x" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe("Error: 当前会话没有进行中的小精灵委派。");
	});

	it("会话 id 缺失 → Error: 当前会话没有进行中的小精灵委派。", async () => {
		const tool = buildPixieReportTool({
			getPort: () => server.port,
			getSessionId: () => null,
		});
		const out = await execute(tool, { result: "x" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe("Error: 当前会话没有进行中的小精灵委派。");
	});

	it("非 200（dispatch-state 阶段）→ 视为无委派", async () => {
		const hung = await startMockServer((_req, res) => {
			res.writeHead(503, { "content-type": "text/plain" });
			res.end("unavailable");
		});
		try {
			const tool = buildPixieReportTool({
				getPort: () => hung.port,
				getSessionId: () => "sess-1",
			});
			const out = await execute(tool, { result: "x" });
			expect(out.isError).toBe(true);
			expect(out.content[0]?.text).toBe("Error: 当前会话没有进行中的小精灵委派。");
		} finally {
			await hung.close();
		}
	});

	it("端口缺失 → isError（不发起请求）", async () => {
		const tool = buildPixieReportTool({ getPort: () => null });
		const out = await execute(tool, { result: "x" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe(
			"Error: 未找到 PiAbyss 环回控制面端口（PIABYSS_PIXIE_HTTP_PORT 未设置或非法）。",
		);
	});

	it("result 为空 → 先解析委派，再本地短路报错（照搬原实现顺序）", async () => {
		const before = server.requests.length;
		const out = await execute(reportTool(), { result: "   " });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toBe("Error: result 摘要不能为空。");
		// 期间只发生了 dispatch-state GET，没有 POST report。
		const newRequests = server.requests.slice(before);
		expect(newRequests.some((r) => r.method === "POST" && r.path === "/api/pixie/report")).toBe(false);
	});
});

// ── dispatch-state 门控查询 ──────────────────────────────────

describe("dispatch-state gating query", () => {
	let server: Awaited<ReturnType<typeof startMockServer>>;

	beforeAll(async () => {
		server = await startMockServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const sessionId = url.searchParams.get("sessionId") ?? "";
			if (sessionId === "armed-session") {
				json(res, 200, { armed: true });
				return;
			}
			if (sessionId === "bad-json") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{not json");
				return;
			}
			json(res, 200, { armed: false });
		});
	});

	afterAll(async () => {
		await server.close();
	});

	it("armed=true 正确透传，查询带 sessionId 参数", async () => {
		const armed = await queryPixieDispatchArmed({ port: server.port, sessionId: "armed-session" });
		expect(armed).toBe(true);
		const last = server.requests.at(-1)!;
		expect(last.method).toBe("GET");
		expect(last.path).toBe("/api/pixie/dispatch-state?sessionId=armed-session");
	});

	it("armed=false 正确透传", async () => {
		expect(await queryPixieDispatchArmed({ port: server.port, sessionId: "idle-session" })).toBe(false);
	});

	it("sessionId 缺失 → 未 armed", async () => {
		expect(await queryPixieDispatchArmed({ port: server.port, sessionId: null })).toBe(false);
		expect(await queryPixieDispatchArmed({ port: server.port, sessionId: "" })).toBe(false);
	});

	it("端口缺失 → 未 armed（不发起请求）", async () => {
		expect(await queryPixieDispatchArmed({ port: null, sessionId: "armed-session" })).toBe(false);
	});

	it("非法 JSON / 非 200 / 请求异常 → 未 armed，绝不抛出", async () => {
		expect(await queryPixieDispatchArmed({ port: server.port, sessionId: "bad-json" })).toBe(false);
		expect(await queryPixieDispatchArmed({ port: 1, sessionId: "armed-session" })).toBe(false);
	});
});
