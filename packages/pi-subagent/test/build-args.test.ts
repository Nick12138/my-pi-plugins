/**
 * `buildPiArgs` 的模型参数回归测试（provider 撞车事故）。
 *
 * 起因（本机实测故障）：宿主把子代理模型拼成 `workbuddy/deepseek-v4.1-flash` 整体传给
 * `--model`，从不传 `--provider`。pi 的 `--model` 是**模糊匹配**，而 models.json 里
 * free 与 workbuddy 都有 `deepseek-v4.1-flash`，于是子代理静默落到 free（公网），
 * 主会话是 workbuddy（本地）。修法：`provider/id` 拆成 `--provider` + `--model` 分开传。
 * 另外响应里的模型可能被上游换掉，结果文案需要显式告警（modelMismatchWarning）。
 */
import { existsSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { buildPiArgs, type SpawnOptions } from "../src/runner.js";
import { modelMismatchWarning, splitProviderModel } from "../src/model-utils.js";
import { runDir } from "../src/store.js";
import type { RunTask } from "../src/types.js";

/** 测试用 run id 前缀：buildPiArgs 会往 ~/.pi/subagent/runs/<id>/ 写 prompt.md，用完清理。 */
const TEST_ID_PREFIX = "test-buildargs-";
const createdIds: string[] = [];

/** 按 src/types.ts 给全字段的 RunTask（buildPiArgs 只读 id/title/agent/task，其余按契约补全）。 */
function makeTask(id: string): RunTask {
	return {
		id,
		title: "测试任务",
		agent: "worker",
		task: "只回复 ok",
		cwd: process.cwd(),
		parentCwd: process.cwd(),
		worktree: false,
		retry: 0,
		createdAt: Date.now(),
	};
}

function makeOptions(model?: string, thinking?: string): SpawnOptions {
	const id = `${TEST_ID_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
	createdIds.push(id);
	return { task: makeTask(id), model, thinking, projectTrusted: true };
}

/** 取某个 flag 紧跟的值（不存在返回 undefined）。 */
function valueOf(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

afterAll(() => {
	for (const id of createdIds) {
		const dir = runDir(id);
		try {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 清理失败不影响断言结果 */
		}
	}
});

describe("buildPiArgs 模型参数", () => {
	it("把 provider/id 拆成 --provider + --model（回归：子代理落到 free）", () => {
		const args = buildPiArgs(makeOptions("workbuddy/deepseek-v4.1-flash"));
		expect(valueOf(args, "--provider")).toBe("workbuddy");
		expect(valueOf(args, "--model")).toBe("deepseek-v4.1-flash");
		// 整串不能再出现在参数里：模糊匹配正是靠它落到别的 provider
		expect(args).not.toContain("workbuddy/deepseek-v4.1-flash");
	});

	it("不含 / 的模型保持原行为，不传 --provider", () => {
		const args = buildPiArgs(makeOptions("sonnet"));
		expect(valueOf(args, "--model")).toBe("sonnet");
		expect(args).not.toContain("--provider");
	});

	it("多级路径按第一个 / 切：a/b/c → provider a + model b/c", () => {
		const args = buildPiArgs(makeOptions("a/b/c"));
		expect(valueOf(args, "--provider")).toBe("a");
		expect(valueOf(args, "--model")).toBe("b/c");
	});

	it("切分后任一半为空时退回只传 --model 原值", () => {
		for (const raw of ["/deepseek-v4.1-flash", "workbuddy/"]) {
			const args = buildPiArgs(makeOptions(raw));
			expect(valueOf(args, "--model")).toBe(raw);
			expect(args).not.toContain("--provider");
		}
	});

	it("thinking 仍单独用 --thinking 传，不吃 :suffix", () => {
		const args = buildPiArgs(makeOptions("workbuddy/deepseek-v4.1-flash:high", "low"));
		expect(valueOf(args, "--provider")).toBe("workbuddy");
		expect(valueOf(args, "--model")).toBe("deepseek-v4.1-flash:high");
		expect(valueOf(args, "--thinking")).toBe("low");
	});
});

describe("splitProviderModel", () => {
	it("拆 provider/id 并保留 :thinking 后缀在 id 上", () => {
		expect(splitProviderModel("workbuddy/deepseek-v4.1-flash")).toEqual({
			provider: "workbuddy",
			modelId: "deepseek-v4.1-flash",
		});
		expect(splitProviderModel("sonnet")).toBeUndefined();
		expect(splitProviderModel(undefined)).toBeUndefined();
		expect(splitProviderModel("a/")).toBeUndefined();
		expect(splitProviderModel("/b")).toBeUndefined();
	});
});

describe("modelMismatchWarning", () => {
	it("同 id 不同 provider 不告警", () => {
		expect(modelMismatchWarning("workbuddy/deepseek-v4.1-flash", "free/deepseek-v4.1-flash")).toBe("");
		expect(modelMismatchWarning("workbuddy/deepseek-v4.1-flash", "deepseek-v4.1-flash")).toBe("");
	});

	it("模型 id 不同要告警", () => {
		const msg = modelMismatchWarning("deepseek-v4.1-flash", "minimax-m3.1-flash");
		expect(msg).toBe("⚠️ 实际运行模型 minimax-m3.1-flash ≠ 要求 deepseek-v4.1-flash");
	});

	it("任一为空返回空串", () => {
		expect(modelMismatchWarning(undefined, "minimax-m3.1-flash")).toBe("");
		expect(modelMismatchWarning("deepseek-v4.1-flash", undefined)).toBe("");
		expect(modelMismatchWarning("", "")).toBe("");
	});

	it(":thinking 后缀不参与比对", () => {
		expect(modelMismatchWarning("sonnet:high", "sonnet")).toBe("");
	});
});
