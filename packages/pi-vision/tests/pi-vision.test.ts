import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// see_job 的任务库目录必须在模块加载前通过环境变量覆盖到临时目录
// （vision-jobs.mjs 在模块级读取 PI_VISION_JOBS_DIR 并建目录）。
const jobsDir = mkdtempSync(join(tmpdir(), "pi-vision-jobs-test-"));
process.env.PI_VISION_JOBS_DIR = jobsDir;

const { default: extension } = await import("../extensions/pi-vision.ts");
const { createJob, readJob } = await import("../vision-jobs.mjs");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
	if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

type Tool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ type?: string; text?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	}>;
};

const tools = new Map<string, Tool>();
const pi = {
	registerTool(definition: Tool) {
		tools.set(definition.name, definition);
	},
	registerCommand() {},
	on() {},
};
extension(pi as never);

const seeImage = tools.get("see_image");
const seeImages = tools.get("see_images");
const seeJob = tools.get("see_job");
assert(seeImage, "see_image registered");
assert(seeImages, "see_images registered");
assert(seeJob, "see_job registered");

const cwd = mkdtempSync(join(tmpdir(), "pi-vision-test-"));
// 1x1 红色 PNG
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const imagePath = join(cwd, "red1.png");
const imagePath2 = join(cwd, "red2.png");
const imagePath3 = join(cwd, "red3.png");
for (const p of [imagePath, imagePath2, imagePath3]) writeFileSync(p, png);

const ctx = {
	cwd,
	modelRegistry: {
		getAll: () => [],
		find: () => undefined,
		getProviderAuthStatus: () => ({ configured: false }),
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no key" }),
		hasConfiguredAuth: () => false,
	},
	ui: { setStatus() {} },
};
const textOf = (r: { content: Array<{ type?: string; text?: string }> }) =>
	r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// see_images：空列表拒绝
const empty = await seeImages.execute("c1", { images: ["  "], prompt: "p" }, undefined, undefined, ctx);
equal(empty.details?.error, "empty_images", "empty images rejected");

// see_images：超出批量上限拒绝（env 运行时生效）
process.env.PI_VISION_MAX_BATCH = "2";
const tooMany = await seeImages.execute(
	"c2",
	{ images: [imagePath, imagePath2, imagePath3], prompt: "p" },
	undefined,
	undefined,
	ctx,
);
equal(tooMany.details?.error, "too_many_images", "too many images rejected");
equal(tooMany.details?.max, 2, "reported max comes from env");
delete process.env.PI_VISION_MAX_BATCH;

// see_images：任一图片读不了 → 整体失败并指出第几张
const badPath = join(cwd, "missing.png");
const readFail = await seeImages.execute(
	"c3",
	{ images: [imagePath, badPath], prompt: "p" },
	undefined,
	undefined,
	ctx,
);
equal(readFail.details?.error, "image_read_error", "unreadable image rejected");
equal(readFail.details?.index, 2, "reported failing image index");
assert(textOf(readFail).includes("第 2 张"), "error names the failing image");

// see_images：无已配置模型 → 全候选失败（不发起网络调用）
const allFailed = await seeImages.execute(
	"c4",
	{ images: [imagePath, imagePath2], prompt: "对比两张图" },
	undefined,
	undefined,
	ctx,
);
equal(allFailed.details?.error, "all_failed", "all candidates failed without configured models");
equal(allFailed.details?.imageCount, 2, "details carry imageCount");

// see_image：同样走共享回退循环（坏路径 → image_read_error）
const singleFail = await seeImage.execute("c5", { image: badPath, prompt: "p" }, undefined, undefined, ctx);
equal(singleFail.details?.error, "image_read_error", "see_image bad path rejected");

// 重复路径去重：同一张图传两次按一张处理（上限内，进入模型循环后全失败）
const deduped = await seeImages.execute(
	"c6",
	{ images: [imagePath, imagePath.trim()], prompt: "p" },
	undefined,
	undefined,
	ctx,
);
equal(deduped.details?.imageCount, 1, "duplicate paths deduplicated");

// ── see_job（异步任务队列）─────────────────────────────────────────

// submit：缺图 / 缺 prompt 直接拒绝
const noInput = await seeJob.execute("j1", { action: "submit" }, undefined, undefined, ctx);
equal(noInput.details?.error, "invalid_params", "submit without images rejected");
const noPrompt = await seeJob.execute("j2", { action: "submit", image: imagePath }, undefined, undefined, ctx);
equal(noPrompt.details?.error, "invalid_params", "submit without prompt rejected");

// 前置检查：任务未指定模型且默认路由没有可用视觉模型 → 拒绝提交
const noModel = await seeJob.execute(
	"j3",
	{ action: "submit", image: imagePath, prompt: "p" },
	undefined,
	undefined,
	ctx,
);
equal(noModel.details?.error, "no_vision_model", "submit preflight rejects when no usable vision model");

// 任务指定了模型但图片不存在 → 任务异步失败（wait=true 返回时已在终态）
const badImageJob = await seeJob.execute(
	"j4",
	{ action: "submit", wait: true, timeoutSec: 60, tasks: [{ image: badPath, prompt: "p", model: "mock/vision-x" }] },
	undefined,
	undefined,
	ctx,
);
assert(textOf(badImageJob).includes("无法读取第 1 张图片"), "failed job reports the unreadable image");
equal((badImageJob.details as { okCount?: number }).okCount, 0, "wait summary counts 0 successes");
equal((badImageJob.details as { total?: number }).total, 1, "wait summary counts 1 total");

// stale 检测：上个进程遗留的 running 任务（pid 不匹配）读出来应自动标记 failed
const stale = createJob({ images: [imagePath], prompt: "stale" });
const staleJobPath = join(stale.jobDir, "job.json");
const staleMeta = JSON.parse(readFileSync(staleJobPath, "utf-8"));
staleMeta.pid = 999999999;
staleMeta.status = "running";
writeFileSync(staleJobPath, JSON.stringify(staleMeta), "utf-8");
const staleRead = readJob(stale.jobId);
equal(staleRead.status, "failed", "stale running job from dead pid marked failed");
assert(String(staleRead.error).includes("stale"), "stale error mentions stale detection");

// cancel：运行中的任务（模型认证永远挂起，模拟长耗时调用）被取消 → cancelled
const hangCtx = {
	cwd,
	modelRegistry: {
		getAll: () => [{ provider: "mock", id: "vision-hang", input: ["image"] }],
		find: () => ({ provider: "mock", id: "vision-hang", input: ["image"] }),
		getProviderAuthStatus: () => ({ configured: true }),
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: () => new Promise(() => {}), // 永远挂起
		hasConfiguredAuth: () => true,
	},
	ui: { setStatus() {} },
};
const submitted = await seeJob.execute(
	"j5",
	{ action: "submit", image: imagePath, prompt: "analyze it" },
	undefined,
	undefined,
	hangCtx,
);
const runningJobId = (submitted.details as { jobIds: string[] }).jobIds[0];
assert(runningJobId.startsWith("seejob_"), "job id has seejob_ prefix");
process.env.PI_VISION_MAX_CONCURRENT = "1";
const queuedBehind = await seeJob.execute(
	"j5q",
	{ action: "submit", image: badPath, prompt: "queued failure", model: "mock/vision-x" },
	undefined,
	undefined,
	ctx,
);
const queuedJobId = (queuedBehind.details as { jobIds: string[] }).jobIds[0];
let queuedText = "";
const queuedStatus = await seeJob.execute("j5qs", { action: "status", id: queuedJobId }, undefined, undefined, ctx);
queuedText = textOf(queuedStatus);
assert(queuedText.includes("**queued**"), "second job waits in queue while concurrency is full");
let reachedRunning = false;
for (let i = 0; i < 25; i++) {
	const st = await seeJob.execute("j5s", { action: "status", id: runningJobId }, undefined, undefined, hangCtx);
	if (textOf(st).includes("**running**")) {
		reachedRunning = true;
		break;
	}
	await sleep(200);
}
assert(reachedRunning, "job reached running state within 5s");
const cancelled = await seeJob.execute("j5c", { action: "cancel", id: runningJobId }, undefined, undefined, hangCtx);
assert(textOf(cancelled).includes("取消"), "cancel acknowledged");
const waited = await seeJob.execute("j5w", { action: "wait", id: runningJobId, timeoutSec: 5 }, undefined, undefined, hangCtx);
equal((waited.details as { status?: string }).status, "cancelled", "wait returns cancelled terminal state");
const queuedWaited = await seeJob.execute("j5qw", { action: "wait", id: queuedJobId, timeoutSec: 5 }, undefined, undefined, ctx);
equal((queuedWaited.details as { status?: string }).status, "failed", "cancelling active job pumps queued work");
delete process.env.PI_VISION_MAX_CONCURRENT;

// 终态任务不可再取消
const cancelAgain = await seeJob.execute("j5c2", { action: "cancel", id: runningJobId }, undefined, undefined, hangCtx);
equal(cancelAgain.details?.error, "cancel_failed", "cancelling a terminal job fails");

// 非法任务 ID 不得访问任务库目录
assert(readJob("../job.json") === null, "path traversal job id rejected");

// status / wait / list 的缺 id 校验与空列表行为
const statusNoId = await seeJob.execute("j6", { action: "status" }, undefined, undefined, ctx);
equal(statusNoId.details?.error, "missing_id", "status without id rejected");
const unknown = await seeJob.execute("j7", { action: "status", id: "seejob_20990101_000000_zzzz" }, undefined, undefined, ctx);
equal(unknown.details?.error, "not_found", "status on unknown id returns not_found");

// list 能看到本测试期间落盘的任务
const listed = await seeJob.execute("j8", { action: "list", limit: 50 }, undefined, undefined, ctx);
assert(textOf(listed).includes("seejob_"), "list shows job ids");
assert(((listed.details as { count?: number }).count ?? 0) >= 3, "list count covers test jobs");

console.log("pi-vision extension tests passed");
