import extension from "../extensions/pi-vision.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
assert(seeImage, "see_image registered");
assert(seeImages, "see_images registered");

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

console.log("pi-vision extension tests passed");
