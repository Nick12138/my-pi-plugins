/**
 * 执行器：把一次触发变成「一个独立 pi 会话」，跑完后落 run 记录 + 通知。
 *
 * 关键点（已在 spike 中验证）：
 * - 扩展进程内可直接用 SDK 的 createAgentSession 建独立会话；
 * - SessionManager.create(cwd, 自定义 sessionDir) 让会话文件不污染 ~/.pi/agent/sessions；
 * - tools 白名单（只读/可写）结构性生效；full 档不传白名单；
 * - noExtensions 默认开启，避免执行会话重复加载扩展（防递归 + 降开销）。
 */
import { existsSync, mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { decodeConsoleOutput } from "./console-decode.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { buildTaskPrompt, extractAssistantText, summarize } from "./prompt.ts";
import { toolsForAudit, toolsForPermission } from "./permissions.ts";
import { systemTimezone } from "./schedule.ts";
import {
	appendLedger,
	ensureRoot,
	newRunId,
	sessionDir,
	writeRun,
} from "./store.ts";
import {
	LIMITS,
	type Job,
	type RunRecord,
	type RunStatus,
	type RunTrigger,
	type ThinkingLevelName,
	type UsageSummary,
} from "./types.ts";

/** SDK 期望的 thinking 级别类型（等价于 pi 的 ThinkingLevel，含 "off"）。 */
type ThinkingLevelArg = NonNullable<Parameters<AgentSession["setThinkingLevel"]>[0]>;

export interface RunOptions {
	trigger: RunTrigger;
	scheduledFor?: string | null;
	/** 续聊：源 run 的会话文件（fork 语义）。 */
	forkFromSessionPath?: string | null;
	forkOfRunId?: string | null;
	replyText?: string | null;
	/** 覆盖 job 的模型/权限（工具 run_now 的临时覆盖）。 */
	modelOverride?: ModelRefLike | null;
	permissionOverride?: Job["permission"];
	timeoutMsOverride?: number;
	agentDir?: string;
	onStatusChange?: (record: RunRecord) => void;
}

export interface ModelRefLike {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

/** 模型解析结果，带一个可读的失败原因。 */
export interface ResolvedModel {
	model: Model<string>;
	ref: ModelRefLike;
}

function resolveAgentDir(explicit?: string): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (explicit?.trim()) return explicit.trim();
	if (fromEnv) return fromEnv;
	return join(homedir(), ".pi", "agent");
}

/**
 * 解析 job 指定的模型。
 *
 * 铁律：
 * - 先 `getAvailable()` 触发 catalog 加载——`getModel()` 是同步读注册表，
 *   未加载时恒为 undefined，直接调会「静默回退到别的模型」（踩过）。
 * - 任务**显式指定**模型却解析不到 → 报错，绝不静默换模型。
 * - 任务未指定 → 回退 settings 默认；再不行才用任一可用模型。
 */
export async function resolveModel(
	runtime: ModelRuntime,
	settings: SettingsManager,
	wanted: ModelRefLike | null,
): Promise<ResolvedModel> {
	// 必须 await：否则 models.json 里的 provider 尚未进注册表
	const available = await runtime.getAvailable();
	const lookup = (provider: string, id: string): Model<string> | undefined => {
		const fromRuntime = runtime.getModel(provider, id) as Model<string> | undefined;
		if (fromRuntime) return fromRuntime;
		return available.find((m) => m.provider === provider && m.id === id) as Model<string> | undefined;
	};

	if (wanted) {
		const model = lookup(wanted.provider, wanted.id);
		if (!model) {
			const known = available
				.filter((m) => m.provider === wanted.provider)
				.map((m) => m.id)
				.slice(0, 8);
			throw new Error(
				`任务指定的模型不存在：${wanted.provider}/${wanted.id}` +
					(known.length > 0
						? `。provider ${wanted.provider} 可用模型：${known.join(", ")}`
						: `。provider ${wanted.provider} 不可用或未登录`),
			);
		}
		return { model, ref: wanted };
	}

	const global = settings.getGlobalSettings() as { defaultProvider?: string; defaultModel?: string };
	if (global.defaultProvider && global.defaultModel) {
		const model = lookup(global.defaultProvider, global.defaultModel);
		if (model) return { model, ref: { provider: global.defaultProvider, id: global.defaultModel } };
	}

	const first = available[0];
	if (!first) throw new Error("没有可用模型：请先在 pi 中登录 provider 或配置 models.json");
	return { model: first as Model<string>, ref: { provider: first.provider, id: first.id } };
}

function statusFromError(error: unknown, timedOut: boolean): { status: RunStatus; message: string } {
	const message = error instanceof Error ? error.message : String(error);
	// 超时优先：abort() 抛出的错误文本本身可能就含 abort，不能先判 abort
	if (timedOut || /timeout|timed out|超时/i.test(message)) {
		return { status: "timeout", message: message || "执行超时" };
	}
	if (/abort/i.test(message)) return { status: "aborted", message: message || "已中止" };
	return { status: "error", message };
}

function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * 从最后一条 assistant 消息读出终止原因。
 *
 * pi 的 `prompt()` 在**模型/网络报错时也会正常 resolve**（错误落在 stopReason/errorMessage 上），
 * 所以不能只看「有没有抛异常」，否则 451/429/网络错误会被当成成功（踩过）。
 */
function inspectAssistantOutcome(messages: Array<{
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}>): { status: RunStatus; error: string | null } {
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	if (!last) return { status: "error", error: "执行结束但没有 assistant 回复（模型可能未响应）" };
	if (last.stopReason === "error" || last.errorMessage) {
		const detail = (last.errorMessage ?? "模型调用失败").replace(/\s+/g, " ").trim();
		return { status: "error", error: truncate(detail, 600) };
	}
	if (last.stopReason === "aborted") return { status: "aborted", error: "模型响应被中止" };
	return { status: "ok", error: null };
}

/**
 * 执行一次任务。返回最终 run 记录（含终态）。
 *
 * 该函数**不抛异常**：失败也会落一条 error run，保证历史完整。
 * 命令型任务（job.command 非空）直接执行 shell 命令，不经模型。
 */
export async function runJob(job: Job, options: RunOptions): Promise<RunRecord> {
	if (job.command) return runCommandJob(job, options);
	ensureRoot();
	const trigger = options.trigger;
	const runId = newRunId();
	const startedAt = new Date();
	const permission = options.permissionOverride ?? job.permission;
	const modelWanted = options.modelOverride ?? job.model;
	const timeoutMs = options.timeoutMsOverride ?? job.timeoutMs;
	const agentDir = resolveAgentDir(options.agentDir);
	const runSessionDir = sessionDir(job.id);
	mkdirSync(runSessionDir, { recursive: true });

	const tools = toolsForAudit(permission);
	let record: RunRecord = {
		runId,
		jobId: job.id,
		jobName: job.name,
		trigger,
		scheduledFor: options.scheduledFor ?? null,
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		status: "running",
		cwd: job.cwd,
		model: modelWanted
			? {
					provider: modelWanted.provider,
					id: modelWanted.id,
					...(modelWanted.thinkingLevel
						? { thinkingLevel: modelWanted.thinkingLevel as ThinkingLevelName }
						: {}),
				}
			: null,
		permission,
		tools,
		sessionId: null,
		sessionPath: null,
		forkOf: options.forkOfRunId ?? null,
		replyText: options.replyText ?? null,
		usage: null,
		summary: "",
		outputText: "",
		toolCalls: 0,
		command: null,
		error: null,
		idempotencyKey: `${job.id}:${options.scheduledFor ?? runId}`,
	};
	writeRun(record);
	options.onStatusChange?.(record);

	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;

	try {
		const runtime = await ModelRuntime.create({});
		// 注意：SettingsManager 用任务的工作区，保证读取该工作区的项目设置
		const settings = SettingsManager.create(job.cwd, agentDir);
		const resolved = await resolveModel(runtime, settings, modelWanted);
		record.model = {
			provider: resolved.ref.provider,
			id: resolved.ref.id,
			thinkingLevel: resolved.ref.thinkingLevel as ThinkingLevelName | undefined,
		};
		writeRun(record);

		// 会话定位：新建 或 fork 源会话（续聊，源文件只读不改）
		const forkSource = options.forkFromSessionPath;
		const sessionManager =
			forkSource && existsSync(forkSource)
				? SessionManager.forkFrom(forkSource, job.cwd, runSessionDir)
				: SessionManager.create(job.cwd, runSessionDir);

		const resourceLoader = new DefaultResourceLoader({
			cwd: job.cwd,
			agentDir,
			settingsManager: settings,
			noExtensions: !job.loadExtensions,
			noSkills: !job.loadExtensions,
			noPromptTemplates: !job.loadExtensions,
			noThemes: true,
		});
		await resourceLoader.reload();

		const created = await createAgentSession({
			cwd: job.cwd,
			agentDir,
			model: resolved.model,
			thinkingLevel: (resolved.ref.thinkingLevel ?? "medium") as ThinkingLevelArg,
			...(toolsForPermission(permission) ? { tools: toolsForPermission(permission) } : {}),
			modelRuntime: runtime,
			resourceLoader,
			settingsManager: settings,
			sessionManager,
		});
		session = created.session;

		try {
			session.setSessionName(`[定时] ${job.name} #${runId}`);
		} catch {
			/* 会话名非关键 */
		}

		record.sessionId = session.sessionId;
		record.sessionPath = session.sessionFile ?? null;
		writeRun(record);

		unsubscribe = session.subscribe((event: { type?: string }) => {
			if (event?.type === "tool_execution_end") record.toolCalls += 1;
		});

		timer = setTimeout(() => {
			timedOut = true;
			void session?.abort().catch(() => undefined);
		}, timeoutMs);

		const text = buildTaskPrompt({
			job,
			runId,
			trigger,
			scheduledFor: options.scheduledFor ?? null,
			timezone: systemTimezone(),
			replyText: options.replyText ?? undefined,
		});

		await session.prompt(text);
		await session.waitForIdle();

		const messages = session.messages as Array<{
			role?: string;
			content?: unknown;
			usage?: unknown;
			stopReason?: string;
			errorMessage?: string;
		}>;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		record.outputText = summarize(extractAssistantText(lastAssistant?.content), LIMITS.maxOutputChars);
		record.summary = summarize(record.outputText, LIMITS.maxSummaryChars);
		record.usage = aggregateUsage(messages) ?? null;

		if (timedOut) {
			// abort() 会让 prompt() 正常返回：超时必须在这里判，不能等 catch
			record.status = "timeout";
			record.error = `执行超时（${Math.round(timeoutMs / 1000)}s）`;
		} else {
			const outcome = inspectAssistantOutcome(messages);
			record.status = outcome.status;
			record.error = outcome.error;
		}
	} catch (error) {
		const { status, message } = statusFromError(error, timedOut);
		record.status = status;
		record.error = message;
	} finally {
		if (timer) clearTimeout(timer);
		try {
			unsubscribe?.();
		} catch {
			/* 忽略 */
		}
		try {
			session?.dispose();
		} catch {
			/* 忽略 */
		}
	}

	record.finishedAt = new Date().toISOString();
	writeRun(record);

	appendLedger({
		at: record.finishedAt,
		event: record.status === "ok" ? "fire" : "error",
		jobId: job.id,
		jobName: job.name,
		runId: record.runId,
		detail: `${record.status}${record.error ? `: ${record.error}` : ""}`,
	});

	// 通知只由调度器 onRunFinished -> 扩展层 deliverNotification 发出：
	// 这里再写一次会导致同一终态入队两次（面板重复弹窗）。
	options.onStatusChange?.(record);
	return record;
}

function aggregateUsage(messages: Array<{ role?: string; usage?: unknown }>): UsageSummary | null {
	let input = 0;
	let output = 0;
	let cost = 0;
	let seen = false;
	for (const message of messages) {
		const usage = message.usage as
			| { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }
			| undefined;
		if (!usage) continue;
		seen = true;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cost += usage.cost?.total ?? 0;
	}
	if (!seen) return null;
	return { input, output, total: input + output, cost };
}

/**
 * 命令型任务执行：直接跑 shell 命令，不经模型、无执行会话。
 *
 * - shell 跟随系统（Windows=cmd，Unix=/bin/sh）；
 * - timeoutMs 到点杀进程，保留已捕获的输出；
 * - 退出码 0 → ok；非 0 → error；超时 → timeout；
 * - stdout+stderr 写进 run 记录（summary），终态照常走 onRunFinished → 通知队列/会话。
 */
async function runCommandJob(job: Job, options: RunOptions): Promise<RunRecord> {
	ensureRoot();
	const runId = newRunId();
	const startedAt = new Date();
	const timeoutMs = options.timeoutMsOverride ?? job.timeoutMs;
	const command = job.command!;

	const record: RunRecord = {
		runId,
		jobId: job.id,
		jobName: job.name,
		trigger: options.trigger,
		scheduledFor: options.scheduledFor ?? null,
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		status: "running",
		cwd: job.cwd,
		model: null,
		permission: job.permission,
		tools: [], // 不经模型：没有工具调用
		sessionId: null,
		sessionPath: null,
		forkOf: options.forkOfRunId ?? null,
		replyText: options.replyText ?? null,
		usage: null,
		summary: "",
		outputText: "",
		toolCalls: 0,
		command,
		error: null,
		idempotencyKey: `${job.id}:${options.scheduledFor ?? runId}`,
	};
	writeRun(record);
	options.onStatusChange?.(record);

	await new Promise<void>((resolve) => {
		// encoding:"buffer"：Windows 中文系统控制台是 GBK，不能让 exec 按 utf-8 解码
		//（中文会变成不可逆的 U+FFFD），拿原始字节交给 decodeConsoleOutput 处理。
		exec(
			command,
			{ cwd: job.cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true, encoding: "buffer" },
			(error, stdout, stderr) => {
				const out = decodeConsoleOutput(stdout);
				const err = decodeConsoleOutput(stderr);
				const combined = `${out}${err ? (out ? "\n" : "") + err : ""}`.trim();
				record.outputText = truncate(combined, LIMITS.maxOutputChars);
				record.summary = summarize(record.outputText, LIMITS.maxSummaryChars);
				if (error && (error as { killed?: boolean }).killed) {
					record.status = "timeout";
					record.error = `执行超时（${Math.round(timeoutMs / 1000)}s）`;
				} else if (error) {
					const code = (error as { code?: unknown }).code;
					record.status = "error";
					record.error = `退出码 ${String(code ?? "?")}：${truncate(String(err || error.message), 600)}`;
				} else {
					record.status = "ok";
					record.error = null;
				}
				resolve();
			},
		);
	});

	record.finishedAt = new Date().toISOString();
	writeRun(record);

	appendLedger({
		at: record.finishedAt,
		event: record.status === "ok" ? "fire" : "error",
		jobId: job.id,
		jobName: job.name,
		runId: record.runId,
		detail: `command ${record.status}${record.error ? `: ${record.error}` : ""}`,
	});

	options.onStatusChange?.(record);
	return record;
}
