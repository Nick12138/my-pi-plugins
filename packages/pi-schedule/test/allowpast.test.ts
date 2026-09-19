/**
 * 「复制计划」回归测试：停用任务允许过去时刻的 once（副本 enabled:false 创建），
 * 启用任务仍强制未来时刻，且报错时间按本地时区显示（不是 UTC 的 Z 后缀）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-allowpast-"));
process.env.PI_SCHEDULE_DIR = ROOT;
process.env.PI_SCHEDULE_TZ = "Asia/Shanghai";

const srcDir = join(import.meta.dirname, "..", "src");
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);
const { createJob, updateJob } = await import(pathToFileURL(join(srcDir, "jobs.ts")).href);
const { normalizeTrigger, systemTimezone } = await import(pathToFileURL(join(srcDir, "schedule.ts")).href);

const CWD = join(import.meta.dirname, "..");

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function pastIso(minutesAgo: number): string {
	return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

async function until(fn: () => boolean, ms = 5000, what = "条件"): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > ms) throw new Error(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("停用任务：createJob 允许过去时刻的 once（复制副本场景）", () => {
	const at = pastIso(10);
	const job = createJob(
		{ name: "副本", prompt: "x", cwd: CWD, trigger: { type: "once", at }, enabled: false },
		{ by: "test" },
	);
	assert.equal(job.enabled, false);
	assert.equal(job.trigger.at, at, "过去时刻应原样保留");
	assert.equal(store.getJob(job.id)?.trigger.at, at);
});

test("启用任务：createJob 过去时刻 once 仍报错，且报错为本地时间格式", () => {
	try {
		createJob(
			{ name: "过期", prompt: "x", cwd: CWD, trigger: { type: "once", at: pastIso(10) } },
			{ by: "test" },
		);
		assert.fail("启用任务不应接受过去的 once 时刻");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert.match(message, /once\.at 必须晚于当前时间/);
		// 本地格式（zh-CN）：2026/02/13 13:35 —— 不是 toISOString 的 ...Z
		assert.match(message, /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/, `报错应含本地时间格式：${message}`);
		assert.ok(!message.includes("Z"), `报错不应再显示 UTC Z 后缀：${message}`);
	}
});

test("normalizeTrigger：allowPast 直通；报错按系统时区（PI_SCHEDULE_TZ）显示本地时间", () => {
	const at = pastIso(60);
	// allowPast: true → 不抛
	const ok = normalizeTrigger({ type: "once", at }, new Date(), undefined, { allowPast: true });
	assert.equal(ok.at, at);
	// allowPast 缺省 → 抛，且时间与 UTC 显示不同（Asia/Shanghai +8h）
	try {
		normalizeTrigger({ type: "once", at }, new Date());
		assert.fail("缺省 allowPast 应拒绝过去时刻");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const utcText = new Date(at).toISOString();
		assert.ok(!message.includes(utcText), `报错不应包含 UTC 串：${message}`);
		const local = new Intl.DateTimeFormat("zh-CN", {
			timeZone: systemTimezone(),
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(new Date(at));
		assert.ok(message.includes(local), `报错应包含本地时间 ${local}：${message}`);
	}
});

test("updateJob：停用结果可写入过去 once；同一 patch 启用则拒绝", () => {
	const base = createJob({ name: "基础", prompt: "x", cwd: CWD, trigger: { type: "manual" } }, { by: "test" });
	const at = pastIso(10);

	// enabled:false + 过去 once → 成功
	const disabled = updateJob(base.id, { enabled: false, trigger: { type: "once", at } }, { by: "test" });
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.trigger.at, at);

	// enabled:true + 过去 once → 报错（启用任务仍要求未来时刻）
	assert.throws(
		() => updateJob(base.id, { enabled: true, trigger: { type: "once", at } }, { by: "test" }),
		/必须晚于当前时间/,
	);
});

test("启用含过去 once 的任务：skip 策略下终止为 missed（现有 advanceStaleJobs 逻辑）", async () => {
	const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);
	// 2 小时前，超出 once 的 1h 宽限
	const job = createJob(
		{
			name: "过去一次性-skip",
			command: "echo should-not-run",
			cwd: CWD,
			trigger: { type: "once", at: pastIso(120) },
			enabled: false,
			missedWindow: "skip",
		},
		{ by: "test" },
	);
	const enabled = updateJob(job.id, { enabled: true }, { by: "test" });
	assert.equal(enabled.nextRunAt, job.trigger.at, "启用后 nextRunAt 即那个过去时刻");

	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");
	await until(() => store.getJob(job.id)?.terminated === "missed", 5000, "skip 终止");
	const after = store.getJob(job.id);
	assert.equal(after?.enabled, false);
	assert.equal(after?.nextRunAt, null);
	assert.equal(after?.runCount, 0, "skip 策略不应补跑");
});

test("启用含过去 once 的任务：catch_up_one 策略下补跑一次后终止", async () => {
	const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);
	const job = createJob(
		{
			name: "过去一次性-补跑",
			command: "echo catch-up",
			cwd: CWD,
			trigger: { type: "once", at: pastIso(2) },
			enabled: false,
			missedWindow: "catch_up_one",
		},
		{ by: "test" },
	);
	updateJob(job.id, { enabled: true }, { by: "test" });

	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");
	await until(() => (store.getJob(job.id)?.runCount ?? 0) >= 1, 5000, "catch_up_one 补跑");
	await until(() => store.getJob(job.id)?.nextRunAt === null, 5000, "once 执行后清空 nextRunAt");
	const after = store.getJob(job.id);
	assert.equal(after?.runCount, 1, "应恰好补跑一次");
	assert.ok(after?.terminated, "once 执行完应进入终态");
});
