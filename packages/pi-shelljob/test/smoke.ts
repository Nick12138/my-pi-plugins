/** 冒烟测试：直接驱动 store + runner，验证 后台运行/日志/kill/超时/正常退出 全链路。
 * 运行：node test/smoke.ts（Node 24+，原生 TS 类型剥离） */
import assert from "node:assert";
import * as fs from "node:fs";
import { spawnShellJob, killShellJob, initRunner } from "../src/runner.ts";
import {
	readStatus,
	readOutputTail,
	outputLogSize,
	loadJobRecord,
	writeJob,
	ensureJobDir,
	writeStatus,
	isTerminal,
	type ShellJob,
	type ShellJobStatusData,
} from "../src/store.ts";

const settleLog: Array<{ jobId: string; update: Partial<ShellJobStatusData> }> = [];

function settle(jobId: string, update: Partial<ShellJobStatusData> & { status: ShellJobStatusData["status"] }): void {
	const st = readStatus(jobId);
	if (!st || isTerminal(st)) return;
	const merged = { ...st, ...update };
	writeStatus(jobId, merged);
	settleLog.push({ jobId, update });
	console.log(`[settle] ${jobId} -> ${merged.status}${merged.exitCode !== undefined ? ` exit=${merged.exitCode}` : ""}${merged.timedOut ? " timedOut" : ""}`);
}

initRunner({ maxLogBytes: 1024 * 1024, settle });

function makeJob(command: string, timeoutMs?: number): ShellJob {
	const job: ShellJob = {
		id: `job_test${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		title: command.slice(0, 30),
		command,
		cwd: process.cwd(),
		...(timeoutMs ? { timeoutMs } : {}),
		sessionId: "test-session",
		createdAt: Date.now(),
	};
	ensureJobDir(job.id);
	writeJob(job);
	writeStatus(job.id, { status: "running", startedAt: Date.now() });
	return job;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testSuccessAndLog(): Promise<void> {
	console.log("── 测试 1：正常退出 + 日志捕获");
	const job = makeJob(`node -e "console.log('hello-shelljob')"`);
	const pid = spawnShellJob(job, 0);
	assert.ok(pid > 0, "应有有效 pid");
	await sleep(2500);
	const st = readStatus(job.id)!;
	assert.strictEqual(st.status, "succeeded", `应为 succeeded，实际 ${st.status}`);
	assert.strictEqual(st.exitCode, 0);
	assert.strictEqual(st.pid, pid);
	const out = readOutputTail(job.id, 10);
	assert.ok(out.lines.some((l) => l.includes("hello-shelljob")), `日志应包含输出，实际：${JSON.stringify(out)}`);
	console.log(`  ✓ exit=0，日志：${JSON.stringify(out.lines)}`);
}

async function testKillProcessTree(): Promise<void> {
	console.log("── 测试 2：进程树 kill（父进程 + 孤生子进程）");
	// 父 cmd 派生的 node 会持续向 marker 文件追加；若 /T 只杀 cmd 不杀孙进程，marker 会继续增长
	const marker = `D:/temp-treekill-${Date.now()}.txt`;
	const job = makeJob(
		`node -e "setInterval(function(){require('fs').appendFileSync('${marker}','x')},100)"`,
	);
	spawnShellJob(job, 0);
	await sleep(1500);
	let st = readStatus(job.id)!;
	assert.strictEqual(st.status, "running");
	const beforeSize = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
	assert.ok(beforeSize > 0, "孙进程应已在写 marker");
	const r = await killShellJob(job.id);
	assert.ok(r.ok, `kill 应成功：${r.error}`);
	await sleep(500);
	st = readStatus(job.id)!;
	assert.strictEqual(st.status, "killed", `应为 killed，实际 ${st.status}`);
	// 等 1s 后 marker 不再增长 = 整棵进程树（含孙进程）已死
	const sizeAfterKill = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
	await sleep(1200);
	const sizeLater = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
	assert.strictEqual(sizeLater, sizeAfterKill, `孙进程仍在写 marker（${sizeAfterKill} → ${sizeLater}），进程树未杀净`);
	try { fs.unlinkSync(marker); } catch {}
	console.log(`  ✓ killed，进程树已杀净（marker 冻结在 ${sizeAfterKill} 字节）`);
}

async function testTimeout(): Promise<void> {
	console.log("── 测试 3：单任务超时自动 kill");
	const job = makeJob(`node -e "setTimeout(()=>{},60000)"`, 1200);
	spawnShellJob(job, 1200);
	await sleep(3000);
	const st = readStatus(job.id)!;
	assert.strictEqual(st.status, "failed", `应为 failed，实际 ${st.status}`);
	assert.ok(st.timedOut, "应标记 timedOut");
	assert.strictEqual(st.exitCode, undefined);
	console.log("  ✓ failed + timedOut");
}

async function testNonZeroExit(): Promise<void> {
	console.log("── 测试 4：非零退出码 → failed");
	const job = makeJob(`node -e "process.exit(3)"`);
	spawnShellJob(job, 0);
	await sleep(2000);
	const st = readStatus(job.id)!;
	assert.strictEqual(st.status, "failed");
	assert.strictEqual(st.exitCode, 3);
	console.log("  ✓ exit=3 → failed");
}

async function testLogLimit(): Promise<void> {
	console.log("── 测试 5：日志超限保护性 kill");
	// 持续输出 64KB/50ms ≈ 1.3MB/s，maxLogBytes=100KB → 应被 enforceLogLimits kill
	const job = makeJob(`node -e "setInterval(()=>process.stdout.write('x'.repeat(65536)),50)"`);
	initRunner({ maxLogBytes: 100 * 1024, settle });
	spawnShellJob(job, 0);
	await sleep(2500); // ≈3MB 输出，远超上限
	const { enforceLogLimits } = await import("../src/runner.ts");
	enforceLogLimits();
	await sleep(1000);
	initRunner({ maxLogBytes: 1024 * 1024, settle });
	const st = readStatus(job.id)!;
	assert.strictEqual(st.status, "failed", `应为 failed（超限保护），实际 ${st.status}`);
	assert.match(st.errorMessage ?? "", /保护上限/);
	assert.ok(outputLogSize(job.id) > 0, "kill 前应已有日志写入");
	console.log(`  ✓ failed + ${st.errorMessage}`);
}

async function testRecordRouting(): Promise<void> {
	console.log("── 测试 6：落盘记录与通知路由数据完整性");
	const record = loadJobRecord(settleLog[0]!.jobId);
	assert.ok(record, "应能从磁盘读回完整记录");
	assert.strictEqual(record.job.sessionId, "test-session");
	assert.ok(record.status.finishedAt, "终态应有 finishedAt");
	console.log(`  ✓ job.json + status.json 完整（sessionId=${record.job.sessionId}）`);
}

async function testZombieTakeover(): Promise<void> {
	console.log("── 测试 7：僵尸任务接管（模拟宿主重启）");
	// 模拟重启前遗留的 running 任务：pid 指向一个已经退出的进程
	const job = makeJob(`node -e "setTimeout(function(){},60000)"`);
	const pid = spawnShellJob(job, 0);
	await sleep(300);
	// 亲手杀掉子进程但故意不动磁盘状态（等价于宿主崩溃时来不及落终态）
	await killShellJob(job.id); // 会先落 killed；手工改回 running + 旧 pid 模拟遗留
	writeStatus(job.id, { status: "running", pid, startedAt: Date.now() - 5000 });
	await sleep(300);
	assert.strictEqual(readStatus(job.id)!.status, "running");
	// 接管逻辑：pid 已死 → interrupted
	const { takeoverOrphans } = await import("../src/runner.ts");
	await takeoverOrphans();
	const st = readStatus(job.id)!;
	assert.strictEqual(st.status, "interrupted", `应为 interrupted，实际 ${st.status}`);
	console.log(`  ✓ ${st.status}：${st.errorMessage}`);
}

async function testNoPidTakeover(): Promise<void> {
	console.log("── 测试 8：无 pid 的僵尸任务接管（宿主崩在 spawn 前）");
	// 模拟宿主写完 running 状态后、spawn 之前崩溃：status=running 且无 pid，
	// 旧行为会被 takeoverOrphans 跳过导致永久 running，新行为应落 interrupted
	const job = makeJob(`node -e "setTimeout(function(){},60000)"`);
	writeStatus(job.id, { status: "running", startedAt: Date.now() }); // 不写 pid
	const { takeoverOrphans } = await import("../src/runner.ts");
	await takeoverOrphans();
	const st = readStatus(job.id)!;
	assert.strictEqual(st.status, "interrupted", `应为 interrupted，实际 ${st.status}`);
	console.log(`  ✓ ${st.status}：${st.errorMessage}`);
}


(async () => {
	await testSuccessAndLog();
	await testKillProcessTree();
	await testTimeout();
	await testNonZeroExit();
	await testLogLimit();
	await testRecordRouting();
	await testZombieTakeover();
	await testNoPidTakeover();
	console.log("\n全部冒烟测试通过 ✅");
	process.exit(0);
})().catch((err) => {
	console.error("测试失败 ❌", err);
	process.exit(1);
});
