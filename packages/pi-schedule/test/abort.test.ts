/**
 * 叫停一次执行的回归测试。
 *
 * 覆盖：运行中可中止（命令型走进程树 kill）、中止落 aborted 终态且不消耗投递配额、
 * 未知/已终态的 runId 返回 false、run 摘要透出实际生效的工具白名单。
 * 会话型的 abort 依赖真模型，离线测不到，这里测的是句柄注册表与终态判定这条公共路径。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-abort-"));
process.env.PI_SCHEDULE_DIR = ROOT;

const srcDir = join(import.meta.dirname, "..", "src");
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);
const { createJob } = await import(pathToFileURL(join(srcDir, "jobs.ts")).href);
const runner = await import(pathToFileURL(join(srcDir, "runner.ts")).href);
const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);

const CWD = join(import.meta.dirname, "..");

before(() => {
	store.resetPathsCache();
});

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** 等 runner 第一次落盘（status=running）后拿它的 runId。 */
function captureLiveRunId(): { runId: () => string | null; onStatus: (record: unknown) => void } {
	let runId: string | null = null;
	return {
		runId: () => runId,
		onStatus: (record: { runId?: string; status?: string } | unknown) => {
			const r = record as { runId?: string; status?: string };
			if (typeof r?.runId === "string") runId = r.runId;
		},
	};
}

test("命令型任务可中途叫停：终态 aborted，错误说明是用户中止", async () => {
	const job = createJob(
		{
			name: "长跑命令",
			command: `node -e "setTimeout(function(){},30000)"`,
			cwd: CWD,
			trigger: { type: "manual" },
		},
		{ by: "test" },
	);
	const live = captureLiveRunId();
	const pending = runner.runJob(job, { trigger: "manual", onStatusChange: live.onStatus });

	// 等它真的进入执行中（第一次落盘 + 句柄注册）
	for (let i = 0; i < 100 && live.runId() === null; i += 1) {
		await new Promise((r) => setTimeout(r, 10));
	}
	const runId = live.runId();
	assert.ok(runId, "应已拿到 running 的 runId");
	assert.equal(runner.isRunLive(runId), true, "句柄应已注册");

	assert.equal(runner.abortRun(runId as string), true, "运行中的 run 应被接受中止");
	const record = await pending;
	assert.equal(record.status, "aborted");
	assert.ok(record.error?.includes("中止"), `错误应说明是中止，实际：${record.error}`);
	assert.equal(runner.isRunLive(record.runId), false, "终态后句柄必须摘除");
});

test("abortRun：未知 runId 返回 false，不误伤", () => {
	assert.equal(runner.abortRun("deadbeef"), false);
});

test("aborted 不消耗投递配额，但 once 任务照常判失效", async () => {
	const job = createJob(
		{
			name: "一次性长跑",
			command: `node -e "setTimeout(function(){},30000)"`,
			cwd: CWD,
			trigger: { type: "once", at: new Date(Date.now() + 60_000).toISOString() },
		},
		{ by: "test" },
	);
	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	// trigger 不透传 onStatusChange（它自己就是终态的处理方），所以从落盘的 run 记录里拿 runId
	const pending = scheduler.trigger(job, { trigger: "manual" });
	let runId: string | null = null;
	for (let i = 0; i < 200 && runId === null; i += 1) {
		const [latest] = store.listRuns(job.id, 1);
		if (latest) runId = latest.runId;
		else await new Promise((r) => setTimeout(r, 10));
	}
	assert.ok(runId, "应已落一条 running 记录");
	assert.equal(runner.abortRun(runId as string), true, "应能叫停调度器发车的那一轮");
	const record = await pending;

	assert.equal(record.status, "aborted");
	const after = store.getJob(job.id);
	assert.equal(after?.runCount, 0, "中止不应计入 runCount");
	assert.equal(after?.lastStatus, "aborted");
	// 既定口径：once 任务不论终态都判失效，面板据此提示「改期重开」
	assert.equal(after?.terminated, "once");
	scheduler.stop();
});

test("run 摘要透出实际生效的工具白名单与会话路径", () => {
	const record = {
		runId: "abcd1234",
		jobId: "job1",
		jobName: "只读",
		trigger: "manual",
		scheduledFor: null,
		startedAt: "2026-10-16T00:00:00.000Z",
		finishedAt: "2026-10-16T00:01:00.000Z",
		status: "ok",
		cwd: CWD,
		model: null,
		permission: "read_only",
		tools: ["read", "grep", "find", "ls"],
		sessionId: "s1",
		sessionPath: join(ROOT, "sessions", "job1", "abcd1234.jsonl"),
		forkOf: null,
		replyText: null,
		usage: null,
		summary: "done",
		command: null,
		outputText: "done",
		toolCalls: 2,
		error: null,
		idempotencyKey: "job1:manual",
	};
	const summary = store.toRunSummary(record);
	assert.deepEqual(summary.tools, ["read", "grep", "find", "ls"], "面板要能回答「这轮给了哪些工具」");
	assert.equal(summary.sessionPath, record.sessionPath, "Host 要据此直接读会话文件");
	assert.equal(summary.command, null);
	assert.equal(summary.durationMs, 60_000);
});

/** 造一条 run 记录直接落盘（不经 runner，用来模拟宿主中途暴死留下的现场）。 */
function seedRunning(jobId: string, runId: string, startedAt: string) {
	store.writeRun({
		runId,
		jobId,
		jobName: `僵尸样本 ${runId}`,
		trigger: "manual",
		scheduledFor: null,
		startedAt,
		finishedAt: null,
		status: "running",
		cwd: CWD,
		model: null,
		permission: "read_only",
		tools: ["read"],
		sessionId: null,
		sessionPath: null,
		forkOf: null,
		replyText: null,
		usage: null,
		summary: "",
		command: null,
		outputText: "",
		toolCalls: 0,
		error: null,
		idempotencyKey: `${jobId}:${runId}`,
	} as never);
}

test("僵尸 running 记录按超时收口；还在宽限内的绝不碰", async () => {
	const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);
	const stale = createJob(
		{ name: "僵尸样本", command: "echo hi", cwd: CWD, trigger: { type: "manual" }, timeoutMs: 5_000 },
		{ by: "test" },
	);
	const live = createJob(
		{ name: "还在跑", command: "echo hi", cwd: CWD, trigger: { type: "manual" }, timeoutMs: 600_000 },
		{ by: "test" },
	);
	// 开始于 10 分钟前：远超「timeoutMs + 5 分钟宽限」。
	seedRunning(stale.id, "stale1", new Date(Date.now() - 10 * 60_000).toISOString());
	// 只跑了 10 秒：远在宽限内，必须原样留着。
	seedRunning(live.id, "live1", new Date(Date.now() - 10_000).toISOString());

	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");
	scheduler.stop();

	const settled = store.readRun(stale.id, "stale1");
	assert.equal(settled.status, "timeout");
	assert.ok(settled.finishedAt, "收口要补上结束时间");
	assert.ok(
		settled.error?.includes("未回写终态"),
		`错误要说清是没收口，实际：${settled.error}`,
	);
	assert.equal(store.readRun(live.id, "live1").status, "running", "宽限内的记录不是僵尸");
	// 任务的账不能在这里补：runCount 归 afterRun 管，重复计会把 maxRuns 提前吃掉。
	assert.equal(store.getJob(stale.id)?.runCount, 0);
});
