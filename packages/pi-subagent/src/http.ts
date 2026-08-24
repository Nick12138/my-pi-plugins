/** 本地 HTTP API（127.0.0.1），供 PiDeck 右侧面板查看/停止子代理。 */
import * as http from "node:http";
import { scheduler } from "./scheduler.ts";
import { loadRun, loadAllRuns, readEvents, readResult, RUNS_ROOT, runDir } from "./store.ts";
import type { RunRecord } from "./types.ts";
import { STATUS_LABEL } from "./types.ts";

function json(res: http.ServerResponse, code: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Cache-Control": "no-store",
	});
	res.end(body);
}

/** 列表项（前端需要的精简字段） */
function toSummary(run: RunRecord): Record<string, unknown> {
	const { task, status, result } = run;
	return {
		id: task.id,
		title: task.title,
		agent: task.agent,
		status: status.status,
		statusLabel: STATUS_LABEL[status.status],
		pid: status.pid ?? null,
		model: result?.model ?? task.model ?? null,
		createdAt: task.createdAt,
		startedAt: status.startedAt ?? null,
		finishedAt: status.finishedAt ?? null,
		exitCode: status.exitCode ?? null,
		stopReason: status.stopReason ?? null,
		errorMessage: status.errorMessage ?? null,
		resumeCount: status.resumeCount,
		retryLeft: status.retryLeft,
		worktree: task.worktree,
		worktreePath: task.worktreePath ?? null,
		outputPreview: result?.output ? result.output.slice(0, 500) : "",
		cost: result?.usage?.cost ?? 0,
		turns: result?.usage?.turns ?? 0,
	};
}

let server: http.Server | null = null;

/** 启动 HTTP 服务（进程级单例，幂等）。返回实际端口。 */
export function startHttpServer(port: number): number {
	if (server) return (server.address() as { port: number }).port;

	server = http.createServer((req, res) => {
		try {
			void handle(req, res);
		} catch (err) {
			json(res, 500, { error: err instanceof Error ? err.message : String(err) });
		}
	});
	server.on("error", (err) => {
		console.error(`[pi-subagent] HTTP server error: ${err.message}`);
	});
	server.listen(port, "127.0.0.1");
	return port;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	if (req.method === "OPTIONS") {
		res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
		res.end();
		return;
	}
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const parts = url.pathname.split("/").filter(Boolean);

	if (req.method === "GET" && parts[0] === "api" && parts[1] === "health") {
		json(res, 200, { ok: true, runsRoot: RUNS_ROOT, active: scheduler.activeCount() });
		return;
	}

	if (req.method === "GET" && parts[0] === "api" && parts[1] === "runs" && parts.length === 2) {
		json(res, 200, { runs: loadAllRuns().map(toSummary), runsRoot: RUNS_ROOT });
		return;
	}

	if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
		const runId = parts[2];
		const run = loadRun(runId);
		if (!run) {
			json(res, 404, { error: `run ${runId} 不存在` });
			return;
		}

		if (req.method === "GET" && parts.length === 3) {
			json(res, 200, { run: toSummary(run), task: run.task, status: run.status });
			return;
		}

		if (req.method === "GET" && parts[3] === "events") {
			const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
			const { lines, total } = readEvents(runId, offset);
			json(res, 200, { offset, total, lines });
			return;
		}

		if (req.method === "GET" && parts[3] === "result") {
			json(res, 200, { result: readResult(runId) ?? null });
			return;
		}

		if (req.method === "POST" && parts[3] === "stop") {
			const outcome = await scheduler.stop(runId);
			json(res, outcome.ok ? 200 : 400, outcome);
			return;
		}

		if (req.method === "POST" && parts[3] === "pause") {
			const outcome = await scheduler.pause(runId);
			json(res, outcome.ok ? 200 : 400, outcome);
			return;
		}

		if (req.method === "POST" && parts[3] === "continue") {
			const outcome = await scheduler.continueRun(runId);
			json(res, outcome.ok ? 200 : 400, outcome);
			return;
		}

		if (req.method === "POST" && parts[3] === "resume") {
			const outcome = await scheduler.resume(runId);
			json(res, outcome.ok ? 200 : 400, outcome);
			return;
		}
	}

	json(res, 404, { error: "not found" });
}
