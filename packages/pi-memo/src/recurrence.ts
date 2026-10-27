/**
 * 备忘录「计划」规则：一次性截止（dueAt）之外，备忘录记录可以携带周期规则
 * （recurrence），例如「每周一 13:00 处理一次」。
 *
 * 设计要点（与 memo-store 的周期滚动语义配套）：
 *   - 规则是**结构化**的（daily / weekly / monthly + interval + time + tz），
 *     不用 cron——桌面端表单好渲染、agent 好构造、解析无歧义；
 *   - 时刻计算一律在规则声明的 IANA 时区（tz）内进行，**不依赖设备本地时区**
 *     （多设备云同步时，不同设备的本地时区不一致会导致轮次分歧）；
 *   - `nextOccurrence(rule, after, anchor)` 返回严格晚于 `after` 的下一个发生
 *     时刻：错过多轮时直接跳到未来（skip 策略，不补跑）；
 *   - interval > 1（每 N 天/周/月）时以 `startDate ?? anchor` 为锚点对齐
 *     （如「每两周的周一」以锚点所在周为第 0 周）；
 *   - monthly 的 monthDay 超过当月天数时跳过该月（2 月没有 31 号），
 *     不做「夹到月末」——跳过语义无歧义；
 *   - until（含端点）之后不再产生发生时刻；`nextOccurrence` 返回 null 表示
 *     周期已终结。
 *
 * 实现基于 Intl.DateTimeFormat 做时区换算（Node 自带全量 ICU），不引入
 * 第三方日期库。所有函数均为纯函数，便于单测。
 */

/** 周期频率。 */
export type MemoRecurrenceFrequency = "daily" | "weekly" | "monthly";

/** 备忘录周期规则（存储在 MemoNote.recurrence；磁盘格式见 memo-store.ts）。 */
export type MemoRecurrence = {
  frequency: MemoRecurrenceFrequency;
  /** 每 N 天/周/月发生一次；1 = 每天/每周/每月。 */
  interval: number;
  /** weekly 必填：ISO 星期，1=周一 … 7=周日（去重、升序）；其余频率恒为 []。 */
  weekdays: number[];
  /** monthly 必填：每月几号（1..31）；其余频率恒为 null。 */
  monthDay: number | null;
  /** 发生当天的时刻（24 小时制 "HH:mm"）。 */
  time: string;
  /** IANA 时区（如 "Asia/Shanghai"）。 */
  tz: string;
  /** 周期终点（epoch ms，含端点）：该时刻之后不再发生；null = 无限期。 */
  until: number | null;
  /** interval 对齐锚点（epoch ms）；null 时以记录 createdAt 为锚。 */
  startDate: number | null;
};

/* ------------------------------ 时区换算 ------------------------------- */

/** 时区内的日历分量（全为本地值：month 1..12；weekday 为 ISO 1..7）。 */
type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const ISO_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function zonedParts(epoch: number, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(epoch))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const weekday = ISO_WEEKDAYS.indexOf(map.weekday as (typeof ISO_WEEKDAYS)[number]);
  if (weekday < 0) throw new Error(`无法解析时区 ${tz} 的日历分量`);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekday + 1,
  };
}

/** 时区在给定时刻的 UTC 偏移（ms；东八区为 +8h）。 */
function tzOffsetMs(epoch: number, tz: string): number {
  const parts = zonedParts(epoch, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - epoch;
}

/** 时区内某个日历日期时刻对应的 epoch ms（两次偏移修正，兼容 DST 切换日）。 */
function epochAt(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset1 = tzOffsetMs(guess, tz);
  const candidate = guess - offset1;
  const offset2 = tzOffsetMs(candidate, tz);
  return offset2 === offset1 ? candidate : guess - offset2;
}

/** UTC 口径的天序号（同一时区内的两个日历日期相减即为天数差，DST 安全）。 */
function dayCount(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** UTC 日序号 → 日历日期。 */
function dateOfDayCount(count: number): { year: number; month: number; day: number } {
  const utc = new Date(count * 86_400_000);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/** UTC 日序号对应的 ISO 星期（1=周一 … 7=周日）。 */
function isoWeekdayOf(count: number): number {
  const dow = new Date(count * 86_400_000).getUTCDay(); // 0=周日
  return ((dow + 6) % 7) + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/* --------------------------- 规则校验与归一化 ---------------------------- */

const FREQUENCIES: readonly MemoRecurrenceFrequency[] = ["daily", "weekly", "monthly"];
const MAX_INTERVAL = 365;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`周期规则的 ${field} 无效：应为 ${min}~${max} 的整数`);
  }
  return num;
}

function optionalEpoch(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`周期规则的 ${field} 无效：应为正的毫秒时间戳`);
  }
  return Math.round(num);
}

/**
 * 校验并归一化周期规则（create/update 的守门员）。
 * - 缺省值：interval=1、tz="Asia/Shanghai"、until=null、startDate=null；
 * - weekly 要求 weekdays 非空（1..7，去重升序）；monthly 要求 monthDay 1..31；
 * - 非对应频率的 weekdays / monthDay 强制清空，保证磁盘形状唯一。
 * 输入不合法时抛出带中文说明的 Error。
 */
export function normalizeRecurrence(raw: unknown): MemoRecurrence {
  if (!isPlainObject(raw)) throw new Error("周期规则必须是对象");
  const frequency = raw.frequency;
  if (
    typeof frequency !== "string" ||
    !FREQUENCIES.includes(frequency as MemoRecurrenceFrequency)
  ) {
    throw new Error(`周期规则的 frequency 无效：应为 daily/weekly/monthly`);
  }
  const normalizedFrequency = frequency as MemoRecurrenceFrequency;

  const interval =
    raw.interval === undefined ? 1 : requireInt(raw.interval, "interval", 1, MAX_INTERVAL);

  let weekdays: number[] = [];
  if (frequency === "weekly") {
    const list = Array.isArray(raw.weekdays) ? raw.weekdays : [];
    if (list.length === 0) throw new Error("weekly 周期规则必须提供 weekdays（1=周一 … 7=周日）");
    const seen = new Set<number>();
    for (const item of list) {
      const wd = requireInt(item, "weekdays", 1, 7);
      if (!seen.has(wd)) seen.add(wd);
    }
    weekdays = [...seen].sort((a, b) => a - b);
  }

  let monthDay: number | null = null;
  if (frequency === "monthly") {
    if (raw.monthDay === undefined || raw.monthDay === null) {
      throw new Error("monthly 周期规则必须提供 monthDay（1..31）");
    }
    monthDay = requireInt(raw.monthDay, "monthDay", 1, 31);
  }

  const time = raw.time;
  if (typeof time !== "string" || !TIME_RE.test(time)) {
    throw new Error(`周期规则的 time 无效：应为 24 小时制 "HH:mm"`);
  }

  const tz = typeof raw.tz === "string" && raw.tz.trim() ? raw.tz.trim() : "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`周期规则的 tz 无效：不是合法的 IANA 时区（${tz}）`);
  }

  return {
    frequency: normalizedFrequency,
    interval,
    weekdays,
    monthDay,
    time,
    tz,
    until: optionalEpoch(raw.until, "until"),
    startDate: optionalEpoch(raw.startDate, "startDate"),
  };
}

/* ----------------------------- 发生时刻计算 ----------------------------- */

/** 迭代步数上限（防呆：正常路径最多 interval 量级即可命中）。 */
const MAX_STEPS = 20_000;

/**
 * 下一个发生时刻（严格晚于 `after`）：
 *   - 在规则时区内按日历推进（daily/weekly 逐日、monthly 逐月）；
 *   - `anchor`（记录 createdAt）与 rule.startDate 作为 interval 对齐锚点；
 *   - 无未来发生时刻（until 已过 / 迭代上限）返回 null。
 */
export function nextOccurrence(
  rule: MemoRecurrence,
  after: number,
  anchor: number,
): number | null {
  const [hour, minute] = rule.time.split(":").map(Number) as [number, number];
  const anchorTs = rule.startDate ?? anchor;

  if (rule.until !== null && after >= rule.until) {
    // after 已越过终点：不可能再有晚于 after 且不晚于 until 的发生时刻。
    // （严格晚于 after 且 until 含端点：after === until 时下一个必然超出。）
    return null;
  }

  if (rule.frequency === "monthly") {
    const anchorParts = zonedParts(anchorTs, rule.tz);
    const anchorMonthIndex = anchorParts.year * 12 + (anchorParts.month - 1);
    const afterParts = zonedParts(after, rule.tz);
    const afterMonthIndex = afterParts.year * 12 + (afterParts.month - 1);
    // 对齐步数：锚月为第 0 步，每步 interval 个月；从第一个不早于 after 的步起。
    const firstStep = Math.max(
      0,
      Math.ceil((afterMonthIndex - anchorMonthIndex) / rule.interval),
    );
    for (let step = firstStep; step - firstStep < MAX_STEPS; step++) {
      const monthIndex = anchorMonthIndex + step * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      if (rule.monthDay === null || rule.monthDay > daysInMonth(year, month)) continue;
      const candidate = epochAt(year, month, rule.monthDay, hour, minute, rule.tz);
      if (candidate <= after) continue;
      if (rule.until !== null && candidate > rule.until) return null;
      return candidate;
    }
    return null;
  }

  // daily / weekly：逐日推进。
  const afterParts = zonedParts(after, rule.tz);
  const anchorParts = zonedParts(anchorTs, rule.tz);
  const anchorDay = dayCount(anchorParts.year, anchorParts.month, anchorParts.day);
  let day = dayCount(afterParts.year, afterParts.month, afterParts.day);
  if (day < anchorDay) day = anchorDay;
  const anchorWeekday = anchorParts.weekday;

  for (let step = 0; step < MAX_STEPS; step++, day++) {
    if (rule.frequency === "weekly") {
      const weekday = isoWeekdayOf(day);
      if (!rule.weekdays.includes(weekday)) continue;
      const delta = day - anchorDay;
      const weekdayOffset = (weekday - anchorWeekday + 7) % 7;
      if (delta < weekdayOffset) continue;
      if ((delta - weekdayOffset) % (7 * rule.interval) !== 0) continue;
    } else {
      if ((day - anchorDay) % rule.interval !== 0) continue;
    }
    const date = dateOfDayCount(day);
    const candidate = epochAt(date.year, date.month, date.day, hour, minute, rule.tz);
    if (candidate <= after) continue;
    if (rule.until !== null && candidate > rule.until) return null;
    return candidate;
  }
  return null;
}
