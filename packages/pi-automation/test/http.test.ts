/**
 * HTTP 控制面单测：鉴权、越权防护、404 语义、cron 时区、并发单飞。
 *
 * 说明：这里只做**不触发 LLM** 的请求；run_now 走「模型不存在」的快速错误路径，
 * 或者用 interval=manual 的任务避免真实执行。真实执行的冒烟见 smoke.e2e.mjs。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-automation-http-"));
process.env.PI_AUTOMATION_DIR = ROOT;
process.env.PI_AUTOMATION_TOKEN = "test-token-123";
process.env.PI_AUTOMATION_TZ = "Asia/Shanghai";

const srcDir = join(import.meta.dirname, "..", "src");
const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);
const { startHttpServer, stopHttpServer } = await import(pathToFileURL(join(srcDir, "http.ts")).href);
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);

const CWD = join(import.meta.dirname, "..");
const scheduler = new Scheduler({ tickMs: 3_600_000 });
let base = "";
const TOKEN = "test-token-123";

async function call(
	method: string,
	path: string,
	body: unknown = undefined,
	options: { token?: string | false } = {},
) {
	const headers: Record<string, string> = {};
	if (options.token !== false) headers["X-Pi-Automation-Token"] = options.token ?? TOKEN;
	if (body) headers["Content-Type"] = "application/json";
	const res = await fetch(`${base}${path}`, {
		method,
		headers,
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
}

before(async () => {
	const port = await startHttpServer(scheduler, 18991);
	base = `http://127.0.0.1:${port}/api`;
});

after(() => {
	stopHttpServer();
	rmSync(ROOT, { recursive: true, force: true });
});

test("鉴权：health 免 token；其他接口无 token 401", async () => {
	const health = await call("GET", "/health", undefined, { token: false });
	assert.equal(health.status, 200);
	// health 免 token，所以绝不能把 token 带出去；字段集合还是 Host 侧 hasExactKeys 的固定契约
	assert.ok(!JSON.stringify(health.data).includes(TOKEN));
	assert.deepEqual(Object.keys(health.data).sort(), [
		"activeJobs",
		"maxConcurrent",
		"ok",
		"port",
		"root",
		"tickMs",
	]);

	const noToken = await call("GET", "/jobs", undefined, { token: false });
	assert.equal(noToken.status, 401);

	const wrongToken = await call("GET", "/jobs", undefined, { token: "wrong" });
	assert.equal(wrongToken.status, 401);

	const ok = await call("GET", "/jobs");
	assert.equal(ok.status, 200);
});

test("鉴权：token 也可走查询串；错误 Host 403", async () => {
	const viaQuery = await fetch(`${base}/jobs?token=${TOKEN}`);
	assert.equal(viaQuery.status, 200);

	// 直接构造带伪造 Host 的请求
	const { request } = await import("node:http");
	const status = await new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port: new URL(base).port, path: "/api/jobs", method: "GET", headers: { Host: "evil.example.com" } },
			(res) => {
				res.resume();
				resolve(res.statusCode);
			},
		);
		req.on("error", reject);
		req.end();
	});
	assert.equal(status, 403);
});

test("响应不含 CORS 放行头（防跨源读取）", async () => {
	const res = await fetch(`${base}/jobs`, { headers: { "X-Pi-Automation-Token": TOKEN } });
	assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("越权防护：未知 permission 不再等价于 full", async () => {
	const created = await call("POST", "/jobs", {
		name: "越权测试",
		prompt: "x",
		cwd: CWD,
		trigger: { type: "manual" },
		permission: "read_only",
	});
	const id = created.data.job.id;

	// 旧实现下 permission:"pwnd" 会走 default 分支 → 不传白名单 → full
	const escalation = await call("POST", `/jobs/${id}/run_now`, { permission: "pwnd" });
	assert.equal(escalation.status, 400, "非法 permission 必须 400");
	assert.match(escalation.data.error, /permission 非法/);

	// 非法 timeoutMs 同样被拒
	const badTimeout = await call("POST", `/jobs/${id}/run_now`, { timeoutMs: "abc" });
	assert.equal(badTimeout.status, 400);

	// permission 覆盖也不接受 create/update 里的非法值
	const badCreate = await call("POST", "/jobs", {
		name: "越权2",
		prompt: "x",
		cwd: CWD,
		trigger: { type: "manual" },
		permission: "full2",
	});
	assert.equal(badCreate.status, 400);
});

test("cron 时区：任务自带 timezone 不被系统时区吞掉", async () => {
	const created = await call("POST", "/jobs", {
		name: "时区测试",
		prompt: "x",
		cwd: CWD,
		trigger: { type: "cron", cron: "0 9 * * *", timezone: "America/New_York" },
	});
	assert.equal(created.status, 201);
	const job = created.data.job;
	assert.equal(job.trigger.timezone, "America/New_York");
	// 纽约 09:00 = 13:00Z（夏令时）或 14:00Z（冬令时），绝不是上海时区对应的 01:00Z
	const hour = new Date(job.nextRunAt).getUTCHours();
	assert.ok(hour === 13 || hour === 14, `期望 13/14 时（UTC），实际 ${hour}`);

	// 未知时区被拒
	const badTz = await call("POST", "/jobs", {
		name: "坏时区",
		prompt: "x",
		cwd: CWD,
		trigger: { type: "cron", cron: "0 9 * * *", timezone: "Mars/Olympus" },
	});
	assert.equal(badTz.status, 400);
	assert.match(badTz.data.error, /未知时区|Unknown time zone/);
});

test("404 语义：不存在的任务各操作都返回 404", async () => {
	for (const [method, path] of [
		["GET", "/jobs/deadbeef"],
		["PATCH", "/jobs/deadbeef"],
		["DELETE", "/jobs/deadbeef"],
		["POST", "/jobs/deadbeef/enable"],
		["POST", "/jobs/deadbeef/disable"],
		["POST", "/jobs/deadbeef/run_now"],
		["GET", "/jobs/deadbeef/runs"],
	]) {
		const res = await call(method, path, method === "PATCH" ? { name: "x" } : undefined);
		assert.equal(res.status, 404, `${method} ${path} 应为 404，实际 ${res.status}`);
	}
	const ghostRun = await call("GET", "/runs/nonexistent");
	assert.equal(ghostRun.status, 404);
});

test("once 过期 + skip：终止而不是反复重写（P0-1 回归）", async () => {
	// 直接构造一个已过期的 once 任务（绕过 createJob 的时间校验）
	const job = {
		id: "aa11bb22",
		name: "过期once",
		prompt: "x",
		cwd: CWD,
		enabled: true,
		permission: "read_only",
		model: null,
		trigger: { type: "once", at: "2020-01-01T00:00:00.000Z" },
		missedWindow: "skip",
		timeoutMs: 60_000,
		maxRuns: null,
		loadExtensions: false,
		tags: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		updatedBy: "test",
		nextRunAt: "2020-01-01T00:00:00.000Z",
		lastRunAt: null,
		lastRunId: null,
		lastStatus: null,
		runCount: 0,
		terminated: null,
	};
	store.upsertJob(job);

	await scheduler.tick("tick");
	const after1 = store.getJob(job.id);
	assert.equal(after1.terminated, "missed");
	assert.equal(after1.enabled, false);
	assert.equal(after1.nextRunAt, null);

	// 再 tick 多次不应改变任何东西（无自持写入）
	const before = readFileSync(store.paths().jobsFile, "utf8");
	await scheduler.tick("tick");
	await scheduler.tick("tick");
	assert.equal(readFileSync(store.paths().jobsFile, "utf8"), before, "重复 tick 不应改写文件");

	store.removeJob(job.id);
});

test("interval 节拍：nextRunAt 从原计划推进而不是从完成时刻", async () => {
	const created = await call("POST", "/jobs", {
		name: "节拍",
		prompt: "x",
		cwd: CWD,
		trigger: { type: "interval", every: "30m" },
	});
	const job = created.data.job;
	const first = new Date(job.nextRunAt).getTime();

	// 模拟一次「跑得很久」的执行：scheduledFor 比 now 早 25 分钟
	const { advanceNextRunAt } = await import(pathToFileURL(join(srcDir, "automation.ts")).href);
	const now = new Date(first + 25 * 60_000);
	const next = advanceNextRunAt({ type: "interval", every: "30m" }, now, "Asia/Shanghai", new Date(first).toISOString());
	assert.equal(new Date(next).getTime(), first + 30 * 60_000, "应从原计划推进 30m，而不是 now+30m");
});

test("加固：写操作不接受 query token，且必须带 JSON Content-Type", async () => {
	// GET 允许 query token（只读）
	const getViaQuery = await fetch(`${base}/jobs?token=${TOKEN}`);
	assert.equal(getViaQuery.status, 200);

	// POST 用 query token → 401（写操作只认 header，防 CSRF 简单请求）
	const postViaQuery = await fetch(`${base}/jobs?token=${TOKEN}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "x", prompt: "y", cwd: CWD, trigger: { type: "manual" } }),
	});
	assert.equal(postViaQuery.status, 401);

	// POST 带 header 但 Content-Type 非 JSON → 400
	const wrongType = await fetch(`${base}/jobs`, {
		method: "POST",
		headers: { "X-Pi-Automation-Token": TOKEN, "Content-Type": "text/plain" },
		body: JSON.stringify({ name: "x", prompt: "y", cwd: CWD, trigger: { type: "manual" } }),
	});
	assert.equal(wrongType.status, 400);
});

test("加固：单飞冲突返回 409（不是 500）", async () => {
	const created = await call("POST", "/jobs", {
		name: "单飞冲突",
		prompt: "x",
		cwd: CWD,
		trigger: { type: "manual" },
		model: { provider: "no-such", id: "no-such" },
	});
	const id = created.data.job.id;
	// 占住锁，模拟同一任务正在执行
	const release = store.tryAcquireRunLock(id, 60_000);
	assert.ok(release);
	const conflict = await call("POST", `/jobs/${id}/run_now`);
	assert.equal(conflict.status, 409, `期望 409，实际 ${conflict.status}`);
	release?.();
	await call("DELETE", `/jobs/${id}`);
});

test("POST /runs/:runId/abort：运行中可叫停，已终态时 409", async () => {
	const created = await call("POST", "/jobs", {
		name: "长跑命令",
		command: `node -e "setTimeout(function(){},30000)"`,
		cwd: CWD,
		trigger: { type: "manual" },
	});
	const id = created.data.job.id;
	// run_now 是长请求：不等它返回，先去中止这一轮
	const pending = call("POST", `/jobs/${id}/run_now`);
	let runId = "";
	for (let i = 0; i < 200 && !runId; i += 1) {
		const runs = await call("GET", `/jobs/${id}/runs`);
		runId = runs.data?.runs?.[0]?.runId ?? "";
		if (!runId) await new Promise((r) => setTimeout(r, 10));
	}
	assert.ok(runId, "应已落一条 running 记录");

	const aborted = await call("POST", `/runs/${runId}/abort`);
	assert.equal(aborted.status, 200, `运行中应接受中止，实际 ${aborted.status}`);
	const done = await pending;
	assert.equal(done.data.run.status, "aborted", "长请求应带回 aborted 终态");
	assert.ok(Array.isArray(done.data.run.tools), "摘要要带实际生效的工具白名单");

	// 同一 run 再中止：已经不在执行中，必须 409 而不是假装成功
	const again = await call("POST", `/runs/${runId}/abort`);
	assert.equal(again.status, 409);

	// 未知 runId 走 404（run 记录都不存在）
	const ghost = await call("POST", "/runs/deadbeef/abort");
	assert.equal(ghost.status, 404);

	// 免 token 中止不被允许：控制面写操作一律要鉴权
	const noToken = await fetch(`${base}/runs/${runId}/abort`, { method: "POST" });
	assert.equal(noToken.status, 401);

	await call("DELETE", `/jobs/${id}`);
});
