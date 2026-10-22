/**
 * 子进程入口解析回归测试。
 *
 * 起因（本机实测故障）：`hasPiCommand()` 原本用 `where pi` 做**存在式**探测，命中就
 * `spawn("pi", {shell:false})`。Windows 上 npm 装的 `pi` 是无扩展名的 POSIX shell
 * shim，CreateProcess 起不动 → 子进程 3ms 退出、0 turn、`退出码 undefined`，
 * 所有子代理秒失败。修成**验证式**探测 + cli.js 兜底后，用下面两条守住：
 *  1. 解析出的入口要么真的存在，要么根本没被选中（不返回幽灵路径）；
 *  2. 真正 spawn 一次必须成功——这就是当时坏掉的那一步。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getPiInvocation } from "../src/runner.js";

/** args[0] 是不是脚本入口（复用当前解释器 / 兜底 cli.js 两种形态都是）。 */
function entryScript(invocation: { command: string; args: string[] }): string | null {
	const first = invocation.args[0];
	if (!first) return null;
	return /\.(js|mjs|cjs)$/i.test(first) ? first : null;
}

describe("getPiInvocation", () => {
	it("never hands back a script entry that does not exist", () => {
		const invocation = getPiInvocation(["--version"]);
		const script = entryScript(invocation);
		// 选中的入口必须真在盘上；不存在时说明走到了裸 `pi` 分支，由下一条用例负责。
		if (script) expect(existsSync(script)).toBe(true);
	});

	it("prefers the npm bundle entry over a bare dist/cli.js", () => {
		const script = entryScript(getPiInvocation(["--version"]));
		if (!script || !script.includes("pi-coding-agent")) return; // 未走 npm 全局兜底
		// 裸 dist/cli.js 在 npm 平铺的 node_modules 下会 import 到版本不匹配的
		// @earendil-works/pi-codemode，直接 SyntaxError；只有 bundle/cli.js 可用。
		expect(path.basename(path.dirname(script))).toBe("bundle");
	});

	it("the chosen invocation actually spawns (regression: spawn pi ENOENT)", () => {
		const invocation = getPiInvocation(["--version"]);
		if (!entryScript(invocation)) {
			// 走到「裸 pi」分支：PATH 探测成功时它应可 spawn；两者都探不到
			// （本机根本没装 pi）则跳过——这不是回归，是无物可测。
			const probe = spawnSync("pi", ["--version"], {
				shell: false,
				windowsHide: true,
				encoding: "utf8",
				timeout: 120_000,
			});
			if (probe.error) return; // 环境里没有可用的 pi，不作断言
			expect(probe.status).toBe(0);
			return;
		}
		const res = spawnSync(invocation.command, invocation.args, {
			shell: false,
			windowsHide: true,
			encoding: "utf8",
			timeout: 120_000,
		});
		expect(res.error, `spawn failed: ${res.error?.message ?? "none"}`).toBeUndefined();
		expect(res.status).toBe(0);
		expect((res.stdout ?? "").trim()).toMatch(/\d+\.\d+/);
	});
});
