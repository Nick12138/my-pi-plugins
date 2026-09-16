/**
 * 任务提示契约：把一次调度触发的 prompt 包装成**自包含**的指令。
 *
 * 每次执行都是全新会话（零历史上下文），所以契约必须自带：
 * 目标、权限边界、输出要求、以及「没有发现就说 No findings」的反编造约束。
 */
import { PERMISSION_LABEL } from "./permissions.ts";
import { formatLocal, triggerLabel } from "./schedule.ts";
import type { Job, RunTrigger } from "./types.ts";

export interface PromptContext {
	job: Job;
	runId: string;
	trigger: RunTrigger;
	scheduledFor: string | null;
	timezone: string;
	/** 续聊：用户在该历史下的追问（此时 prompt 为用户文本，不再套契约）。 */
	replyText?: string;
}

export function buildTaskPrompt(ctx: PromptContext): string {
	// 续聊模式：直接发用户原话，让 agent 在原会话上下文里继续。
	if (ctx.trigger === "reply" && ctx.replyText) return ctx.replyText;

	const { job } = ctx;
	const lines: string[] = [
		"[scheduled-task]",
		`jobId: ${job.id}`,
		`runId: ${ctx.runId}`,
		`name: ${job.name}`,
		`schedule: ${triggerLabel(job.trigger, ctx.timezone)}`,
		ctx.scheduledFor ? `scheduledFor: ${formatLocal(ctx.scheduledFor, ctx.timezone)}` : "",
		`workspace: ${job.cwd}`,
		`permission: ${job.permission} (${PERMISSION_LABEL[job.permission]})`,
		job.tags.length > 0 ? `tags: ${job.tags.join(", ")}` : "",
		"",
		"## Task",
		job.prompt.trim(),
		"",
		"## Contract",
		"- Isolated run: no prior conversation exists. Work only from this task text.",
		"- Do not invent findings. If tools fail or data is missing, say exactly that.",
		"- If there is nothing actionable, reply exactly \"No findings\".",
		"- Prefer evidence (file:line, command output) over unsupported claims.",
		"- Finish with a short summary: what you checked, what you found, what you did.",
		`- PRIVILEGE: ${job.permission}. ${
			job.permission === "read_only"
				? "You cannot edit/write files or run shell commands; only read/search."
				: job.permission === "write"
					? "You may edit/write files, but you cannot run shell commands."
					: "Full access, including shell commands. Be careful: this runs unattended."
		}`,
	];
	return lines.filter((line) => line !== "").join("\n");
}

/** 从会话消息里提取最后一条 assistant 文本，用于摘要。 */
export function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

export function summarize(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}…`;
}
