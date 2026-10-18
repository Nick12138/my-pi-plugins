/**
 * 5 段 cron 解析与下次触发计算（零依赖）。
 *
 * 支持：通配 `*`、单值 n、区间 a-b、列表 a,b,c、步长（星号或区间后跟 `/n`），
 * 以及 @hourly/@daily/@weekly/@monthly/@yearly 宏。
 * 语义遵循 Vixie cron：月/日/时/分为 AND；日-月（DOM）与星期（DOW）同时受限时取 OR。
 * 星期 0 与 7 都表示周日。
 *
 * 时区：用 Intl 计算目标时区的墙钟时间，避免引入 tz 库；DST 用迭代收敛处理。
 */

export interface CronExpr {
	raw: string;
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	/** DOM 字段是否受限（非 `*`）。 */
	domRestricted: boolean;
	/** DOW 字段是否受限（非 `*`）。 */
	dowRestricted: boolean;
}

export class CronParseError extends Error {}

const MACROS: Record<string, string> = {
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly": "0 0 1 * *",
	"@weekly": "0 0 * * 0",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly": "0 * * * *",
};

interface FieldSpec {
	name: string;
	min: number;
	max: number;
	/** 归一化后的值（如 DOW 的 7→0）。 */
	normalize?: (n: number) => number;
}

const FIELDS: FieldSpec[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "dom", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "dow", min: 0, max: 7, normalize: (n) => (n === 7 ? 0 : n) },
];

function parseField(expr: string, spec: FieldSpec): { values: Set<number>; restricted: boolean } {
	const raw = expr.trim();
	if (!raw) throw new CronParseError(`cron 字段为空：${spec.name}`);
	// 通配字段也填充全集：后续 has()/枚举直接可用，restricted 只用于 DOM/DOW 的 OR 语义
	if (raw === "*" || raw === "?") {
		const values = new Set<number>();
		for (let n = spec.min; n <= spec.max; n += 1) values.add(spec.normalize ? spec.normalize(n) : n);
		return { values, restricted: false };
	}

	const values = new Set<number>();
	for (const part of raw.split(",")) {
		const piece = part.trim();
		if (!piece) throw new CronParseError(`cron ${spec.name} 含空项：${expr}`);

		const [rangePart, stepPart] = piece.split("/");
		let step = 1;
		if (stepPart !== undefined) {
			step = Number.parseInt(stepPart, 10);
			if (!Number.isFinite(step) || step <= 0) {
				throw new CronParseError(`cron step 非法：${piece}`);
			}
		}

		let lo: number;
		let hi: number;
		if (rangePart === "*" || rangePart === "?") {
			lo = spec.min;
			hi = spec.max;
		} else if (rangePart.includes("-")) {
			const [a, b] = rangePart.split("-");
			lo = Number.parseInt(a ?? "", 10);
			hi = Number.parseInt(b ?? "", 10);
		} else {
			lo = Number.parseInt(rangePart ?? "", 10);
			hi = stepPart === undefined ? lo : lo + Math.floor((spec.max - lo) / step) * step;
		}
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
			throw new CronParseError(`cron ${spec.name} 非法：${piece}`);
		}
		if (lo < spec.min || hi > spec.max) {
			throw new CronParseError(`cron ${spec.name} 超出范围 ${spec.min}-${spec.max}：${piece}`);
		}
		if (lo > hi) throw new CronParseError(`cron ${spec.name} 区间倒置：${piece}`);
		for (let n = lo; n <= hi; n += step) {
			values.add(spec.normalize ? spec.normalize(n) : n);
		}
	}
	if (values.size === 0) throw new CronParseError(`cron ${spec.name} 未匹配任何值：${expr}`);
	return { values, restricted: true };
}

export function parseCron(input: string): CronExpr {
	const trimmed = input.trim();
	if (!trimmed) throw new CronParseError("cron 表达式为空");

	const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
	const parts = expanded.split(/\s+/);
	if (parts.length !== 5) {
		throw new CronParseError(
			`cron 需要 5 段（分 时 日 月 周），实际 ${parts.length} 段：${input}。如需秒级请改用 interval 模式。`,
		);
	}
	const parsed = FIELDS.map((spec, index) => parseField(parts[index]!, spec));
	return {
		raw: input.trim(),
		minute: parsed[0]!.values,
		hour: parsed[1]!.values,
		dom: parsed[2]!.values,
		month: parsed[3]!.values,
		dow: parsed[4]!.values,
		domRestricted: parsed[2]!.restricted,
		dowRestricted: parsed[4]!.restricted,
	};
}

export function isValidCron(input: string): boolean {
	try {
		parseCron(input);
		return true;
	} catch {
		return false;
	}
}

// ── 时区工具（Intl，零依赖）──────────────────────────────────

interface WallClock {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
	hour: number;
	minute: number;
	dow: number; // 0-6，周日=0
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
	let fmt = formatterCache.get(timezone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-US", {
			timeZone: timeoutZone(timezone),
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "short",
		});
		formatterCache.set(timezone, fmt);
	}
	return fmt;
}

function timeoutZone(timezone: string): string {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
		return timezone;
	} catch {
		return "UTC";
	}
}

const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallClockAt(instant: Date, timezone: string): WallClock {
	const parts = formatterFor(timezone).formatToParts(instant);
	const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
	const year = Number.parseInt(get("year"), 10);
	const month = Number.parseInt(get("month"), 10);
	const day = Number.parseInt(get("day"), 10);
	// Intl 在 hour12:false 下可能给出 "24"，需归一
	const rawHour = Number.parseInt(get("hour"), 10);
	const hour = rawHour === 24 ? 0 : rawHour;
	const minute = Number.parseInt(get("minute"), 10);
	const dow = DOW_MAP[get("weekday")] ?? new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	return { year, month, day, hour, minute, dow };
}

/** 把目标时区的墙钟时间换算成 UTC 瞬间；DST 用两轮偏移迭代收敛。 */
export function wallClockToInstant(wall: Omit<WallClock, "dow">, timezone: string): Date {
	const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
	let guess = naive;
	for (let i = 0; i < 3; i += 1) {
		const at = wallClockAt(new Date(guess), timezone);
		const asUtc = Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute);
		const offset = asUtc - guess;
		const next = naive - offset;
		if (next === guess) break;
		guess = next;
	}
	return new Date(guess);
}

// ── 下次触发计算 ─────────────────────────────────────────────

/** 搜索上限：闰年 2/29 等罕见组合也够覆盖（约 4 年）。 */
const MAX_SEARCH_DAYS = 1500;

function dayMatches(expr: CronExpr, wall: WallClock): boolean {
	if (!expr.month.has(wall.month)) return false;
	const domHit = expr.dom.has(wall.day);
	const dowHit = expr.dow.has(wall.dow);
	if (expr.domRestricted && expr.dowRestricted) return domHit || dowHit;
	if (expr.domRestricted) return domHit;
	if (expr.dowRestricted) return dowHit;
	return true;
}

function sorted(values: Set<number>): number[] {
	return [...values].sort((a, b) => a - b);
}

/**
 * 返回严格晚于 `from` 的下一个触发时刻；1500 天内无解（如 2 月 30 日）返回 null。
 */
export function nextCronAfter(expr: CronExpr, from: Date, timezone: string): Date | null {
	const tz = timeoutZone(timezone);
	const start = wallClockAt(from, tz);
	const fromMs = from.getTime();

	const minutes = sorted(expr.minute);
	const hours = sorted(expr.hour);

	// 以「起始日」为基准做纯日期运算（只用 UTC 取值，不跨时区偏移），
	// 避免用 UTC 瞬间取墙钟导致负时区跨天。
	const baseDayUtc = Date.UTC(start.year, start.month - 1, start.day);
	for (let dayOffset = 0; dayOffset < MAX_SEARCH_DAYS; dayOffset += 1) {
		const dayProbe = new Date(baseDayUtc + dayOffset * 86_400_000);
		const year = dayProbe.getUTCFullYear();
		const month = dayProbe.getUTCMonth() + 1;
		const day = dayProbe.getUTCDate();
		const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
		const dayWall: WallClock = { year, month, day, hour: 0, minute: 0, dow };
		if (!dayMatches(expr, dayWall)) continue;

		const isStartDay = dayOffset === 0;
		for (const hour of hours) {
			if (isStartDay && hour < start.hour) continue;
			for (const minute of minutes) {
				if (isStartDay && hour === start.hour && minute <= start.minute) continue;
				const instant = wallClockToInstant({ year, month, day, hour, minute }, tz);
				if (instant.getTime() > fromMs) return instant;
			}
		}
	}
	return null;
}

/** 校验 cron 在其后 1500 天内是否至少能触发一次。 */
export function cronHasFutureRun(expr: CronExpr, from: Date, timezone: string): boolean {
	return nextCronAfter(expr, from, timezone) !== null;
}
