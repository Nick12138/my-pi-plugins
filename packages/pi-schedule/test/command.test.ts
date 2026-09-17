/**
 * 命令型任务回归测试：不经模型、直接执行 shell 命令。
 * 覆盖：成功/非零退出/超时三种终态、prompt 互斥、输出捕获。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-cmd-"));
process.env.PI_SCHEDULE_DIR = ROOT;
process.env.PI_SCHEDULE_TZ = "Asia/Shanghai";

const srcDir = join(import.meta.dirname, "..", "src");
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);
const { createJob } = await import(pathToFileURL(join(srcDir, "jobs.ts")).href);
const { runJob } = await import(pathToFileURL(join(srcDir, "runner.ts")).href);

const CWD = join(import.meta.dirname, "..");

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

test("createJob：command 与 prompt 互斥；命令型任务 prompt 为空", () => {
	assert.throws(
		() =>
			createJob(
				{ name: "冲突", prompt: "x", command: "echo hi", cwd: CWD, trigger: { type: "manual" } },
				{ by: "test" },
			),
		/互斥/,
	);
	const job = createJob(
		{ name: "纯命令", command: "echo hi", cwd: CWD, trigger: { type: "manual" } },
		{ by: "test" },
	);
	assert.equal(job.command, "echo hi");
	assert.equal(job.prompt, "");
});

test("命令执行成功：status=ok，stdout 进 summary，无会话无模型", async () => {
	const job = createJob(
		{ name: "成功", command: `node -e "process.stdout.write('hello-cmd')"`, cwd: CWD, trigger: { type: "manual" } },
		{ by: "test" },
	);
	const record = await runJob(job, { trigger: "manual" });
	assert.equal(record.status, "ok");
	assert.equal(record.error, null);
	assert.ok(record.outputText.includes("hello-cmd"), `输出应包含 hello-cmd，实际：${record.outputText}`);
	assert.equal(record.summary, "hello-cmd");
	assert.equal(record.sessionPath, null, "命令型任务不应有执行会话");
	assert.equal(record.sessionId, null);
	assert.equal(record.model, null, "命令型任务不经模型");
	assert.equal(record.toolCalls, 0);
	assert.equal(record.command, job.command);
	// 落盘可读
	const loaded = store.readRun(job.id, record.runId);
	assert.equal(loaded?.status, "ok");
});

test("命令非零退出：status=error，错误带退出码与 stderr", async () => {
	const job = createJob(
		{
			name: "失败",
			command: `node -e "process.stderr.write('boom'); process.exit(3)"`,
			cwd: CWD,
			trigger: { type: "manual" },
		},
		{ by: "test" },
	);
	const record = await runJob(job, { trigger: "manual" });
	assert.equal(record.status, "error");
	assert.ok(record.error.includes("3"), `错误应带退出码 3，实际：${record.error}`);
	assert.ok(record.outputText.includes("boom"), `输出应包含 stderr，实际：${record.outputText}`);
});

test("命令超时：status=timeout", async () => {
	const job = createJob(
		{
			name: "卡死",
			command: `node -e "setTimeout(function(){},10000)"`,
			cwd: CWD,
			trigger: { type: "manual" },
		},
		{ by: "test" },
	);
	// override 绕过 job 层的 5s 下限，直接测 runner 的超时路径
	const record = await runJob(job, { trigger: "manual", timeoutMsOverride: 500 });
	assert.equal(record.status, "timeout");
	assert.ok(record.error?.includes("超时"), `错误应说明超时，实际：${record.error}`);
});

test("scheduler.trigger 全链路：命令型任务跑完自动推进排期（once 终止）", async () => {
	const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);
	const job = createJob(
		{ name: "一次性命令", command: "echo once-cmd", cwd: CWD, trigger: { type: "manual" } },
		{ by: "test" },
	);
	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	const record = await scheduler.trigger(job, { trigger: "manual" });
	assert.equal(record.status, "ok");
	const after = store.getJob(job.id);
	assert.equal(after?.lastStatus, "ok");
	assert.equal(after?.runCount, 1, "命令型任务也应计入 runCount/maxRuns");
});
