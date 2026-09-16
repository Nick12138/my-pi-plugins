/**
 * cron / 调度语义单测。运行：node --test packages/pi-schedule/test/
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CronParseError, nextCronAfter, parseCron, wallClockAt } from "../src/cron.ts";
import {
	computeNextRunAt,
	parseInterval,
	ScheduleError,
	shouldFire,
	systemTimezone,
} from "../src/schedule.ts";

test("parseCron：基础字段与宏", () => {
	const expr = parseCron("0 9 * * 1-5");
	assert.deepEqual([...expr.minute], [0]);
	assert.deepEqual([...expr.hour], [9]);
	assert.deepEqual([...expr.dow].sort(), [1, 2, 3, 4, 5]);
	assert.equal(expr.domRestricted, false);
	assert.equal(expr.dowRestricted, true);

	const hourly = parseCron("@hourly");
	assert.deepEqual([...hourly.minute], [0]);
	assert.equal(hourly.hour.size, 24); // hour 为通配 → 全集
	assert.equal(hourly.hour.has(13), true);
});

test("parseCron：步长与列表", () => {
	const expr = parseCron("*/15 8,20 * * *");
	assert.deepEqual([...expr.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
	assert.deepEqual([...expr.hour].sort((a, b) => a - b), [8, 20]);

	// 星期 7 归一为 0
	const sunday = parseCron("0 0 * * 7");
	assert.deepEqual([...sunday.dow], [0]);
});

test("parseCron：非法输入抛错", () => {
	assert.throws(() => parseCron("0 9 * *"), CronParseError, "4 段应报错");
	assert.throws(() => parseCron("60 * * * *"), CronParseError, "分钟越界");
	assert.throws(() => parseCron("*/0 * * * *"), CronParseError, "step=0");
	assert.throws(() => parseCron("0 0 32 * *"), CronParseError, "日越界");
	assert.throws(() => parseCron("0 0 * 13 *"), CronParseError, "月越界");
	assert.throws(() => parseCron("5-1 * * * *"), CronParseError, "区间倒置");
});

test("nextCronAfter：跨时区（Asia/Shanghai 每日 09:00）", () => {
	const expr = parseCron("0 9 * * *");
	const tz = "Asia/Shanghai";

	// 2026-01-01T00:00Z = 当地 08:00 → 下一个是当天 09:00 = 01:00Z
	assert.equal(nextCronAfter(expr, new Date("2026-01-01T00:00:00Z"), tz)?.toISOString(), "2026-01-01T01:00:00.000Z");
	// 2026-01-01T02:00Z = 当地 10:00 → 下一个是次日 09:00 = 2026-01-02T01:00Z
	assert.equal(nextCronAfter(expr, new Date("2026-01-01T02:00:00Z"), tz)?.toISOString(), "2026-01-02T01:00:00.000Z");
});

test("nextCronAfter：严格晚于 from（不重复触发同一分钟）", () => {
	const expr = parseCron("0 9 * * *");
	const tz = "Asia/Shanghai";
	const exact = new Date("2026-01-01T01:00:00Z"); // 正好 09:00
	assert.equal(nextCronAfter(expr, exact, tz)?.toISOString(), "2026-01-02T01:00:00.000Z");
});

test("nextCronAfter：DOM 与 DOW 同时受限时取 OR（Vixie 语义）", () => {
	// 每月 13 号 或 每周五
	const expr = parseCron("0 0 13 * 5");
	// 2026-01-01 是周四 → 最近的「周五」是 1/2，而非 1/13
	const next = nextCronAfter(expr, new Date("2026-01-01T00:00:00Z"), "UTC");
	assert.equal(next?.toISOString(), "2026-01-02T00:00:00.000Z");
});

test("nextCronAfter：DST 春季跳变不崩溃且结果在 from 之后", () => {
	// 纽约 2026-03-08 02:00→03:00，02:30 这一分钟不存在
	const expr = parseCron("30 2 * * *");
	const from = new Date("2026-03-08T00:00:00Z");
	const next = nextCronAfter(expr, from, "America/New_York");
	assert.ok(next, "应能给出一个时刻");
	assert.ok(next!.getTime() > from.getTime());
	// 落在当天附近（不跑到第二天之后）
	assert.ok(next!.getTime() < new Date("2026-03-09T12:00:00Z").getTime());
});

test("nextCronAfter：无法触发的表达式返回 null", () => {
	const expr = parseCron("0 0 30 2 *"); // 2 月 30 日
	assert.equal(nextCronAfter(expr, new Date("2026-01-01T00:00:00Z"), "UTC"), null);
});

test("wallClockAt：时区换算正确", () => {
	const wall = wallClockAt(new Date("2026-01-01T01:00:00Z"), "Asia/Shanghai");
	assert.equal(wall.year, 2026);
	assert.equal(wall.month, 1);
	assert.equal(wall.day, 1);
	assert.equal(wall.hour, 9);
	assert.equal(wall.minute, 0);
});

test("parseInterval：合法与非法", () => {
	assert.equal(parseInterval("30m"), 30 * 60 * 1000);
	assert.equal(parseInterval("2h"), 2 * 60 * 60 * 1000);
	assert.equal(parseInterval("1d"), 24 * 60 * 60 * 1000);
	assert.equal(parseInterval(" 90s "), 90 * 1000);
	assert.throws(() => parseInterval("45s"), ScheduleError, "小于 1m");
	assert.throws(() => parseInterval("91d"), ScheduleError, "大于 90d");
	assert.throws(() => parseInterval("abc"), ScheduleError);
	assert.throws(() => parseInterval("5"), ScheduleError, "缺单位");
});

test("computeNextRunAt：once / interval / manual", () => {
	const now = new Date("2026-01-01T00:00:00Z");
	assert.equal(
		computeNextRunAt({ type: "once", at: "2026-01-01T10:00:00Z" }, now, "UTC"),
		"2026-01-01T10:00:00.000Z",
	);
	assert.equal(
		computeNextRunAt({ type: "interval", every: "30m" }, now, "UTC"),
		"2026-01-01T00:30:00.000Z",
	);
	assert.equal(computeNextRunAt({ type: "manual" }, now, "UTC"), null);
});

test("shouldFire：catch_up_one 与 skip 的差异", () => {
	const trigger = { type: "interval", every: "5m" } as const;
	const due = "2026-01-01T00:00:00Z";

	// 过期 1 分钟（宽限内）→ 两者都触发
	assert.equal(
		shouldFire({ nextRunAt: due, now: new Date("2026-01-01T00:01:00Z"), missedWindow: "catch_up_one", trigger }).fire,
		true,
	);
	assert.equal(
		shouldFire({ nextRunAt: due, now: new Date("2026-01-01T00:01:00Z"), missedWindow: "skip", trigger }).fire,
		true,
	);

	// 过期 3 小时（远超宽限）→ catch_up_one 补跑一次；skip 放弃
	assert.equal(
		shouldFire({ nextRunAt: due, now: new Date("2026-01-01T03:00:00Z"), missedWindow: "catch_up_one", trigger }).fire,
		true,
	);
	assert.equal(
		shouldFire({ nextRunAt: due, now: new Date("2026-01-01T03:00:00Z"), missedWindow: "skip", trigger }).fire,
		false,
	);
});

test("shouldFire：未到期不触发", () => {
	const trigger = { type: "interval", every: "30m" } as const;
	const result = shouldFire({
		nextRunAt: "2026-01-01T01:00:00Z",
		now: new Date("2026-01-01T00:00:00Z"),
		missedWindow: "catch_up_one",
		trigger,
	});
	assert.equal(result.fire, false);
});

test("systemTimezone：能返回一个 IANA 时区名", () => {
	const tz = systemTimezone();
	assert.ok(tz.length > 0);
	assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()));
});
