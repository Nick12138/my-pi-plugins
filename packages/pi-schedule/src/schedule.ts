/**
 * 调度语义：interval 解析、trigger 校验、nextRunAt 计算、错过窗口判定。
 *
 * 一切以「外部时钟」为准（绝不信模型报的时间），且所有时间都是绝对 ISO 串。
 */
import { CronParseError, nextCronAfter, parseCron, wallClockAt } from "./cron.ts";
import { DEFAULTS, LIMITS, type MissedWindow, type Trigger } from "./types.ts";

export class ScheduleError extends Error {}

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
};

const INTERVAL_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i;

/** 解析 `30m` / `2h` / `1d` / `45s`。 */
export function parseInterval(input: string): number {
	const match = INTERVAL_RE.exec(input);
	if (!match) {
		throw new ScheduleError(`interval 格式非法："${input}"，示例：30m、2h、1d、45s`);
	}
	const value = Number.parseFloat(match[1]!);
	const unit = match[2]!.toLowerCase();
	const ms = Math.round(value * UNIT_MS[unit]!);
	if (ms < DEFAULTS.minIntervalMs) {
		throw new ScheduleError(`interval 不能小于 1m（实际 ${input}）`);
	}
	if (ms > DEFAULTS.maxIntervalMs) {
		throw new ScheduleError(`interval 不能大于 90d（实际 ${input}）`);
	}
	return ms;
}

export function intervalToText(ms: number): string {
	if (ms % UNIT_MS.d! === 0) return `${ms / UNIT_MS.d!}d`;
	if (ms % UNIT_MS.h! === 0) return `${ms / UNIT_MS.h!}h`;
	if (ms % UNIT_MS.m! === 0) return `${ms / UNIT_MS.m!}m`;
	return `${Math.round(ms / UNIT_MS.s!)}s`;
}

/**
 * 校验并归一化 trigger（会抛 ScheduleError）。
 *
 * 时区优先级：**任务自己的 timezone 优先**，未指定才用传入的默认时区。
 * （曾经写反成 timezone ?? trigger.timezone，导致任务时区被系统时区静默吞掉。）
 */
export function normalizeTrigger(trigger: Trigger, now: Date, timezone?: string): Trigger {
	switch (trigger.type) {
		case "manual":
			return { type: "manual" };
		case "once": {
			const at = new Date(trigger.at);
			if (Number.isNaN(at.getTime())) {
				throw new ScheduleError(`once.at 不是合法时间：${trigger.at}`);
			}
			if (at.getTime() <= now.getTime()) {
				throw new ScheduleError(`once.at 必须晚于当前时间（${at.toISOString()}）`);
			}
			return { type: "once", at: at.toISOString() };
		}
		case "interval":
			parseInterval(trigger.every);
			return { type: "interval", every: trigger.every.trim() };
		case "cron": {
			const tz = trigger.timezone ?? timezone;
			if (trigger.timezone && !isValidTimezone(trigger.timezone)) {
				throw new ScheduleError(`未知时区：${trigger.timezone}`);
			}
			try {
				const expr = parseCron(trigger.cron);
				if (!nextCronAfter(expr, now, tz ?? "UTC")) {
					throw new ScheduleError(`cron 在 1500 天内不会触发：${trigger.cron}`);
				}
			} catch (error) {
				if (error instanceof CronParseError) throw new ScheduleError(error.message);
				throw error;
			}
			return { type: "cron", cron: trigger.cron.trim(), timezone: tz };
		}
	}
}

/** 校验 IANA 时区名；非法值直接报错，不静默降级为 UTC。 */
export function isValidTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
		return true;
	} catch {
		return false;
	}
}

/** 计算下一次触发时刻；manual 返回 null。 */
export function computeNextRunAt(
	trigger: Trigger,
	from: Date,
	timezone: string,
	options: { inclusive?: boolean } = {},
): string | null {
	switch (trigger.type) {
		case "manual":
			return null;
		case "once":
			// once 是固定的绝对时刻：调用方必须自己判断它是否已过（不会前进）
			return new Date(trigger.at).toISOString();
		case "interval": {
			const ms = parseInterval(trigger.every);
			return new Date(from.getTime() + ms).toISOString();
		}
		case "cron": {
			const expr = parseCron(trigger.cron);
			const tz = trigger.timezone ?? timezone;
			// inclusive：刚建的任务若正好落在当前分钟，允许本次即触发
			const anchor = options.inclusive ? new Date(from.getTime() - 60_000) : from;
			const next = nextCronAfter(expr, anchor, tz);
			return next ? next.toISOString() : null;
		}
	}
}

/**
 * 排期推进：从 `scheduledFor` 起按周期前进，直到落在 `now` 之后（避免漂移）。
 *
 * - interval：`scheduledFor + N*period`，保留节拍（不会因为一次跑得久而整体后移）。
 * - cron：下一个表达式时刻。
 * - once：固定时刻，若已过则返回 null（调用方据此终止任务，而不是反复重写）。
 */
export function advanceNextRunAt(
	trigger: Trigger,
	now: Date,
	timezone: string,
	scheduledFor: string | null,
): string | null {
	if (trigger.type === "once") {
		const at = new Date(trigger.at).getTime();
		return at > now.getTime() ? new Date(at).toISOString() : null;
	}
	if (trigger.type === "manual") return null;

	const anchor = scheduledFor && !Number.isNaN(new Date(scheduledFor).getTime()) ? new Date(scheduledFor) : now;
	if (trigger.type === "cron") {
		// 必须是**严格未来**：用 inclusive 会返回「当前分钟起点」而它 ≤ now，
		// 结果 nextRunAt 永远停在过去 → 每个 tick 都重新发车 + 重写 jobs.json（P0）。
		const next = computeNextRunAt(trigger, now, timezone);
		return next && new Date(next).getTime() > now.getTime() ? next : null;
	}

	// interval：从原计划时刻按周期**一次性跳**到未来（O(1)，避免循环上限导致返回过去时间）
	const period = parseInterval(trigger.every);
	const anchorMs = anchor.getTime();
	const elapsed = now.getTime() - anchorMs;
	const steps = elapsed >= 0 ? Math.floor(elapsed / period) + 1 : 1;
	return new Date(anchorMs + steps * period).toISOString();
}

/** interval 的宽限期：max(2×tick, 25% 周期)，上限 15 分钟。 */
export function graceMsFor(trigger: Trigger): number {
	if (trigger.type === "interval") {
		const period = parseInterval(trigger.every);
		return Math.min(15 * 60 * 1000, Math.max(2 * DEFAULTS.tickMs, period * 0.25));
	}
	// once / cron：1 小时宽限
	return 60 * 60 * 1000;
}

/**
 * 到期的任务该不该现在跑？
 *
 * - missedWindow=catch_up_one：只要过期就跑一次（然后重新排期）。
 * - missedWindow=skip：仅在宽限期内跑，否则只推进 nextRunAt（过期结果没价值）。
 */
export function shouldFire(args: {
	nextRunAt: string;
	now: Date;
	missedWindow: MissedWindow;
	trigger: Trigger;
}): { fire: boolean; overdueMs: number; withinGrace: boolean } {
	const due = new Date(args.nextRunAt).getTime();
	const overdueMs = args.now.getTime() - due;
	if (overdueMs < 0) return { fire: false, overdueMs, withinGrace: true };
	const withinGrace = overdueMs <= graceMsFor(args.trigger);
	if (args.missedWindow === "skip") return { fire: withinGrace, overdueMs, withinGrace };
	return { fire: true, overdueMs, withinGrace };
}

/** 校验并归一化单次执行超时（5s–6h）；非法值报错。 */
export function assertTimeoutOk(ms: number): number {
	if (!Number.isFinite(ms)) throw new ScheduleError(`timeoutMs 非法：${ms}`);
	if (ms < 5_000) throw new ScheduleError("timeoutMs 最小 5000（5 秒）");
	if (ms > 6 * 60 * 60 * 1000) throw new ScheduleError("timeoutMs 最大 6 小时");
	return Math.round(ms);
}

/** 触发类型的中文标签（列表展示用）。 */
export function triggerLabel(trigger: Trigger, timezone: string): string {
	switch (trigger.type) {
		case "manual":
			return "仅手动";
		case "once":
			return `一次性 @ ${formatLocal(trigger.at, timezone)}`;
		case "interval":
			return `每 ${trigger.every}`;
		case "cron":
			return `cron ${trigger.cron}${trigger.timezone && trigger.timezone !== timezone ? ` (${trigger.timezone})` : ""}`;
	}
}

export function formatLocal(iso: string, timezone: string): string {
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(new Date(iso));
	} catch {
		return iso;
	}
}

/** 系统时区（可用 PI_SCHEDULE_TZ 覆盖，便于测试）。 */
export function systemTimezone(): string {
	const explicit = process.env.PI_SCHEDULE_TZ?.trim();
	if (explicit) return explicit;
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** 校验 prompt 长度。 */
export function assertPromptOk(prompt: string): string {
	const trimmed = prompt.trim();
	if (!trimmed) throw new ScheduleError("prompt（任务内容）不能为空");
	if (trimmed.length > LIMITS.maxPromptChars) {
		throw new ScheduleError(`prompt 过长（${trimmed.length} > ${LIMITS.maxPromptChars}）`);
	}
	return trimmed;
}

/** 距下次触发的可读倒计时。 */
export function humanizeUntil(iso: string | null, now: Date): string {
	if (!iso) return "-";
	const delta = new Date(iso).getTime() - now.getTime();
	if (delta <= 0) return "已到期";
	const s = Math.round(delta / 1000);
	if (s < 60) return `${s}s 后`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m 后`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60}m 后`;
	return `${Math.floor(h / 24)}d${h % 24}h 后`;
}

/** 供 UI 展示的墙钟时间戳（带时区）。 */
export function nowWallClock(timezone: string): string {
	const wall = wallClockAt(new Date(), timezone);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}
