/**
 * 工具层单测：注册、参数校验、各 action（不含真实 LLM 调用；run_now 走错误路径）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-tool-"));
process.env.PI_SCHEDULE_DIR = ROOT;

const srcDir = join(import.meta.dirname, "..", "src");
const { Scheduler } = await import(pathToFileURL(join(srcDir, "scheduler.ts")).href);
const { registerScheduleTool, parseModelRef } = await import(pathToFileURL(join(srcDir, "tool.ts")).href);
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);

type ToolResult = { content: Array<{ type: string; text: string }>; details: any };
interface ToolLike {
	name: string;
	parameters: unknown;
	promptGuidelines: string[];
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<ToolResult>;
}

const CWD = join(import.meta.dirname, "..");
const scheduler = new Scheduler({ tickMs: 3_600_000 });
let tool: ToolLike | undefined;
const fakePi = {
	registerTool: (def: ToolLike) => {
		tool = def;
	},
	on: () => undefined,
};
registerScheduleTool(fakePi as never, scheduler);
const ctx = { cwd: CWD };

function invoke(params: Record<string, unknown>): Promise<ToolResult> {
	if (!tool) throw new Error("工具未注册");
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

test("注册：工具名与 schema 就位", () => {
	assert.ok(tool);
	assert.equal(tool.name, "schedule");
	assert.ok(tool.parameters);
	assert.ok(tool.promptGuidelines.length > 0);
});

test("parseModelRef：provider/id[:thinking]", () => {
	assert.deepEqual(parseModelRef("5/deepseek-v4.1-flash"), { provider: "5", id: "deepseek-v4.1-flash" });
	assert.deepEqual(parseModelRef("openai/gpt-5:high"), { provider: "openai", id: "gpt-5", thinkingLevel: "high" });
	assert.equal(parseModelRef(undefined), null);
	assert.equal(parseModelRef(""), null);
	assert.throws(() => parseModelRef("noslash"), /provider\/id/);
});

test("create → list → get → update → disable → cancel 全链路", async () => {
	const created = await invoke({
		action: "create",
		name: "工具冒烟",
		prompt: "reply OK",
		trigger: "interval",
		every: "1h",
		permission: "read_only",
	});
	assert.match(created.content[0].text, /已创建定时任务/);
	const job = created.details.job;
	assert.equal(job.permission, "read_only");
	assert.ok(job.nextRunAt);

	const listed = await invoke({ action: "list" });
	assert.match(listed.content[0].text, /工具冒烟/);

	const got = await invoke({ action: "get", id: job.id });
	assert.equal(got.details.job.id, job.id);

	const updated = await invoke({ action: "update", id: job.id, permission: "write", name: "改名了" });
	assert.equal(updated.details.job.permission, "write");
	assert.equal(updated.details.job.name, "改名了");

	const disabled = await invoke({ action: "disable", id: job.id });
	assert.equal(disabled.details.job.enabled, false);
	const enabled = await invoke({ action: "enable", id: job.id });
	assert.equal(enabled.details.job.enabled, true);

	const status = await invoke({ action: "status" });
	assert.match(status.content[0].text, /数据目录/);

	const cancelled = await invoke({ action: "cancel", id: job.id });
	assert.match(cancelled.content[0].text, /已删除任务/);
	assert.equal(store.getJob(job.id), undefined);
});

test("create：非法 cron 被拒并返回可读错误", async () => {
	const result = await invoke({
		action: "create",
		name: "坏 cron",
		prompt: "x",
		trigger: "cron",
		cron: "99 0 * * *",
	});
	assert.match(result.content[0].text, /失败/);
	assert.match(result.content[0].text, /超出范围/);
});

test("create：缺 name/prompt 时明确报错", async () => {
	const result = await invoke({ action: "create", trigger: "manual", name: "只有名字" });
	assert.match(result.content[0].text, /需要 name 与 prompt/);
});

test("history：runId 不存在时报错；无历史时给出友好文案", async () => {
	const missing = await invoke({ action: "history", runId: "nope" });
	assert.match(missing.content[0].text, /执行记录不存在/);

	const created = await invoke({
		action: "create",
		name: "无历史",
		prompt: "x",
		trigger: "manual",
	});
	const empty = await invoke({ action: "history", id: created.details.job.id });
	assert.match(empty.content[0].text, /暂无执行历史/);
	await invoke({ action: "cancel", id: created.details.job.id });
});

test("run_now：模型不存在时得到 error 记录而非假成功", async () => {
	const created = await invoke({
		action: "create",
		name: "错模型",
		prompt: "x",
		trigger: "manual",
		model: "no-such-provider/no-such-model",
	});
	const job = created.details.job;
	const result = await invoke({ action: "run_now", id: job.id, waitMs: 60_000 });
	assert.match(result.content[0].text, /error/);
	assert.match(result.content[0].text, /模型不存在/);
	assert.equal(result.details.run.status, "error");
	await invoke({ action: "cancel", id: job.id });
});

test("未知 action / 缺 id 时提示清晰", async () => {
	const noId = await invoke({ action: "get" });
	assert.match(noId.content[0].text, /需要 id/);
	const ghost = await invoke({ action: "get", id: "deadbeef" });
	assert.match(ghost.content[0].text, /任务不存在/);
});
