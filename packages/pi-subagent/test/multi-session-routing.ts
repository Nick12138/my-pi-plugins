/**
 * 回归测试：多会话宿主（如 PiDeck 单进程多会话）下的通知路由与归属隔离。
 *
 * 复现原始 bug 场景：会话 A 活跃 → 会话 B 触发 session_start（旧实现会覆盖
 * 进程级 env/单例 notifier）→ A spawn 的 run 终态 → 通知必须回到 A，且
 * task.sessionId 归属 A、B 的实例不得收到任何投递。
 *
 * 运行：node --experimental-strip-types test/multi-session-routing.ts
 * 注意：会短暂使用真实 RUNS_ROOT（~/.pi/subagent/runs）下的 test_fix_* 临时
 * run，测试结束自动清理。要求磁盘上无 pending 状态的 run（restoreFromDisk
 * 会在首个 session_start 重建队列）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import subagentExtension from "../extensions/pi-subagent.ts";
import { ensureRunDir, loadAllRuns, writeStatus, writeTask } from "../src/store.ts";
import type { RunRecord, RunTask } from "../src/types.ts";

const NODE_SUPPORTS_TS = (() => {
	const [major] = process.versions.node.split(".").map(Number);
	return (major ?? 0) >= 22;
})();
if (!NODE_SUPPORTS_TS) {
	console.error("需要 node >= 22（--experimental-strip-types）");
	process.exit(1);
}

// ── 最小 ExtensionAPI mock ────────────────────────────────────

interface MockSession {
	id: string;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>;
	tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
	messages: Array<{ customType: string; details?: unknown }>;
}

function makeSession(id: string): MockSession {
	const session: MockSession = { id, handlers: new Map(), tools: [], messages: [] };
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
			const list = session.handlers.get(event) ?? [];
			list.push(handler);
			session.handlers.set(event, list);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			session.tools.push(tool);
		},
		registerCommand() {},
		getAllTools() {
			return session.tools.map((t) => ({ name: t.name }));
		},
		sendMessage(message: { customType: string; details?: unknown }) {
			session.messages.push({ customType: message.customType, details: message.details });
		},
	};
	(session as unknown as { pi: unknown }).pi = pi;
	return session;
}

async function fire(session: MockSession, event: string, payload: unknown, ctx: unknown): Promise<void> {
	for (const handler of session.handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

function ctxFor(session: MockSession) {
	return {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => session.id },
		isProjectTrusted: () => false,
		model: undefined,
		thinkingLevel: undefined,
	};
}

// ── 测试数据：真实 RUNS_ROOT 下的临时 run（结束清理）───────────

const TMP_RUN_A = "test_fix_route_a";
const TMP_RUN_B = "test_fix_route_b";

function makeRunRecord(runId: string, sessionId: string | undefined): RunRecord {
	const task: RunTask = {
		id: runId,
		title: `route-test-${runId}`,
		agent: "scout",
		task: "test",
		cwd: process.cwd(),
		worktree: false,
		retry: 0,
		sessionId,
		createdAt: Date.now(),
		parentCwd: process.cwd(),
	};
	return { task, status: { status: "failed", notified: false, resumeCount: 0, retryLeft: 0, operator: "system" } };
}

function cleanup(): void {
	for (const id of [TMP_RUN_A, TMP_RUN_B, "test_fix_route_orphan", "test_fix_route_wait"]) {
		fs.rmSync(path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "subagent", "runs", id), { recursive: true, force: true });
	}
}

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) {
		console.log(`  PASS  ${name}`);
	} else {
		failures += 1;
		console.error(`  FAIL  ${name}`);
	}
}

async function main(): Promise<void> {
	cleanup();

	// 宿主重启接管依赖磁盘无 pending run，否则 restoreFromDisk 会真实 spawn
	const pendingCount = loadAllRuns().filter((r) => r.status.status === "pending").length;
	if (pendingCount > 0) {
		console.error("磁盘上存在 pending 状态的 run，跳过测试避免真实 spawn");
		process.exit(1);
	}

	// 写入两个临时 run 的 task/status（路由测试的数据基础）
	for (const [id, sid] of [[TMP_RUN_A, "session-A"], [TMP_RUN_B, "session-B"]] as const) {
		ensureRunDir(id);
		writeTask(makeRunRecord(id, sid).task);
		writeStatus(id, { status: "failed", notified: false, resumeCount: 0, retryLeft: 0, operator: "system" });
	}

	// ── 模拟 PiDeck：同进程两个会话实例，B 在 A 之后 session_start ──
	const sessionA = makeSession("session-A");
	const sessionB = makeSession("session-B");
	subagentExtension((sessionA as unknown as { pi: never }).pi);
	subagentExtension((sessionB as unknown as { pi: never }).pi);

	await fire(sessionA, "session_start", { type: "session_start", reason: "startup" }, ctxFor(sessionA));
	await fire(sessionB, "session_start", { type: "session_start", reason: "startup" }, ctxFor(sessionB));
	// 给 Notifier 批量窗口/首轮 flush 留时间
	await new Promise((r) => setTimeout(r, 1500));

	// ── 核心 1：run 归属 A 的终态通知 → 只投给 A（旧实现会投给最后 session_start 的 B） ──
	const { routeSettledForTest } = await import("./route-hook.ts");
	routeSettledForTest(makeRunRecord(TMP_RUN_A, "session-A"));
	await new Promise((r) => setTimeout(r, 1500));

	const aNotified = sessionA.messages.some((m) => m.customType === "subagent-notify" && JSON.stringify(m.details ?? {}).includes(TMP_RUN_A));
	const bNotified = sessionB.messages.some((m) => m.customType === "subagent-notify" && JSON.stringify(m.details ?? {}).includes(TMP_RUN_A));
	check("A 发起的 run 通知送达会话 A", aNotified);
	check("A 发起的 run 通知不投给会话 B（原始 bug 的核心断言）", !bNotified);

	// ── 核心 2：run 归属 B → 只投给 B ──
	routeSettledForTest(makeRunRecord(TMP_RUN_B, "session-B"));
	await new Promise((r) => setTimeout(r, 1500));
	const bNotified2 = sessionB.messages.some((m) => m.customType === "subagent-notify" && JSON.stringify(m.details ?? {}).includes(TMP_RUN_B));
	const aNotified2 = sessionA.messages.some((m) => m.customType === "subagent-notify" && JSON.stringify(m.details ?? {}).includes(TMP_RUN_B));
	check("B 发起的 run 通知送达会话 B", bNotified2);
	check("B 发起的 run 通知不投给会话 A", !aNotified2);

	// ── 核心 4：subagent_wait(all) 只等本会话发起的 run（历史孤儿除外）──
	const waitId = "test_fix_route_wait";
	ensureRunDir(waitId);
	writeTask(makeRunRecord(waitId, "session-A").task);
	// pid 不存在：A 会话等待时会走僵尸兑底定 interrupted 并返回；
	// B 会话等待时 targets 过滤后为空，应直接返回“没有需要等待的 run”
	writeStatus(waitId, { status: "running", notified: false, resumeCount: 0, retryLeft: 0, operator: "agent", pid: 999998, startedAt: Date.now() });
	const waitToolB = sessionB.tools.find((t) => t.name === "subagent_wait");
	const waitToolA = sessionA.tools.find((t) => t.name === "subagent_wait");
	const waitText = (result: unknown): string => {
		const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
		return content.map((c) => c.text ?? "").join("\n");
	};
	const bWaitResult = await waitToolB?.execute("t", { all: true, timeoutMs: 3000 }, undefined, undefined);
	check("B 会话 wait(all) 看不到 A 发起的运行中 run", waitText(bWaitResult).includes("没有需要等待的 run"));
	const aWaitResult = await waitToolA?.execute("t", { all: true, timeoutMs: 10_000 }, undefined, undefined);
	check("A 会话 wait(all) 能等到自己发起的 run（僵尸兑底后返回）", !waitText(aWaitResult).includes("没有需要等待的 run"));

	// ── 核心 3：发起会话离线后的通知不唤醒其他会话 ──
	await fire(sessionA, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxFor(sessionA));
	const orphanId = "test_fix_route_orphan";
	ensureRunDir(orphanId);
	writeTask(makeRunRecord(orphanId, "session-A").task);
	writeStatus(orphanId, { status: "failed", notified: false, resumeCount: 0, retryLeft: 0, operator: "system" });
	routeSettledForTest(makeRunRecord(orphanId, "session-A"));
	await new Promise((r) => setTimeout(r, 300));
	const orphanNotifiedToB = sessionB.messages.some((m) => m.customType === "subagent-notify" && JSON.stringify(m.details ?? {}).includes(orphanId));
	check("离线会话的 run 通知不投给其他会话", !orphanNotifiedToB);

	cleanup();
	if (failures > 0) {
		console.error(`\n${failures} 个断言失败`);
		process.exit(1);
	}
	console.log("\n全部通过");
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	cleanup();
	process.exit(1);
});
