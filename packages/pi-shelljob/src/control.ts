/** Authenticated loopback control plane for the PiAbyss UI. */
import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface StopResult {
	ok: boolean;
	status: "killed" | "already_ended" | "not_found" | "forbidden" | "failed";
	jobId: string;
	state?: string;
	error?: string;
}
export type StopHandler = (jobId: string, sessionId: string) => Promise<StopResult>;

export function createStopHandler(deps: {
	load: (jobId: string) => { job: { id: string; sessionId?: string }; status: { status: string } } | null;
	isTerminal: (status: { status: string }) => boolean;
	kill: (jobId: string) => Promise<{ ok: boolean; error?: string }>;
}): StopHandler {
	return async (jobId, sessionId) => {
		const record = deps.load(jobId);
		if (!record) return { ok: false, status: "not_found", jobId };
		if (!record.job.sessionId || record.job.sessionId !== sessionId) return { ok: false, status: "forbidden", jobId, error: "job does not belong to caller session" };
		if (deps.isTerminal(record.status)) return { ok: true, status: "already_ended", jobId, state: record.status.status };
		const result = await deps.kill(jobId);
		if (result.ok) return { ok: true, status: "killed", jobId };
		const current = deps.load(jobId);
		if (current && deps.isTerminal(current.status)) return { ok: true, status: "already_ended", jobId, state: current.status.status };
		return { ok: false, status: "failed", jobId, error: result.error ?? "termination failed" };
	};
}

const ROOT = path.join(os.homedir(), ".pi", "shelljob");
const TOKEN_ENV = "SHELLJOB_CONTROL_TOKEN";
const PORT_ENV = "SHELLJOB_CONTROL_PORT";
let server: http.Server | null = null;
let activeHandler: StopHandler | null = null;
let authToken: string | null = null;

export function resolveControlToken(): string {
	const fromEnv = process.env[TOKEN_ENV]?.trim();
	if (fromEnv) return fromEnv;
	const file = path.join(ROOT, "token");
	try {
		const existing = readFileSync(file, "utf8").trim();
		if (existing) return existing;
	} catch { /* create token */ }
	const value = randomBytes(32).toString("hex");
	try {
		mkdirSync(ROOT, { recursive: true, mode: 0o700 });
		try { writeFileSync(file, value, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
		catch {
			const winner = readFileSync(file, "utf8").trim();
			if (winner) return winner;
		}
	} catch { /* memory-only token */ }
	return value;
}
function token(): string { return authToken ??= resolveControlToken(); }
function equal(a: string, b: string): boolean {
	const x = Buffer.from(a); const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}
function reply(res: http.ServerResponse, code: number, data: unknown): void {
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
	res.end(JSON.stringify(data));
}
function validHost(host: string | undefined): boolean {
	const value = (host ?? "").replace(/^\\[|\\]$/g, "").split(":")[0]?.toLowerCase();
	return value === "127.0.0.1" || value === "localhost" || value === "::1";
}
export function resolveControlPort(): number {
	const n = Number.parseInt(process.env[PORT_ENV] ?? "", 10);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : 18767;
}

export function startControlServer(handler: StopHandler, port = resolveControlPort()): Promise<number> {
	activeHandler = handler;
	if (server) {
		const addr = server.address();
		return Promise.resolve(addr && typeof addr === "object" ? addr.port : port);
	}
	return new Promise((resolve, reject) => {
		const instance = http.createServer(async (req, res) => {
			if (!validHost(req.headers.host)) return reply(res, 403, { ok: false, status: "forbidden", error: "loopback Host required" });
			if (req.method !== "POST" || req.url !== "/api/jobs/stop") return reply(res, 404, { ok: false, error: "not found" });
			const auth = req.headers["x-pi-shelljob-token"];
			if (typeof auth !== "string" || !equal(auth, token())) return reply(res, 401, { ok: false, error: "unauthorized" });
			if (!String(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) return reply(res, 400, { ok: false, error: "Content-Type must be application/json" });
			let raw = "";
			try {
				for await (const chunk of req) {
					raw += chunk.toString();
					if (raw.length > 8192) return reply(res, 413, { ok: false, error: "request too large" });
				}
				const body = JSON.parse(raw) as Record<string, unknown>;
				const sessionId = req.headers["x-pi-session-id"];
				if (Object.keys(body).some((k) => k !== "jobId") || typeof body.jobId !== "string" || !/^job_[a-z0-9]+$/i.test(body.jobId) || typeof sessionId !== "string" || !sessionId) {
					return reply(res, 400, { ok: false, error: "body must contain only jobId; X-Pi-Session-Id is required" });
				}
				if (!activeHandler) return reply(res, 503, { ok: false, error: "extension not ready" });
				const result = await activeHandler(body.jobId, sessionId);
				const code = result.status === "not_found" ? 404 : result.status === "forbidden" ? 403 : result.status === "failed" ? 500 : 200;
				return reply(res, code, result);
			} catch (error) {
				return reply(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		});
		instance.once("error", reject);
		instance.listen(port, "127.0.0.1", () => {
			server = instance;
			const addr = instance.address();
			resolve(addr && typeof addr === "object" ? addr.port : port);
		});
	});
}

export function stopControlServer(): void {
	activeHandler = null;
	const closing = server;
	server = null;
	closing?.close();
}
