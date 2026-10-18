/**
 * 控制面 token 解析单测：来源优先级 + 「落盘失败必须可见」。
 *
 * 回归的是线上那次鉴权死锁：插件把 token 留在内存、调用方只认 `<root>/token`，
 * 文件缺失时每个请求都 401 且没有任何日志。所以这里既测来源，也测告警有没有打出来。
 *
 * http.ts 的 token 缓存在模块级，每个用例都要带 `?v=` 重新导入一份；
 * paths() 的根目录缓存在 store.ts，靠 resetPathsCache() 清掉。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const BASE = mkdtempSync(join(tmpdir(), "pi-automation-token-"));
const srcDir = join(import.meta.dirname, "..", "src");
const store = await import(pathToFileURL(join(srcDir, "store.ts")).href);

let seq = 0;
async function freshHttp(): Promise<{ authTokenInfo(): { token: string; source: string } }> {
	seq += 1;
	store.resetPathsCache();
	return import(`${pathToFileURL(join(srcDir, "http.ts")).href}?v=${seq}`);
}

/** 在指定 PI_AUTOMATION_DIR 下跑用例；目录由调用方准备好（真实运行时是调度器建的）。 */
async function withRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
	const beforeToken = process.env.PI_AUTOMATION_TOKEN;
	const beforeDir = process.env.PI_AUTOMATION_DIR;
	delete process.env.PI_AUTOMATION_TOKEN;
	process.env.PI_AUTOMATION_DIR = root;
	try {
		return await run();
	} finally {
		if (beforeToken === undefined) delete process.env.PI_AUTOMATION_TOKEN;
		else process.env.PI_AUTOMATION_TOKEN = beforeToken;
		if (beforeDir === undefined) delete process.env.PI_AUTOMATION_DIR;
		else process.env.PI_AUTOMATION_DIR = beforeDir;
	}
}

async function captureConsoleError(run: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		await run();
	} finally {
		console.error = original;
	}
	return lines;
}

function rootDir(name: string): string {
	const dir = join(BASE, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("token：PI_AUTOMATION_TOKEN 优先，且此时完全不碰文件", async () => {
	const root = rootDir("env");
	await withRoot(root, async () => {
		process.env.PI_AUTOMATION_TOKEN = "env-token-123";
		const http = await freshHttp();
		assert.deepEqual(http.authTokenInfo(), { token: "env-token-123", source: "env" });
		assert.equal(existsSync(join(root, "token")), false, "env 已给定时不该落盘");
		// 幂等：第二次仍走缓存，值不变
		assert.equal(http.authTokenInfo().token, "env-token-123");
	});
});

test("token：无 env 时生成并写入 <root>/token，重启后沿用同一个值", async () => {
	const root = rootDir("writable");
	await withRoot(root, async () => {
		const info = (await freshHttp()).authTokenInfo();
		assert.equal(info.source, "file");
		assert.match(info.token, /^[0-9a-f]{48}$/);
		assert.equal(readFileSync(join(root, "token"), "utf8").trim(), info.token);

		// 新模块实例 = 进程重启：必须读回同一个 token，而不是换一个
		const again = (await freshHttp()).authTokenInfo();
		assert.deepEqual(again, { token: info.token, source: "file" });
	});
});

test("token：落盘失败退化为内存，但必须打告警并说清后果", async () => {
	// 把根目录的父级做成一个普通文件 → 写 <root>/token 必然失败
	const blocker = join(BASE, "blocker");
	writeFileSync(blocker, "not a directory");
	const root = join(blocker, "automation");
	const lines = await captureConsoleError(async () => {
		await withRoot(root, async () => {
			const http = await freshHttp();
			const info = http.authTokenInfo();
			assert.equal(info.source, "memory");
			assert.match(info.token, /^[0-9a-f]{48}$/);
			assert.equal(existsSync(join(root, "token")), false);
			// 同一进程内必须缓存住：每个请求换一个 token，调用方永远对不上
			assert.deepEqual(http.authTokenInfo(), info);
		});
	});
	assert.ok(
		lines.some((line) => line.includes("[pi-automation]") && line.includes("token 无法写入")),
		`落盘失败必须留一条告警，实际输出：${JSON.stringify(lines)}`,
	);
	assert.ok(lines.some((line) => line.includes("401")), "告警要说清后果（调用方会 401）");
});

after(() => {
	rmSync(BASE, { recursive: true, force: true });
});
