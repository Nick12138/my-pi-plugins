/**
 * 调度器回归测试：重点覆盖 review 发现的 P0-1（skip + once 自触发写入死循环）、
 * P1-5（runCount 陈旧快照）、排期推进（不漂移）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-sched-"));
process.env.PI_SCHEDULE_DIR = ROOT;
process.env.PI_SCHEDULE_TZ = "Asia/Shanghai";

const srcDir = join(import.meta.dirname, "..", "src");
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);
const { createJob } = await import(pathToFileURL(join(srcDir, "jobs.ts")).href);
const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);
const { advanceNextRunAt } = await import(pathToFileURL(join(srcDir, "schedule.ts")).href);

const CWD = join(import.meta.dirname, "..");

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

test("P0-1：once + skip 过期后终止，不会每次 tick 重写 jobs.json", async () => {
	const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	const job = createJob(
		{
			name: "过期一次性",
			prompt: "x",
			cwd: CWD,
			trigger: { type: "once", at: future },
			missedWindow: "skip",
		},
		{ by: "test" },
	);
	// 把 nextRunAt 拨到 2 小时前（超出 once 的 1h 宽限）
	const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
	store.patchJob(job.id, { nextRunAt: past });

	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");
	await scheduler.tick("tick");
	await scheduler.tick("tick");

	const after1 = store.getJob(job.id);
	assert.equal(after1?.enabled, false, "过期的一次性任务应被停用");
	assert.equal(after1?.terminated, "missed", "终止原因应为 missed");
	assert.equal(after1?.nextRunAt, null, "nextRunAt 应清空，避免反复命中");

	// 台账只应有一条 terminate（不是每个 tick 一条 skip）
	const terminateRows = store
		.readLedger(50)
		.filter((e: { event: string; jobId: string }) => e.event === "terminate" && e.jobId === job.id);
	assert.equal(terminateRows.length, 1, `terminate 应只记 1 条，实际 ${terminateRows.length}`);

	// 再跑几次 tick，文件不应再被改写（mtime 不变 = 无自触发写入）
	const before = statSync(store.paths().jobsFile).mtimeMs;
	await new Promise((r) => setTimeout(r, 20));
	await scheduler.tick("tick");
	const after = statSync(store.paths().jobsFile).mtimeMs;
	assert.equal(after, before, "终止后不应再写 jobs.json");
});

test("skip 策略：过期 interval 只推进排期，不执行", async () => {
	const job = createJob(
		{ name: "过期周期", prompt: "x", cwd: CWD, trigger: { type: "interval", every: "30m" }, missedWindow: "skip" },
		{ by: "test" },
	);
	store.patchJob(job.id, { nextRunAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");
	const after1 = store.getJob(job.id);
	assert.equal(after1?.enabled, true, "周期任务不应被终止");
	assert.ok(after1?.nextRunAt && new Date(after1.nextRunAt).getTime() > Date.now(), "排期应被推进到未来");
	assert.equal(store.listRuns(job.id).length, 0, "skip 不应产生 run 记录");
});

test("advanceNextRunAt：interval 保留节拍（不因运行耗时漂移）", () => {
	const now = new Date("2026-01-01T00:35:00.000Z");
	const scheduled = "2026-01-01T00:00:00.000Z"; // 计划 00:00，周期 30m，现在 00:35
	const next = advanceNextRunAt({ type: "interval", every: "30m" }, now, "UTC", scheduled);
	// 应为 01:00（00:00 + 2*30m），而不是 01:05（now + 30m）
	assert.equal(next, "2026-01-01T01:00:00.000Z");
});

test("advanceNextRunAt：once 已过期返回 null（调用方据此终止）", () => {
	const now = new Date("2026-01-01T02:00:00.000Z");
	assert.equal(
		advanceNextRunAt({ type: "once", at: "2026-01-01T01:00:00.000Z" }, now, "UTC", null),
		null,
	);
});

test("单飞：run 进行中时同一 job 再次 trigger 被拒（或复用同一 promise）", async () => {
	const job = createJob(
		{
			name: "单飞",
			prompt: "x",
			cwd: CWD,
			trigger: { type: "manual" },
			model: { provider: "no-such", id: "no-such" }, // 快速失败，避免真实调用
		},
		{ by: "test" },
	);
	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	const first = scheduler.trigger(job, { trigger: "manual" });
	// 第二次立刻触发：应拿到同一个 promise（正在跑）或抛「正在执行中」
	let secondRejected = false;
	const second = scheduler.trigger(job, { trigger: "manual" }).catch(() => {
		secondRejected = true;
		return null;
	});
	const [r1, r2] = await Promise.all([first, second]);
	assert.equal(r1.status, "error", "错模型应快速失败");
	if (!secondRejected && r2) {
		assert.equal(r2.runId, r1.runId, "复用同一 run 而不是并发跑两次");
	}
});

test("advanceNextRunAt：超长过期也一次跳到未来（不会返回过去时间）", () => {
	const now = new Date("2026-01-03T00:00:00.000Z");
	// 1m 周期，锚点已过了 3 天（4320 个周期）——旧的循环上限（1000）会返回过去时间
	const next = advanceNextRunAt({ type: "interval", every: "1m" }, now, "UTC", "2025-12-31T00:00:00.000Z");
	assert.ok(new Date(next).getTime() > now.getTime(), `必须落在未来，实际 ${next}`);
	// 且保持节拍（锚点 + 整数倍周期）
	const delta = new Date(next).getTime() - new Date("2025-12-31T00:00:00.000Z").getTime();
	assert.equal(delta % 60_000, 0, "必须仍在原节拍上");
});

test("skip 策略：1m 周期超长过期只推进一次，不产生重写循环", async () => {
	const job = createJob(
		{ name: "超长过期", prompt: "x", cwd: CWD, trigger: { type: "interval", every: "1m" }, missedWindow: "skip" },
		{ by: "test" },
	);
	store.patchJob(job.id, { nextRunAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() });
	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");
	const after1 = store.getJob(job.id);
	assert.equal(after1?.enabled, true);
	assert.ok(new Date(after1.nextRunAt).getTime() > Date.now(), "排期必须落到未来");

	const before = readFileSync(store.paths().jobsFile, "utf8");
	await scheduler.tick("tick");
	await scheduler.tick("tick");
	assert.equal(readFileSync(store.paths().jobsFile, "utf8"), before, "不应反复重写");
});

test("P0-A：cron 推进必须严格落在未来（* * * * *）", () => {
	const now = new Date("2026-01-01T00:00:30.000Z");
	const next = advanceNextRunAt({ type: "cron", cron: "* * * * *" }, now, "UTC", "2026-01-01T00:00:00.000Z");
	assert.ok(new Date(next).getTime() > now.getTime(), `必须严格晚于 now，实际 ${next}`);

	// 多个时间点都不能落到过去（旧实现用 inclusive 会返回当前分钟起点）
	for (const offsetSec of [0, 30, 59, 90, 300, 3600]) {
		const at = new Date(now.getTime() + offsetSec * 1000);
		const candidate = advanceNextRunAt({ type: "cron", cron: "* * * * *" }, at, "UTC", null);
		assert.ok(
			new Date(candidate).getTime() > at.getTime(),
			`+${offsetSec}s 时应落在未来，实际 ${candidate}`,
		);
	}
});

test("P0-A：cron + skip 超期只推进一次，不产生自持写入", async () => {
	const job = createJob(
		{ name: "cron超期", prompt: "x", cwd: CWD, trigger: { type: "cron", cron: "* * * * *" }, missedWindow: "skip" },
		{ by: "test" },
	);
	store.patchJob(job.id, { nextRunAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");
	const after1 = store.getJob(job.id);
	assert.ok(new Date(after1.nextRunAt).getTime() > Date.now(), "cron 排期必须落到未来");

	const before = readFileSync(store.paths().jobsFile, "utf8");
	await scheduler.tick("tick");
	await scheduler.tick("tick");
	assert.equal(readFileSync(store.paths().jobsFile, "utf8"), before, "不应反复重写 jobs.json");
});

test("P1-B：锁被占用时 once 不会变成「enabled 但永不再跑」的僵尸", async () => {
	const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
	const job = createJob(
		{ name: "锁占用", prompt: "x", cwd: CWD, trigger: { type: "once", at: future }, missedWindow: "catch_up_one" },
		{ by: "test" },
	);
	// 把槽位拨到刚好过期（宽限期内，应当会尝试执行）
	store.patchJob(job.id, { nextRunAt: new Date(Date.now() - 60 * 1000).toISOString() });
	// 人为占住执行锁（模拟上一个进程崩溃遗留锁）
	const release = store.tryAcquireRunLock(job.id, 10 * 60 * 1000);
	assert.ok(release, "测试需要成功占住锁");

	const scheduler = new Scheduler({ tickMs: 3_600_000 });
	await scheduler.tick("tick");

	const after1 = store.getJob(job.id);
	assert.ok(
		!(after1.enabled && after1.nextRunAt === null),
		`不能出现 enabled+nextRunAt=null 的僵尸态：${JSON.stringify({ enabled: after1.enabled, nextRunAt: after1.nextRunAt, terminated: after1.terminated })}`,
	);
	assert.equal(after1.nextRunAt !== null || after1.terminated !== null, true, "要么保留槽位，要么明确终止");

	release?.();
	// 锁释放后应当能自愈（继续被调度或被终止），不会永久卡死
	await scheduler.tick("tick");
	const after2 = store.getJob(job.id);
	assert.ok(after2.terminated !== null || after2.nextRunAt !== null, "释放锁后不应仍处于无排期状态");
});

test("P2-D：updateJob 不会用陈旧快照覆盖并发 runCount", async () => {
	const { updateJob } = await import(pathToFileURL(join(srcDir, "jobs.ts")).href);
	const job = createJob({ name: "并发", prompt: "x", cwd: CWD, trigger: { type: "manual" } }, { by: "test" });
	// 模拟执行完成后 afterRun 把 runCount 提到 5
	store.patchJobsWith([job.id], () => ({ runCount: 5, lastStatus: "ok" }));
	// 同时另一个进程/请求改名字（旧实现会把 runCount 覆盖回 0）
	const updated = updateJob(job.id, { name: "改名" }, { by: "test" });
	assert.equal(updated.name, "改名");
	assert.equal(updated.runCount, 5, "runCount 不应被陈旧快照覆盖");
	assert.equal(updated.lastStatus, "ok");
});
