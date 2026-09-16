/**
 * HTTP 控制面冒烟：验证 PiAbyss 将要调用的接口全部可用。
 * 运行：node Agent临时工作/schedule-spike/http-smoke.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-http-"));
const PORT = 18999;
process.env.PI_SCHEDULE_DIR = ROOT;
process.env.PI_SCHEDULE_PORT = String(PORT);
process.env.PI_SCHEDULE_TZ = "Asia/Shanghai";
process.env.PI_SCHEDULE_TOKEN = "smoke-token";

const PKG_DIR = join(import.meta.dirname, "..");
const PKG = join(PKG_DIR, "src");
const { Scheduler } = await import(pathToFileURL(join(PKG, "scheduler.ts")).href);
const { startHttpServer } = await import(pathToFileURL(join(PKG, "http.ts")).href);

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const scheduler = new Scheduler({ tickMs: 3_600_000 });
const actualPort = await startHttpServer(scheduler, PORT);
const TOKEN = process.env.PI_SCHEDULE_TOKEN;
const base = `http://127.0.0.1:${actualPort}/api`;
const call = async (method, path, body) => {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { "X-Pi-Schedule-Token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { raw: text };
	}
	return { status: res.status, data };
};

try {
	// 1) health
	const health = await call("GET", "/health");
	check("GET /health", health.status === 200 && health.data.ok === true, JSON.stringify({ root: health.data.root, port: health.data.port }));

	// 2) cron 校验
	const goodCron = await call("GET", "/cron/validate?cron=0%209%20*%20*%201-5&timezone=Asia/Shanghai");
	check("cron 合法表达式", goodCron.data.valid === true);
	const badCron = await call("GET", "/cron/validate?cron=99%20*%20*%20*%20*");
	check("cron 非法表达式被拒", badCron.data.valid === false, badCron.data.reason?.slice(0, 40));

	// 3) 创建任务
	const created = await call("POST", "/jobs", {
		name: "HTTP冒烟",
		prompt: "Reply with exactly: HTTP_OK",
		cwd: PKG_DIR,
		trigger: { type: "cron", cron: "0 9 * * 1-5" },
		permission: "read_only",
		model: { provider: "5", id: "deepseek-v4.1-flash" },
		by: "smoke",
	});
	const jobId = created.data?.job?.id;
	check("POST /jobs 创建", created.status === 201 && Boolean(jobId), `id=${jobId} nextRunAt=${created.data?.job?.nextRunAt}`);
	check("创建时算出 nextRunAt", Boolean(created.data?.job?.nextRunAt));

	// 4) 列表
	const list = await call("GET", "/jobs");
	check("GET /jobs", list.status === 200 && list.data.jobs.length === 1);

	// 5) 非法创建被拒
	const badCreate = await call("POST", "/jobs", {
		name: "坏任务",
		prompt: "x",
		cwd: "D:/不存在的路径/xyz",
		trigger: { type: "interval", every: "10s" },
	});
	check("非法 cwd/interval 被拒（400）", badCreate.status === 400, badCreate.data?.error?.slice(0, 50));

	// 6) 修改（停用）
	const disabled = await call("POST", `/jobs/${jobId}/disable`);
	check("POST /jobs/:id/disable", disabled.status === 200 && disabled.data.job.enabled === false);

	// 7) run_now（真跑一次）
	const ran = await call("POST", `/jobs/${jobId}/run_now`);
	check("POST /jobs/:id/run_now", ran.status === 200, `status=${ran.data?.run?.status} runId=${ran.data?.run?.runId}`);
	const runId = ran.data?.run?.runId;

	// 8) run 详情 + 转录
	const detail = await call("GET", `/runs/${runId}`);
	check("GET /runs/:runId", detail.status === 200 && detail.data.run.runId === runId);
	const transcript = await call("GET", `/runs/${runId}/transcript`);
	check("GET /runs/:runId/transcript", transcript.status === 200 && Array.isArray(transcript.data.entries), `entries=${transcript.data?.entries?.length}`);

	// 9) 续聊（fork）
	const reply = await call("POST", `/runs/${runId}/reply`, { text: "Reply with exactly: HTTP_REPLY" });
	check("POST /runs/:runId/reply", reply.status === 200 && reply.data.run.forkOf === runId, `newRun=${reply.data?.run?.runId}`);

	// 10) 通知 / 台账
	const notifs = await call("GET", "/notifications?limit=10");
	check("GET /notifications", notifs.status === 200 && Array.isArray(notifs.data.entries), `rows=${notifs.data?.entries?.length}`);
	const ledger = await call("GET", "/ledger?limit=20");
	check("GET /ledger", ledger.status === 200 && ledger.data.entries.length > 0, `rows=${ledger.data?.entries?.length}`);

	// 11) 历史
	const runs = await call("GET", `/jobs/${jobId}/runs?limit=10`);
	check("GET /jobs/:id/runs", runs.status === 200 && runs.data.runs.length === 2, `rows=${runs.data?.runs?.length}`);

	// 12) 未知接口 404
	const notFound = await call("GET", "/nope");
	check("未知接口 404", notFound.status === 404);

	// 13) 删除
	const removed = await call("DELETE", `/jobs/${jobId}?purge=1`);
	check("DELETE /jobs/:id", removed.status === 200 && removed.data.removed === true);
	const afterDelete = await call("GET", "/jobs");
	check("删除后列表为空", afterDelete.data.jobs.length === 0);
} finally {
	const failed = results.filter((r) => !r.ok);
	console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
	if (failed.length > 0) {
		console.log("失败项：", failed.map((f) => f.name).join(", "));
		console.log(`（数据目录保留：${ROOT}）`);
		process.exitCode = 1;
	} else {
		rmSync(ROOT, { recursive: true, force: true });
		console.log("（已清理临时数据目录）");
	}
	process.exit(process.exitCode ?? 0);
}
