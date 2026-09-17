/**
 * 任务服务层：创建/修改/启停/删除 的**唯一校验入口**。
 * 工具（agent 调用）与 HTTP（PiAbyss 调用）都走这里，保证行为一致。
 */
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isPermissionTier, assertPermissionTier } from "./permissions.ts";
import {
	assertPromptOk,
	assertTimeoutOk,
	computeNextRunAt,
	formatLocal,
	humanizeUntil,
	normalizeTrigger,
	systemTimezone,
	triggerLabel,
	ScheduleError,
} from "./schedule.ts";
import { getJob, listJobs, newJobId, patchJobsWith, purgeJobArtifacts, removeJob, upsertJob } from "./store.ts";
import {
	DEFAULTS,
	LIMITS,
	type Job,
	type MissedWindow,
	type ModelRef,
	type PermissionTier,
	type ThinkingLevelName,
	type Trigger,
} from "./types.ts";

const THINKING_LEVELS: ThinkingLevelName[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MISSED_WINDOWS: MissedWindow[] = ["catch_up_one", "skip"];

export interface JobInput {
	name: string;
	prompt: string;
	/** 命令型任务：非空时直接执行 shell 命令（不经模型），与 prompt 互斥。 */
	command?: string | null;
	cwd: string;
	trigger: Trigger;
	permission?: PermissionTier;
	model?: ModelRef | null;
	missedWindow?: MissedWindow;
	timeoutMs?: number;
	maxRuns?: number | null;
	loadExtensions?: boolean;
	tags?: string[];
	enabled?: boolean;
}

export interface Actor {
	/** 谁改的：agent / piabyss / cli，落进 job.updatedBy 便于审计。 */
	by: string;
}

function assertName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new ScheduleError("name 不能为空");
	if (trimmed.length > 200) throw new ScheduleError("name 过长（>200）");
	return trimmed;
}

function assertCwd(cwd: string): string {
	const resolved = resolvePath(cwd.trim());
	if (!cwd.trim()) throw new ScheduleError("cwd（工作区）不能为空");
	if (!existsSync(resolved)) throw new ScheduleError(`工作区不存在：${resolved}`);
	try {
		if (!statSync(resolved).isDirectory()) throw new ScheduleError(`工作区不是目录：${resolved}`);
	} catch (error) {
		if (error instanceof ScheduleError) throw error;
		throw new ScheduleError(`无法访问工作区：${resolved}`);
	}
	return resolved;
}

function assertModel(model: ModelRef | null | undefined): ModelRef | null {
	if (!model) return null;
	const provider = String(model.provider ?? "").trim();
	const id = String(model.id ?? "").trim();
	if (!provider || !id) throw new ScheduleError("model 需要 provider 与 id");
	const thinkingLevel = model.thinkingLevel;
	if (thinkingLevel && !THINKING_LEVELS.includes(thinkingLevel)) {
		throw new ScheduleError(`thinkingLevel 非法：${thinkingLevel}（可选 ${THINKING_LEVELS.join("/")}）`);
	}
	return thinkingLevel ? { provider, id, thinkingLevel } : { provider, id };
}

function assertTimeout(ms: number | undefined): number {
	if (ms === undefined) return DEFAULTS.timeoutMs;
	return assertTimeoutOk(ms);
}

function assertMaxRuns(maxRuns: number | null | undefined): number | null {
	if (maxRuns === null || maxRuns === undefined) return null;
	if (!Number.isFinite(maxRuns) || maxRuns < 1) throw new ScheduleError("maxRuns 必须 ≥ 1");
	return Math.floor(maxRuns);
}

function assertTags(tags: string[] | undefined): string[] {
	if (!tags) return [];
	if (tags.length > 10) throw new ScheduleError("tags 最多 10 个");
	return tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
}

/** 命令校验：非空（显式传 null/undefined 视为「不用命令型」）；与 prompt 互斥。 */
function assertCommand(command: string | null | undefined): string | null {
	if (command === null || command === undefined) return null;
	const trimmed = command.trim();
	if (!trimmed) return null;
	if (trimmed.length > LIMITS.maxCommandChars) {
		throw new ScheduleError(`command 过长（>${LIMITS.maxCommandChars}）`);
	}
	return trimmed;
}

export function createJob(input: JobInput, actor: Actor): Job {
	const existing = listJobs();
	if (existing.length >= LIMITS.maxJobs) {
		throw new ScheduleError(`任务数已达上限 ${LIMITS.maxJobs}，请先删除不用的任务`);
	}

	const now = new Date();
	const timezone = systemTimezone();
	const trigger = normalizeTrigger(input.trigger, now, timezone);
	const permission = input.permission ?? DEFAULTS.permission;
	if (!isPermissionTier(permission)) throw new ScheduleError(`permission 非法：${permission}`);
	const command = assertCommand(input.command);
	if (command && input.prompt?.trim()) {
		throw new ScheduleError("command 与 prompt 互斥：命令型任务不需要 prompt");
	}
	const job: Job = {
		id: newJobId(),
		name: assertName(input.name),
		prompt: command ? "" : assertPromptOk(input.prompt),
		command,
		cwd: assertCwd(input.cwd),
		enabled: input.enabled ?? true,
		permission,
		model: assertModel(input.model),
		trigger,
		missedWindow: input.missedWindow ?? DEFAULTS.missedWindow,
		timeoutMs: assertTimeout(input.timeoutMs),
		maxRuns: assertMaxRuns(input.maxRuns),
		loadExtensions: input.loadExtensions ?? false,
		tags: assertTags(input.tags),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		updatedBy: actor.by,
		nextRunAt: null,
		lastRunAt: null,
		lastRunId: null,
		lastStatus: null,
		runCount: 0,
		terminated: null,
	};
	if (!MISSED_WINDOWS.includes(job.missedWindow)) {
		throw new ScheduleError(`missedWindow 非法：${job.missedWindow}`);
	}
	job.nextRunAt = computeNextRunAt(job.trigger, now, timezone, { inclusive: true });
	upsertJob(job);
	return job;
}

export interface JobPatch {
	name?: string;
	prompt?: string;
	/** 非空字符串切到命令型（自动清空 prompt）；null/空串切回模型型（需同时给 prompt）。 */
	command?: string | null;
	cwd?: string;
	trigger?: Trigger;
	permission?: PermissionTier;
	model?: ModelRef | null;
	missedWindow?: MissedWindow;
	timeoutMs?: number;
	maxRuns?: number | null;
	loadExtensions?: boolean;
	tags?: string[];
	enabled?: boolean;
}

export function updateJob(id: string, patch: JobPatch, actor: Actor): Job {
	const current = getJob(id);
	if (!current) throw new ScheduleError(`任务不存在：${id}`);
	const now = new Date();
	const timezone = systemTimezone();

	const next: Job = { ...current };
	if (patch.name !== undefined) next.name = assertName(patch.name);
	if (patch.prompt !== undefined) next.prompt = assertPromptOk(patch.prompt);
	if (patch.command !== undefined) {
		next.command = assertCommand(patch.command);
		if (next.command) next.prompt = ""; // 切到命令型：prompt 不再使用
	}
	if (patch.cwd !== undefined) next.cwd = assertCwd(patch.cwd);
	if (patch.trigger !== undefined) next.trigger = normalizeTrigger(patch.trigger, now, timezone);
	if (patch.permission !== undefined) {
		if (!isPermissionTier(patch.permission)) throw new ScheduleError(`permission 非法：${patch.permission}`);
		next.permission = patch.permission;
	}
	if (patch.model !== undefined) next.model = assertModel(patch.model);
	if (patch.missedWindow !== undefined) {
		if (!MISSED_WINDOWS.includes(patch.missedWindow)) {
			throw new ScheduleError(`missedWindow 非法：${patch.missedWindow}`);
		}
		next.missedWindow = patch.missedWindow;
	}
	if (patch.timeoutMs !== undefined) next.timeoutMs = assertTimeout(patch.timeoutMs);
	if (patch.maxRuns !== undefined) next.maxRuns = assertMaxRuns(patch.maxRuns);
	if (patch.loadExtensions !== undefined) next.loadExtensions = Boolean(patch.loadExtensions);
	if (patch.tags !== undefined) next.tags = assertTags(patch.tags);

	const scheduleChanged = patch.trigger !== undefined;

	if (!next.command && !next.prompt) {
		throw new ScheduleError("任务缺少 prompt：非命令型任务必须有 prompt（或改用 command）");
	}

	// 用 patchJobsWith：补丁在锁内基于**最新 job** 计算，不会用陈旧快照
	// 覆盖并发产生的新值（runCount/lastStatus/nextRunAt）——两个宿主共用一个
	// 数据目录时特别重要（否则可能把 nextRunAt 回退到刚打过的 slot）。
	const applied = patchJobsWith([id], (fresh) => {
		const reEnabled = patch.enabled === true && fresh.enabled === false;
		const out: Partial<Job> = { ...next, updatedAt: now.toISOString(), updatedBy: actor.by };
		// 下面这些字段依赖锁内最新状态：不要用锁外快照的值
		out.enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : fresh.enabled;
		out.terminated = reEnabled ? null : fresh.terminated;
		out.runCount = fresh.runCount;
		out.lastRunAt = fresh.lastRunAt;
		out.lastRunId = fresh.lastRunId;
		out.lastStatus = fresh.lastStatus;
		out.trigger = patch.trigger !== undefined ? next.trigger : fresh.trigger;
		out.nextRunAt =
			scheduleChanged || reEnabled
				? computeNextRunAt(out.trigger ?? fresh.trigger, now, timezone, { inclusive: true })
				: fresh.nextRunAt;
		return out;
	});
	const updated = applied[0]?.patch;
	if (!updated) throw new ScheduleError(`任务不存在：${id}`);
	return getJob(id)!;
}

export function setEnabled(id: string, enabled: boolean, actor: Actor): Job {
	return updateJob(id, { enabled }, actor);
}

export function deleteJob(id: string, actor: Actor, options: { purgeArtifacts?: boolean } = {}): boolean {
	const job = getJob(id);
	if (!job) throw new ScheduleError(`任务不存在：${id}`);
	const removed = removeJob(id);
	if (removed && options.purgeArtifacts) purgeJobArtifacts(id);
	void actor;
	return removed;
}

// ── 文本渲染（工具输出/HTTP 展示共用）────────────────────────

export function describeJob(job: Job, timezone = systemTimezone()): string {
	const state = job.terminated
		? `[off/terminated:${job.terminated}]`
		: job.enabled
			? "[on]"
			: "[off]";
	const model = job.model ? `${job.model.provider}/${job.model.id}` : "默认";
	const lines = [
		`${state} ${job.name} (${job.id})`,
		`  触发：${triggerLabel(job.trigger, timezone)}${job.enabled && !job.terminated ? ` · 下次 ${humanizeUntil(job.nextRunAt, new Date())}` : ""}`,
		`  工作区：${job.cwd}`,
		job.command
			? `  命令型：${job.command}`
			: `  权限：${job.permission} · 模型：${model}`,
		job.lastStatus ? `  上次：${job.lastStatus}${job.lastRunAt ? ` @ ${formatLocal(job.lastRunAt, timezone)}` : ""} · 已跑 ${job.runCount} 次` : "  尚未执行",
	];
	return lines.join("\n");
}

export function describeJobList(jobs: Job[], timezone = systemTimezone()): string {
	if (jobs.length === 0) return "（暂无定时任务）";
	return jobs.map((job) => describeJob(job, timezone)).join("\n\n");
}
