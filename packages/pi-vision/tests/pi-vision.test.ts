import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const listeners = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
const notices: Array<{ message: string; level?: string }> = [];
let activeTools: string[] = ["read", "bash", "see_image", "see_images", "see_job"];
const pi = {
	registerTool(definition: Tool) {
		tools.set(definition.name, definition);
	},
	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
		commands.set(name, options);
	},
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
		const list = listeners.get(event) ?? [];
		list.push(handler);
		listeners.set(event, list);
	},
	getActiveTools: () => [...activeTools],
	setActiveTools: (names: string[]) => {
		activeTools = [...names];
	},
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
const emptyPath = join(cwd, "empty.png");
writeFileSync(emptyPath, Buffer.alloc(0));
const docPath = join(cwd, "notes.md");
writeFileSync(docPath, "# hello");
const upperPath = join(cwd, "SHOT.PNG");
writeFileSync(upperPath, png);

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
equal(readFail.details?.reason, "not_found", "missing file reports not_found reason");
assert(textOf(readFail).includes("第 2 张"), "error names the failing image");
assert(textOf(readFail).includes("传入:"), "error shows the input path");
assert(textOf(readFail).includes("解析:"), "error shows the resolved path");
assert(textOf(readFail).includes("cwd:"), "error shows the cwd");

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
equal(singleFail.details?.reason, "not_found", "see_image reports not_found");

// ── loadImage 分类错误 ─────────────────────────────────────────────

// 目录
const dirFail = await seeImage.execute("c7", { image: cwd, prompt: "p" }, undefined, undefined, ctx);
equal(dirFail.details?.reason, "is_directory", "directory rejected as is_directory");
assert(textOf(dirFail).includes("目录"), "directory error explains it is a directory");

// 非图片扩展名
const docFail = await seeImage.execute("c8", { image: docPath, prompt: "p" }, undefined, undefined, ctx);
equal(docFail.details?.reason, "unsupported_format", "non-image extension rejected");
assert(textOf(docFail).includes("anytomd"), "non-image error points at anytomd");

// 空文件
const emptyFail = await seeImage.execute("c9", { image: emptyPath, prompt: "p" }, undefined, undefined, ctx);
equal(emptyFail.details?.reason, "empty_file", "empty file rejected");

// 空路径
const blankFail = await seeImage.execute("c10", { image: "   ", prompt: "p" }, undefined, undefined, ctx);
equal(blankFail.details?.reason, "empty_ref", "blank image ref rejected");

// http(s) 链接
const urlFail = await seeImage.execute("c11", { image: "https://x/y.png", prompt: "p" }, undefined, undefined, ctx);
equal(urlFail.details?.reason, "unsupported_url", "http url rejected as unsupported_url");

// 大小写不敏感的扩展名仍按图片接受（后续在模型循环里全失败，而不是读图失败）
const upperRes = await seeImage.execute("c12", { image: upperPath, prompt: "p" }, undefined, undefined, ctx);
equal(upperRes.details?.error, "all_failed", "uppercase .PNG still treated as an image");

// Windows 风格跨盘路径（../.. 会被词法吸收）：诊断里必须出现解析结果
const cwdDrive = cwd.slice(0, 2); // 例如 "C:"
const crossed = await seeImage.execute(
	"c13",
	{ image: `${cwdDrive}${cwd.slice(2)}\\..\\..\\Users\\liu\\AppData\\shot.png`, prompt: "p" },
	undefined,
	undefined,
	ctx,
);
equal(crossed.details?.reason, "not_found", "cross-drive-ish path reports not_found");
assert(textOf(crossed).includes("解析:"), "crossed path diagnostics include resolved path");
assert(textOf(crossed).includes("归一:"), "crossed path diagnostics expose the normalized (collapsed) path");

// http(s) 链接的诊断不得对 URL 做路径归一化
const urlDiag = textOf(urlFail);
assert(!urlDiag.includes("归一:"), "url diagnostics skip path normalization");
assert(urlDiag.includes("cwd:"), "url diagnostics include cwd");

// 体积上限：PI_VISION_MAX_IMAGE_MB 运行时生效
process.env.PI_VISION_MAX_IMAGE_MB = "0.000001";
const tooLarge = await seeImage.execute("c14", { image: imagePath, prompt: "p" }, undefined, undefined, ctx);
equal(tooLarge.details?.reason, "too_large", "oversized image rejected by PI_VISION_MAX_IMAGE_MB");
assert(textOf(tooLarge).includes("PI_VISION_MAX_IMAGE_MB"), "too_large error mentions the env var");
delete process.env.PI_VISION_MAX_IMAGE_MB;

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
assert(textOf(badImageJob).includes("原因: 文件不存在"), "failed job error carries the diagnostic reason");
const badJobId = (badImageJob.details as { jobIds: string[] }).jobIds[0];
const badJobStatus = await seeJob.execute("j4b", { action: "status", id: badJobId }, undefined, undefined, ctx);
assert(textOf(badJobStatus).includes("原因: 文件不存在"), "job status surfaces the diagnostic reason");
assert(textOf(badJobStatus).includes("解析:"), "job status surfaces the resolved path");
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

const { __piVisionTestUtils } = (await import("../extensions/pi-vision.ts")) as unknown as {
	__piVisionTestUtils: {
		isVisionUnsupportedError: (m: string) => boolean;
		getCachedCapability: (m: { provider: string; id: string }) => { supports: boolean; reason: string } | undefined;
		setCachedCapability: (m: { provider: string; id: string }, supports: boolean, reason: string) => void;
		resolveActualVisionCapability: (ctx: unknown, m: unknown) => Promise<boolean>;
		modelSupportsVision: (m: { input?: string[] } | undefined) => boolean;
	};
};

// ── 模型实际能力门控：不信“配置声明的视觉能力” ──────────────────────
//
// 探针本身走 pi-ai 的真实 provider 调用（假 provider 进不去），所以这里只守住
// “门控不依赖声明、声明纯文本时不浪费探针、探针未回来前不误关工具”这些不变量；
// 探针的判定 / 缓存 / 错误分类在文件末尾用内部口单独测。

const fire = (event: string, context: unknown) => {
	for (const handler of listeners.get(event) ?? []) handler({}, context);
};
const selectModel = (id: string, input: string[]) => {
	fire("model_select", { ...ctx, model: { provider: "mock", id, input } });
};

// 模型未知 / 声明纯文本 → 工具保持开启（等同于“不能看图”）
activeTools = ["read", "bash"];
fire("model_select", { ...ctx, model: undefined });
for (const name of ["see_image", "see_images", "see_job"]) {
	assert(activeTools.includes(name), `${name} active when the model is unknown`);
}
activeTools = ["read", "bash"];
selectModel("text-only", ["text"]);
for (const name of ["see_image", "see_images", "see_job"]) {
	assert(activeTools.includes(name), `${name} active for a text-only model`);
}
assert(activeTools.includes("read") && activeTools.includes("bash"), "unrelated tools preserved");

// 声明了 image（需要探针）→ 探针未完成前绝不先关工具
activeTools = ["read", "bash", "see_image", "see_images", "see_job"];
selectModel("declared-image", ["text", "image"]);
assert(activeTools.includes("see_image"), "tools stay active while the probe is still running");

// 模型自己能看图时，本轮系统提示里的 see_* 指引应被剔除（否则会促模型转交）
__piVisionTestUtils.setCachedCapability({ provider: "mock", id: "vision" }, true, "probe ok");
selectModel("vision", ["text", "image"]);
activeTools = ["read", "bash", "see_image", "see_images", "see_job"];
selectModel("vision", ["text", "image"]);
const promptCtx = { ...ctx, model: { provider: "mock", id: "vision", input: ["text", "image"] } };
const promptPayload = {
	systemPrompt: [
		"Before",
		"Guidelines:",
		"- use see_image to read screenshots",
		"- keep replies short",
		"After",
	].join('\n'),
	systemPromptOptions: {},
};
const patch = (await (listeners.get("before_agent_start") ?? [])[0]?.(promptPayload, promptCtx)) as
	| { systemPrompt?: string }
	| undefined;
assert(patch?.systemPrompt !== undefined, "system prompt patch returned for capable model");
assert(!patch.systemPrompt.includes("see_image"), "see_image guidance removed from system prompt");
assert(patch.systemPrompt.includes("keep replies short"), "unrelated guideline lines preserved");
assert(patch.systemPrompt.includes("Before") && patch.systemPrompt.includes("After"), "surrounding lines preserved");

// 模型不能看图时不动系统提示
fire("model_select", { ...ctx, model: undefined });
for (const handler of listeners.get("before_agent_start") ?? []) {
	const res = await handler({ systemPrompt: "调用 see_image 看图" }, ctx);
	assert(res === undefined, "system prompt untouched when the model cannot see images");
}

// 工具描述固定声明“本工具面向不能读图的模型”
const desc = (seeImage as unknown as { description: string }).description;
assert(desc.includes("适用对象"), "description states who the tool is for");

// 恢复初始状态
activeTools = ["read", "bash", "see_image", "see_images", "see_job"];
fire("model_select", { ...ctx, model: undefined });

// ── /vision 命令处理器（之前 registerCommand 是 stub，导致阻断 1 漏网）──

const cmdCtx = {
	...ctx,
	model: { provider: "mock", id: "text-only-model", input: ["text"] },
	ui: {
		setStatus() {},
		notify(message: string, level?: string) {
			notices.push({ message, level });
		},
	},
};
const visionCmd = commands.get("vision");
assert(visionCmd, "/vision command registered");

// 无参：必须不抛异常（回归：configSummary 曾引用闭包内变量 → ReferenceError）
notices.length = 0;
const summary = (await visionCmd.handler("", cmdCtx)) as string | undefined;
assert(summary === undefined || typeof summary === "string", "/vision with no args does not throw");
assert(notices.length === 1, "/vision reports the config summary");

// /vision tools（查询）
notices.length = 0;
await visionCmd.handler("tools", cmdCtx);
assert(notices[0]?.message.includes("覆盖设置"), "/vision tools prints the gate state");

// /vision tools on：总是开启，且不因模型能看图而关掉
notices.length = 0;
__piVisionTestUtils.setCachedCapability({ provider: "mock", id: "capable" }, true, "probe ok");
activeTools = ["read", "bash"];
await visionCmd.handler("tools on", { ...cmdCtx, model: { provider: "mock", id: "capable", input: ["text", "image"] } });
for (const name of ["see_image", "see_images", "see_job"]) {
	assert(activeTools.includes(name), `${name} force-enabled by /vision tools on`);
}
assert(notices[0]?.message.includes("总是开启"), "override on is acknowledged");

// /vision tools off：总是关闭
notices.length = 0;
activeTools = ["read", "bash", "see_image", "see_images", "see_job"];
await visionCmd.handler("tools off", cmdCtx);
for (const name of ["see_image", "see_images", "see_job"]) {
	assert(!activeTools.includes(name), `${name} force-disabled by /vision tools off`);
}
assert(notices[0]?.message.includes("总是关闭"), "override off is acknowledged");

// /vision tools auto：回到按实测能力（纯文本模型 → 工具开启）
notices.length = 0;
activeTools = ["read", "bash"];
await visionCmd.handler("tools auto", cmdCtx);
assert(activeTools.includes("see_image"), "override auto restores capability-based gating");
assert(notices[0]?.message.includes("auto"), "override auto is acknowledged");

// ── 门控核心分支：实测能看图 → 工具从活跃集移除 ─────────────────────

__piVisionTestUtils.setCachedCapability({ provider: "mock", id: "really-capable" }, true, "probe ok");
activeTools = ["read", "bash", "see_image", "see_images", "see_job"];
fire("model_select", { ...cmdCtx, model: { provider: "mock", id: "really-capable", input: ["text", "image"] } });
for (const name of ["see_image", "see_images", "see_job"]) {
	assert(!activeTools.includes(name), `${name} deactivated when the model really can see images`);
}
assert(activeTools.includes("read") && activeTools.includes("bash"), "unrelated tools kept");

// 已定论“不能看图”的模型 → 工具开启
__piVisionTestUtils.setCachedCapability({ provider: "mock", id: "really-blind" }, false, "does not support images");
activeTools = ["read", "bash"];
fire("model_select", { ...cmdCtx, model: { provider: "mock", id: "really-blind", input: ["text", "image"] } });
for (const name of ["see_image", "see_images", "see_job"]) {
	assert(activeTools.includes(name), `${name} active for a model probed as blind`);
}

// ── 竞态：旧探针结果不得覆盖新模型决策（注入可控探针）──────────────────

__piVisionTestUtils.setProbeOverride(async () => {
	await sleep(150);
	return { supports: true, definitive: true, reason: "probe says capable" };
});
activeTools = ["read", "bash", "see_image", "see_images", "see_job"];
// A：声明 image、无缓存 → 走慢路径，探针在途（150ms）
fire("model_select", { ...cmdCtx, model: { provider: "mock", id: "race-a", input: ["text", "image"] } });
// 立刻切到 B：纯文本模型（快路径，不探测）
fire("model_select", { ...cmdCtx, model: { provider: "mock", id: "race-b", input: ["text"] } });
assert(activeTools.includes("see_image"), "B decision applied while A probe is in flight");
await sleep(300);
assert(activeTools.includes("see_image"), "A's late 'capable' result must NOT disable tools for B");

// ── in-flight 去重：同一模型并发触发只发一次探针 ──────────────────────

let probeCount = 0;
__piVisionTestUtils.setProbeOverride(async () => {
	probeCount += 1;
	await sleep(120);
	return { supports: false, definitive: true, reason: "does not support images" };
});
const raceModel = { provider: "mock", id: "dedupe-model", input: ["text", "image"] };
const raceCtx = { ...cmdCtx, model: raceModel };
// 三个并发触发（模拟 session_start / model_select / /vision 同时打到同一模型）
await Promise.all([
	__piVisionTestUtils.resolveActualVisionCapability(raceCtx, raceModel),
	__piVisionTestUtils.resolveActualVisionCapability(raceCtx, raceModel),
	__piVisionTestUtils.resolveActualVisionCapability(raceCtx, raceModel),
]);
equal(probeCount, 1, "concurrent triggers share a single in-flight probe");

__piVisionTestUtils.setProbeOverride(undefined);

// ── 探针判定 / 缓存 / 错误分类（内部口）──────────────────────────────

// 错误分类：只有“provider 明说不吃图片”才算定论（可缓存），其它一律不定论
for (const sample of [
	"This model does not support images.",
	"image input is not supported by this model",
	"unsupported content type: image/png",
	"当前模型不支持图片输入",
]) {
	assert(__piVisionTestUtils.isVisionUnsupportedError(sample), `vision-unsupported classified: ${sample}`);
}
for (const sample of ["429 rate limited", "timeout of 20000ms exceeded", "connect ECONNREFUSED"]) {
	assert(!__piVisionTestUtils.isVisionUnsupportedError(sample), `transient error NOT cached as unsupported: ${sample}`);
}

// modelSupportsVision 只反映“声明”，不能当实际结论用
assert(__piVisionTestUtils.modelSupportsVision({ input: ["text", "image"] }), "declared image input detected");
assert(!__piVisionTestUtils.modelSupportsVision({ input: ["text"] }), "text-only declaration detected");
assert(!__piVisionTestUtils.modelSupportsVision(undefined), "unknown model is not vision-capable");

// 缓存：写盘 → 读回；命中缓存时不再发起探针
const capPath = join(cwd, "caps.json");
process.env.PI_VISION_CAPABILITY_FILE = capPath;
const fakeModel = { provider: "mock", id: "cap-model" };
__piVisionTestUtils.setCachedCapability(fakeModel, false, "does not support images");
assert(__piVisionTestUtils.getCachedCapability(fakeModel)?.supports === false, "cached capability read back");
assert(readFileSync(capPath, "utf-8").includes("cap-model"), "capability cache persisted to disk");
let authCalls = 0;
const cachedCtx = {
	...ctx,
	modelRegistry: {
		...ctx.modelRegistry,
		getApiKeyAndHeaders: async () => {
			authCalls += 1;
			return { ok: false as const, error: "should not be called" };
		},
	},
};
equal(
	await __piVisionTestUtils.resolveActualVisionCapability(cachedCtx, { ...fakeModel, input: ["text", "image"] }),
	false,
	"cached result wins over probing",
);
equal(authCalls, 0, "cache hit skips the probe entirely");

// 认证不可用 → 定不了论 → 保守返回 false（工具保持开启，不误关）
const noAuthCtx = {
	...ctx,
	modelRegistry: { ...ctx.modelRegistry, getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no key" }) },
};
equal(
	await __piVisionTestUtils.resolveActualVisionCapability(noAuthCtx, {
		provider: "mock",
		id: "no-answer",
		input: ["text", "image"],
	}),
	false,
	"unresolvable probe falls back to 'cannot see images'",
);

// 声明纯文本 → 不探测直接 false
equal(
	await __piVisionTestUtils.resolveActualVisionCapability(noAuthCtx, { provider: "mock", id: "t", input: ["text"] }),
	false,
	"text-only declaration resolves without a probe",
);
delete process.env.PI_VISION_CAPABILITY_FILE;

console.log("pi-vision extension tests passed");
