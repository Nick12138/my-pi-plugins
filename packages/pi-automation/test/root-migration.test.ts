/**
 * 数据根改名（pi-schedule → pi-automation）的兼容单测。
 *
 * 这次更名把默认数据根从 `~/.pi/schedule` 挪到了 `~/.pi/automation`。用户的任务定义、
 * 执行历史、会话与 token 全在那个目录里，搬家失败就等于「面板上任务全没了」，
 * 所以搬家逻辑必须能被单独验证：搬什么、什么时候坚决不搬、搬不动时怎么降级。
 *
 * 另外两条 env 兼容：`PI_AUTOMATION_DIR` 优先，旧的 `PI_SCHEDULE_DIR` 仍然认（带一次告警）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const store = await import(pathToFileURL(join(import.meta.dirname, "..", "src", "store.ts")).href);

function makePiDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-automation-root-"));
}

/** 造一个「旧名时代」的数据根：有 jobs.json 和 token。 */
function seedLegacy(piDir: string, dirname: string): string {
	const root = join(piDir, ".pi", dirname);
	mkdirSync(join(root, "runs"), { recursive: true });
	writeFileSync(join(root, "jobs.json"), JSON.stringify({ version: 1, jobs: [] }));
	writeFileSync(join(root, "token"), "tok-legacy");
	return root;
}

test("搬家：旧根存在且新根不存在 → 整体挪走，内容一并跟过去", () => {
	const pi = makePiDir();
	const from = seedLegacy(pi, "schedule");
	const target = join(pi, ".pi", "automation");

	assert.equal(store.migrateLegacyRoot(from, target), "moved");
	assert.equal(existsSync(from), false, "旧目录不该留在原地");
	assert.equal(readFileSync(join(target, "token"), "utf8"), "tok-legacy");
	assert.equal(existsSync(join(target, "runs", "jobs.json")), false, "子目录结构保持原样");
	assert.equal(existsSync(join(target, "jobs.json")), true);
});

test("不搬：新旧根同时存在 → 谁也不碰，让调用方自己合并", () => {
	const pi = makePiDir();
	const from = seedLegacy(pi, "schedule");
	const target = seedLegacy(pi, "automation");
	writeFileSync(join(target, "token"), "tok-new");

	assert.equal(store.migrateLegacyRoot(from, target), "kept-both");
	assert.equal(readFileSync(join(target, "token"), "utf8"), "tok-new", "新根内容不能被旧的覆盖");
	assert.equal(existsSync(from), true, "旧根原样保留");
});

test("无事可做：只有新根 / 只有旧根名字对不上", () => {
	const pi = makePiDir();
	const target = seedLegacy(pi, "automation");
	assert.equal(store.migrateLegacyRoot(join(pi, ".pi", "schedule"), target), "nothing-to-move");
	// 同名（比如用户把 PI_AUTOMATION_DIR 指回旧目录）时绝不自己搬自己
	assert.equal(store.migrateLegacyRoot(target, target), "nothing-to-move");
});

test("无事可做：旧目录里没有 jobs.json 就不搬", () => {
	const pi = makePiDir();
	const from = join(pi, ".pi", "schedule");
	mkdirSync(from, { recursive: true });
	assert.equal(store.migrateLegacyRoot(from, join(pi, ".pi", "automation")), "nothing-to-move");
	assert.equal(existsSync(from), true, "没数据就原样留着，不制造意外");
});

test("并进空壳：Host 已钉下 token，旧目录带着任务数据", () => {
	const pi = makePiDir();
	const from = seedLegacy(pi, "schedule");
	const target = join(pi, ".pi", "automation");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "token"), "tok-stray");

	assert.equal(store.migrateLegacyRoot(from, target), "merged");
	assert.equal(existsSync(from), false, "并完要清掉空的旧目录");
	assert.equal(readFileSync(join(target, "token"), "utf8"), "tok-legacy", "token 以旧的那份为准");
	assert.equal(existsSync(join(target, "jobs.json")), true, "任务定义得跟着进来");
	assert.equal(existsSync(join(target, "runs")), true, "子目录一并进来");
});

test("搬家失败只降级不抛：目标父目录不可用时仍能返回结果", () => {
	const pi = makePiDir();
	const from = seedLegacy(pi, "schedule");
	// 在 `.pi` 下拿一个已存在的**文件**当父目录 → mkdirSync 必失败
	const blocker = join(pi, ".pi", "automation");
	writeFileSync(blocker, "i am a file, not a dir");
	// 走的是「两边都有」的分支：文件占位也算存在，坚决不动
	assert.equal(store.migrateLegacyRoot(from, blocker), "kept-both");
	assert.equal(readFileSync(blocker, "utf8"), "i am a file, not a dir");
});

test("env 兼容：新名优先，旧名仍然认", () => {
	const before = [process.env.PI_AUTOMATION_DIR, process.env.PI_SCHEDULE_DIR];
	try {
		const pi = makePiDir();
		process.env.PI_AUTOMATION_DIR = join(pi, "newer");
		process.env.PI_SCHEDULE_DIR = join(pi, "older");
		store.resetPathsCache();
		assert.equal(store.paths().root, join(pi, "newer"), "两个都在时认新名");

		delete process.env.PI_AUTOMATION_DIR;
		store.resetPathsCache();
		assert.equal(store.paths().root, join(pi, "older"), "只给旧名时仍然生效");
	} finally {
		const restore = (name: string, value: string | undefined) => {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		};
		restore("PI_AUTOMATION_DIR", before[0]);
		restore("PI_SCHEDULE_DIR", before[1]);
		store.resetPathsCache();
	}
});
