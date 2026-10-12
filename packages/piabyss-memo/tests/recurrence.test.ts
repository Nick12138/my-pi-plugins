/**
 * 周期规则单测：校验归一（normalizeRecurrence）与发生时刻计算
 * （nextOccurrence）——时区（含 DST 切换）、interval 锚点对齐、
 * 月末跳过、until 含端点终结。
 *
 * 用已知历法事实锚定：
 *   - 2024-01-01 是周一；2024 年 2 月有 29 天（闰年）；
 *   - America/New_York：2024-03-10 凌晨 2:00 进入夏令时（EST→EDT），
 *     2024-03-03 / 03-10 都是周日。
 */
import { describe, expect, it } from "vitest";
import { normalizeRecurrence, nextOccurrence, type MemoRecurrence } from "../src/recurrence.js";

/** 上海时区某日某时刻的 epoch（+08:00，无夏令时）。 */
function cn(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

describe("normalizeRecurrence（校验与归一）", () => {
  it("fills defaults: interval=1, tz=Asia/Shanghai, until/startDate=null", () => {
    const rule = normalizeRecurrence({ frequency: "daily", time: "09:00" });
    expect(rule).toEqual({
      frequency: "daily",
      interval: 1,
      weekdays: [],
      monthDay: null,
      time: "09:00",
      tz: "Asia/Shanghai",
      until: null,
      startDate: null,
    });
  });

  it("normalizes weekly weekdays (dedupe + sort) and keeps monthDay null", () => {
    const rule = normalizeRecurrence({
      frequency: "weekly",
      weekdays: [3, 1, 1, 7],
      time: "13:00",
      tz: "UTC",
    });
    expect(rule.weekdays).toEqual([1, 3, 7]);
    expect(rule.monthDay).toBeNull();
  });

  it("requires weekdays for weekly and monthDay for monthly", () => {
    expect(() => normalizeRecurrence({ frequency: "weekly", time: "09:00" })).toThrow(/weekdays/);
    expect(() =>
      normalizeRecurrence({ frequency: "weekly", weekdays: [8], time: "09:00" }),
    ).toThrow(/weekdays/);
    expect(() => normalizeRecurrence({ frequency: "monthly", time: "09:00" })).toThrow(/monthDay/);
  });

  it("rejects invalid interval / monthDay / time / tz / until / non-object", () => {
    expect(() => normalizeRecurrence({ frequency: "daily", time: "09:00", interval: 0 }))
      .toThrow(/interval/);
    expect(() => normalizeRecurrence({ frequency: "daily", time: "09:00", interval: 366 }))
      .toThrow(/interval/);
    expect(() => normalizeRecurrence({ frequency: "monthly", monthDay: 32, time: "09:00" }))
      .toThrow(/monthDay/);
    expect(() => normalizeRecurrence({ frequency: "daily", time: "9:00" })).toThrow(/time/);
    expect(() => normalizeRecurrence({ frequency: "daily", time: "24:00" })).toThrow(/time/);
    expect(() => normalizeRecurrence({ frequency: "daily", time: "09:00", tz: "Mars/Shanghai" }))
      .toThrow(/tz/);
    expect(() => normalizeRecurrence({ frequency: "daily", time: "09:00", until: -1 }))
      .toThrow(/until/);
    expect(() => normalizeRecurrence(null)).toThrow(/对象/);
    expect(() => normalizeRecurrence("weekly")).toThrow(/对象/);
    expect(() => normalizeRecurrence({ frequency: "cron", time: "09:00" })).toThrow(/frequency/);
  });

  it("normalizes non-target-frequency fields away (monthly clears weekdays)", () => {
    const rule = normalizeRecurrence({
      frequency: "monthly",
      monthDay: 15,
      weekdays: [1, 2], // monthly 不用 weekdays，强制清空
      time: "09:00",
    });
    expect(rule.weekdays).toEqual([]);
    expect(rule.monthDay).toBe(15);
  });

  it("is idempotent: normalizing an already-normalized rule keeps it intact", () => {
    const rule = normalizeRecurrence({ frequency: "weekly", weekdays: [1], time: "13:00" });
    expect(normalizeRecurrence(rule)).toEqual(rule);
  });
});

describe("nextOccurrence（daily / weekly / monthly）", () => {
  const anchor = cn(2024, 1, 1, 8); // 2024-01-01（周一）08:00

  it("daily: same-day when still ahead, next day otherwise", () => {
    const rule = normalizeRecurrence({ frequency: "daily", time: "09:00" });
    // 当天 10:00（+08）→ 今天 09:00 已过 → 明天。
    expect(nextOccurrence(rule, cn(2024, 1, 12, 10), anchor)).toBe(cn(2024, 1, 13, 9));
    // 当天 08:00 → 今天 09:00 未到。
    expect(nextOccurrence(rule, cn(2024, 1, 12, 8), anchor)).toBe(cn(2024, 1, 12, 9));
    // 恰好 09:00 整 → 严格晚于 after → 明天。
    expect(nextOccurrence(rule, cn(2024, 1, 12, 9), anchor)).toBe(cn(2024, 1, 13, 9));
  });

  it("daily with interval: aligned to the anchor day", () => {
    const rule = normalizeRecurrence({ frequency: "daily", interval: 3, time: "09:00" });
    // 锚 1/1，对齐日 1/1、1/4、1/7…；after=1/3 → 1/4。
    expect(nextOccurrence(rule, cn(2024, 1, 3, 8), anchor)).toBe(cn(2024, 1, 4, 9));
  });

  it("weekly on Monday: rolls to next Monday and skips missed weeks", () => {
    const rule = normalizeRecurrence({ frequency: "weekly", weekdays: [1], time: "13:00" });
    expect(nextOccurrence(rule, cn(2024, 1, 1, 12), anchor)).toBe(cn(2024, 1, 1, 13));
    expect(nextOccurrence(rule, cn(2024, 1, 1, 14), anchor)).toBe(cn(2024, 1, 8, 13));
    // 周三问下一轮：仍是下周一。
    expect(nextOccurrence(rule, cn(2024, 1, 3, 8), anchor)).toBe(cn(2024, 1, 8, 13));
    // 错过整整两周（1/15 才处理）：跳到未来的第一个周一。
    expect(nextOccurrence(rule, cn(2024, 1, 15, 8), anchor)).toBe(cn(2024, 1, 15, 13));
  });

  it("weekly with interval=2: anchored to the anchor's week", () => {
    const rule = normalizeRecurrence({
      frequency: "weekly",
      interval: 2,
      weekdays: [1],
      time: "13:00",
    });
    // 锚 1/1（周一）：对齐 1/1、1/15、1/29…；1/8 不在对齐周。
    expect(nextOccurrence(rule, cn(2024, 1, 2, 8), anchor)).toBe(cn(2024, 1, 15, 13));
    expect(nextOccurrence(rule, cn(2024, 1, 8, 14), anchor)).toBe(cn(2024, 1, 15, 13));
    expect(nextOccurrence(rule, cn(2024, 1, 16, 8), anchor)).toBe(cn(2024, 1, 29, 13));
  });

  it("weekly with startDate anchor in the future starts at startDate", () => {
    const rule = normalizeRecurrence({
      frequency: "weekly",
      weekdays: [1],
      time: "13:00",
      startDate: cn(2024, 1, 8, 8),
    });
    // after 在锚点之前 → 首轮 = startDate 那一周的周一（1/8），不是 1/1。
    expect(nextOccurrence(rule, cn(2024, 1, 2, 8), anchor)).toBe(cn(2024, 1, 8, 13));
  });

  it("monthly on day 31 skips short months (Feb 2024 has 29 days)", () => {
    const rule = normalizeRecurrence({ frequency: "monthly", monthDay: 31, time: "13:00" });
    expect(nextOccurrence(rule, cn(2024, 1, 15, 8), anchor)).toBe(cn(2024, 1, 31, 13));
    // 1/31 13:00 已过 → 2 月没有 31 号 → 3/31。
    expect(nextOccurrence(rule, cn(2024, 1, 31, 14), anchor)).toBe(cn(2024, 3, 31, 13));
  });

  it("monthly with interval aligns months to the anchor month", () => {
    const rule = normalizeRecurrence({
      frequency: "monthly",
      interval: 2,
      monthDay: 15,
      time: "09:00",
    });
    // 锚 1 月：对齐 1、3、5…；after 2 月 → 3/15。
    expect(nextOccurrence(rule, cn(2024, 2, 1, 8), anchor)).toBe(cn(2024, 3, 15, 9));
  });

  it("handles DST: America/New_York Sunday 09:00 shifts UTC epoch across the boundary", () => {
    const rule = normalizeRecurrence({
      frequency: "weekly",
      weekdays: [7],
      time: "09:00",
      tz: "America/New_York",
    });
    const nyAnchor = Date.UTC(2024, 2, 3, 0); // 2024-03-03（周日）00:00 UTC
    // 夏令时前：EST(UTC-5) → 09:00 = 14:00Z。
    expect(nextOccurrence(rule, Date.UTC(2024, 2, 2, 12), nyAnchor)).toBe(Date.UTC(2024, 2, 3, 14));
    // 夏令时后（3/10 起 EDT=UTC-4）→ 09:00 = 13:00Z，差 1 小时。
    expect(nextOccurrence(rule, Date.UTC(2024, 2, 4, 12), nyAnchor)).toBe(Date.UTC(2024, 2, 10, 13));
  });

  it("until is inclusive and terminates the series afterwards", () => {
    const rule = normalizeRecurrence({
      frequency: "daily",
      time: "09:00",
      until: cn(2024, 1, 3, 9),
    });
    // 恰好等于 until 的发生时刻：含端点，允许。
    expect(nextOccurrence(rule, cn(2024, 1, 2, 10), anchor)).toBe(cn(2024, 1, 3, 9));
    // after 越过 until → 终结（null）。
    expect(nextOccurrence(rule, cn(2024, 1, 3, 10), anchor)).toBeNull();
    expect(nextOccurrence(rule, cn(2024, 1, 3, 9), anchor)).toBeNull();
  });

  it("candidate exactly at until returns until, one past it returns null", () => {
    const rule: MemoRecurrence = normalizeRecurrence({
      frequency: "monthly",
      monthDay: 15,
      time: "09:00",
      until: cn(2024, 5, 15, 9),
    });
    // 4/15 那轮已过 → 下一轮 5/15 恰好等于 until：含端点，允许。
    expect(nextOccurrence(rule, cn(2024, 4, 15, 10), anchor)).toBe(cn(2024, 5, 15, 9));
    expect(nextOccurrence(rule, cn(2024, 5, 15, 10), anchor)).toBeNull();
  });
});
