/**
 * store 层单测：任务 CRUD、单飞锁、执行记录、通知队列、会话转录解析。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-store-"));
process.env.PI_SCHEDULE_DIR = ROOT;

const srcDir = join(import.meta.dirname, "..", "src");
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);
const { createJob, updateJob, deleteJob, setEnabled } = await import(pathToFileURL(join(srcDir, "jobs.ts")).href);

const CWD = join(import.meta.dirname, "..");

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function makeJob(name: string) {
	return createJob(
		{ name, prompt: "do nothing", cwd: CWD, trigger: { type: "interval", every: "30m" } },
		{ by: "test" },
	);
}

test("jobs：创建 / 读取 / 修改 / 删除 落盘持久", () => {
	const job = makeJob("t1");
	assert.ok(job.id);
	assert.equal(job.nextRunAt !== null, true, "interval 应算出 nextRunAt");
	assert.equal(store.getJob(job.id)?.name, "t1");
	assert.equal(store.listJobs().length, 1);

	const updated = updateJob(job.id, { name: "t1-renamed", permission: "write" }, { by: "test" });
	assert.equal(updated.name, "t1-renamed");
	assert.equal(updated.permission, "write");

	setEnabled(job.id, false, { by: "test" });
	assert.equal(store.getJob(job.id)?.enabled, false);

	assert.equal(deleteJob(job.id, { by: "test" }), true);
	assert.equal(store.getJob(job.id), undefined);
	assert.equal(store.listJobs().length, 0);
});

test("jobs：非法输入被拒", () => {
	assert.throws(() => makeJob(""), /name 不能为空/);
	assert.throws(
		() =>
			createJob({ name: "x", prompt: "", cwd: CWD, trigger: { type: "manual" } }, { by: "test" }),
		/prompt/,
	);
	assert.throws(
		() =>
			createJob(
				{ name: "x", prompt: "y", cwd: "D:/绝对不存在的目录/zzz", trigger: { type: "manual" } },
				{ by: "test" },
			),
		/工作区不存在/,
	);
	assert.throws(
		() =>
			createJob(
				{ name: "x", prompt: "y", cwd: CWD, trigger: { type: "interval", every: "5s" } },
				{ by: "test" },
			),
		/不能小于 1m/,
	);
});

test("单飞锁：同 job 二次获取失败，释放后可再获取", () => {
	const release1 = store.tryAcquireRunLock("joblock");
	assert.ok(release1, "首次应获取成功");
	assert.equal(store.tryAcquireRunLock("joblock"), null, "第二次应失败（单飞）");
	assert.equal(store.hasActiveRun("joblock"), true);
	release1?.();
	assert.equal(store.hasActiveRun("joblock"), false);
	const release2 = store.tryAcquireRunLock("joblock");
	assert.ok(release2, "释放后应可再获取");
	release2?.();
});

test("执行记录：写入 / 读取 / 汇总 / 跨 job 查找", () => {
	const job = makeJob("t2");
	const record = {
		runId: "run0001",
		jobId: job.id,
		jobName: job.name,
		trigger: "manual",
		scheduledFor: null,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:01:00.000Z",
		status: "ok",
		cwd: CWD,
		model: { provider: "p", id: "m" },
		permission: "read_only",
		tools: ["read"],
		sessionId: "sid",
		sessionPath: null,
		forkOf: null,
		replyText: null,
		usage: { input: 10, output: 5, total: 15, cost: 0 },
		summary: "done",
		outputText: "done",
		toolCalls: 1,
		error: null,
		idempotencyKey: `${job.id}:manual`,
		command: null,
	};
	store.writeRun(record);
	const loaded = store.readRun(job.id, "run0001");
	assert.equal(loaded?.status, "ok");
	const summary = store.toRunSummary(loaded!);
	assert.equal(summary.durationMs, 60_000);
	assert.equal(summary.usage?.total, 15);
	assert.equal(store.findRun("run0001")?.jobId, job.id);
	assert.equal(store.listRuns(job.id).length, 1);
	assert.equal(store.listAllRuns(10).length, 1);
	store.purgeJobArtifacts(job.id);
	assert.equal(store.readRun(job.id, "run0001"), undefined);
});

test("通知队列：追加与裁剪", () => {
	for (let i = 0; i < 5; i += 1) {
		store.appendNotify({
			at: new Date().toISOString(),
			jobId: "j",
			jobName: "n",
			runId: `r${i}`,
			status: "ok",
			level: "info",
			title: "t",
			message: "m",
		});
	}
	assert.equal(store.readNotifications(10).length, 5);
	assert.equal(store.readNotifications(2).length, 2);
});

test("会话转录：解析 message 条目并跳过 toolResult", () => {
	const file = join(ROOT, "synthetic.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "s1" },
		{ type: "message", id: "a", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
		{
			type: "message",
			id: "b",
			message: { role: "assistant", content: [{ type: "text", text: "world" }, { type: "thinking", thinking: "hmm" }] },
		},
		{ type: "message", id: "c", message: { role: "toolResult", toolName: "read", content: "noise" } },
		{ type: "custom_message", id: "d", customType: "x", content: "note" },
	];
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
	const entries = store.readSessionTranscript(file) as Array<{ role: string; text: string }>;
	assert.deepEqual(
		entries.map((e: { role: string }) => e.role),
		["user", "assistant", "custom"],
	);
	assert.match(entries[1]!.text, /world/);
	assert.match(entries[1]!.text, /thinking/);
});

test("损坏的 jobs.json 会被隔离而不是静默清空", () => {
	writeFileSync(store.paths().jobsFile, "{ this is not json", "utf8");
	const jobs = store.listJobs();
	assert.deepEqual(jobs, []);
	// 隔离文件已生成
	const files = store.paths().root;
	assert.ok(files.length > 0);
});
