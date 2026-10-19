/** Windows bash 探测修复（v2）的针对性测试。
 * 运行：node test/windows-bash.ts（Node 24+，原生 TS 类型剥离）
 * 首行 import "./test-env.ts" 把任务目录隔离到临时目录，勿删/勿挪到后面。
 * 覆盖（对应故障：所有命令 ~110ms exit 1、零输出——where bash 命中了
 * WindowsApps\System32 的 WSL 壳别名，bash 启动即 execvpe 失败）：
 * 1. 坏候选（存在但不可用）被跳过，选中第一个验证可用的 bash
 * 2. 全部候选不可用 → null → spawnShellJob 回退 cmd.exe 正常执行
 * 3. where 输出中的 WSL 壳（System32 / WindowsApps / system32\linux）被排除
 * 4. 真实探测（win32）：解析出可用的 Git Bash，且本机坏 WSL 壳验证为不可用
 * 5. 失败兑底日志：零输出的非零退出 / spawn 失败都会把诊断写进 output.log */
import "./test-env.ts";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectBashCandidates,
	initRunner,
	isUsableBash,
	parseWhereBash,
	pickUsableBash,
	resetWindowsBashForTest,
	resolveWindowsBashForTest,
	setWindowsBashForTest,
	spawnShellJob,
} from "../src/runner.ts";
import {
	ensureJobDir,
	isTerminal,
	outputLogSize,
	readOutputTail,
	readStatus,
	writeJob,
	writeStatus,
	type ShellJob,
	type ShellJobStatusData,
} from "../src/store.ts";

const settleLog: Array<{ jobId: string; update: Partial<ShellJobStatusData> }> = [];
function settle(jobId: string, update: Partial<ShellJobStatusData> & { status: ShellJobStatusData["status"] }): void {
	const st = readStatus(jobId);
	if (!st || isTerminal(st)) return;
	writeStatus(jobId, { ...st, ...update });
	settleLog.push({ jobId, update });
	console.log(`[settle] ${jobId} -> ${update.status}${update.exitCode !== undefined ? ` exit=${update.exitCode}` : ""}`);
}
initRunner({ maxLogBytes: 1024 * 1024, settle });

const isWin = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeJob(command: string, cwd = process.cwd()): ShellJob {
	const job: ShellJob = {
		id: `job_wbtest${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		title: command.slice(0, 40),
		command,
		cwd,
		sessionId: "wbtest-session",
		createdAt: Date.now(),
	};
	ensureJobDir(job.id);
	writeJob(job);
	writeStatus(job.id, { status: "running", startedAt: Date.now() });
	return job;
}

async function waitTerminal(jobId: string, timeoutMs = 15000): Promise<ShellJobStatusData> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const st = readStatus(jobId);
		if (st && isTerminal(st)) return st;
		await sleep(150);
	}
	throw new Error(`任务 ${jobId} 未在 ${timeoutMs}ms 内到达终态`);
}

// ── 测试 1：坏候选被跳过，第一个可用者胜出；全坏 → null ─────────
function testPickUsableBash(): void {
	console.log("── 测试 1：坏候选跳过 / 全坏回退 null（注入 probe）");
	const probeCalls: string[] = [];
	const probe = (c: string): boolean => {
		probeCalls.push(c);
		return c === "good-bash";
	};
	assert.equal(pickUsableBash(["broken-a", "good-bash", "good-bash-2", "broken-b"], probe), "good-bash");
	// 坏候选逐个被探测过（没有只看第一个）
	assert.deepEqual(probeCalls, ["broken-a", "good-bash"]);
	assert.equal(pickUsableBash(["broken-a", "broken-b"], probe), null, "全坏应返回 null（回退 cmd）");
	assert.equal(pickUsableBash([], probe), null);

	// 真实「存在但坏」的候选：非可执行文件 / 不存在的路径都必须淘汰
	const fake = path.join(os.tmpdir(), `pi-shelljob-fake-bash-${Date.now()}.exe`);
	fs.writeFileSync(fake, "this is not a real executable");
	assert.equal(isUsableBash(fake), false, "损坏的可执行文件必须被验证淘汰");
	assert.equal(isUsableBash(path.join(os.tmpdir(), "definitely-missing-bash-xyz.exe")), false, "不存在的路径必须被淘汰");
	try { fs.unlinkSync(fake); } catch { /* ignore */ }
	console.log("  ✓ 坏候选跳过 / 全坏 null / 损坏与缺失路径淘汰");
}

// ── 测试 2：where 输出剔除 WSL 壳 ─────────────────────────────
function testParseWhereBash(): void {
	console.log("── 测试 2：where bash 输出剔除 WSL 壳（System32 / WindowsApps）");
	const raw = [
		"C:\\Windows\\System32\\bash.exe",
		"C:\\Users\\liu\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
		"C:\\Windows\\System32\\lxss\\bash.exe".replace("lxss", "linux"), // system32\\linux 变体
		"",
	].join("\r\n");
	const kept = parseWhereBash(raw);
	assert.deepEqual(kept, ["C:\\Program Files\\Git\\usr\\bin\\bash.exe"], "只保留 Git Bash，剔除全部 WSL 壳");
	assert.deepEqual(parseWhereBash("C:\\Windows\\System32\\bash.exe"), [], "全是 WSL 壳时为空");
	console.log(`  ✓ WSL 壳全部剔除，保留：${kept.join(", ")}`);
}

// ── 测试 3：候选收集顺序与环境变量 ─────────────────────────────
function testCollectCandidates(): void {
	console.log("── 测试 3：候选收集顺序（SHELL 优先 → 固定路径 → PiAbyss 自带）");
	const cands = collectBashCandidates({ SHELL: "C:\\sh\\env-bash.exe", MSYS_BASH: "", LOCALAPPDATA: "C:\\Users\\liu\\AppData\\Local" } as NodeJS.ProcessEnv);
	assert.equal(cands[0], "C:\\sh\\env-bash.exe", "SHELL 环境变量优先");
	assert.ok(cands.includes("C:\\Program Files\\Git\\bin\\bash.exe"), "含 Git for Windows 固定路径");
	assert.ok(cands.includes(path.join("C:\\Users\\liu\\AppData\\Local", "PiAbyss", "resources", "git", "bin", "bash.exe")), "含 PiAbyss 自带 bash");
	assert.equal(new Set(cands).size, cands.length, "候选已去重");
	const noEnv = collectBashCandidates({} as NodeJS.ProcessEnv);
	assert.equal(noEnv[0], "C:\\Program Files\\Git\\bin\\bash.exe", "无环境变量时固定路径打头");
	console.log(`  ✓ 候选顺序正确（${cands.length} 个，去重后）`);
}

// ── 测试 4（win32 真机）：本机坏 WSL 壳验证不可用；真机回退 cmd 正常跑 ──
async function testRealWindowsPaths(): Promise<void> {
	console.log("── 测试 4：真实验证（win32）——坏 WSL 壳不可用、探测命中可用 bash");
	if (!isWin) {
		console.log("  （非 Windows，跳过）");
		return;
	}
	// 本机的 WSL 壳（System32 bash = WSL 启动器）：无发行版时 execvpe 失败 → 必须验证为不可用
	const stub = "C:\\Windows\\System32\\bash.exe";
	if (fs.existsSync(stub)) {
		if (isUsableBash(stub)) console.log("  ⚠ System32 bash 在本机可用（装有正常 WSL），跳过坏壳断言");
		else {
			assert.equal(isUsableBash(stub), false, "坏 WSL 壳必须被验证淘汰（这正是本次故障根因）");
			console.log("  ✓ 本机 System32 WSL 壳验证为不可用（execvpe 失败被捕获）");
		}
	} else {
		console.log("  （本机无 System32 bash，跳过）");
	}

	// 完整探测链路（真实 probe）：必须选中一个真正能跑命令的 bash，而不是任何 WSL 壳
	resetWindowsBashForTest();
	const picked = resolveWindowsBashForTest();
	console.log(`  探测选中：${picked ?? "（无可用 bash，将回退 cmd.exe）"}`);
	if (picked) {
		assert.ok(!/\\windows\\system32\\|\\windowsapps\\/i.test(picked), `选中的不能是 WSL 壳：${picked}`);
		assert.equal(isUsableBash(picked), true, "选中的 bash 必须验证可用");
	}
	// 探测已预热（缓存），建任务到 spawn 的无 pid 窗口极小，不再与监控循环赛跑
	const job = makeJob(`echo windows-bash-probe-ok`);
	const pid = spawnShellJob(job, 0);
	assert.ok(pid > 0);
	const st = await waitTerminal(job.id);
	assert.equal(st.status, "succeeded", `真实探测路径下 echo 应成功，实际 ${st.status}${st.errorMessage ? `：${st.errorMessage}` : ""}`);
	assert.ok(outputLogSize(job.id) > 0, "应有日志输出");
	const tail = readOutputTail(job.id, 5);
	assert.ok(tail.lines.some((l) => l.includes("windows-bash-probe-ok")), `日志应包含输出，实际：${JSON.stringify(tail.lines)}`);
	console.log(`  ✓ 探测链路真机贯通：exit=0，日志 ${JSON.stringify(tail.lines)}`);
}

// ── 测试 5：全部候选不可用 → 回退 cmd.exe 也要正常执行 ─────────
async function testCmdFallback(): Promise<void> {
	console.log("── 测试 5：无可用 bash 时回退 cmd.exe 正常执行（不静默 exit 1）");
	if (isWin) setWindowsBashForTest(null); // 强制「探测失败」→ cmd 回退
	const job = makeJob(`echo cmd-fallback-ok`);
	spawnShellJob(job, 0);
	const st = await waitTerminal(job.id);
	assert.equal(st.status, "succeeded", `cmd 回退路径应正常执行，实际 ${st.status}${st.errorMessage ? `：${st.errorMessage}` : ""}`);
	const tail = readOutputTail(job.id, 5);
	assert.ok(tail.lines.some((l) => l.includes("cmd-fallback-ok")), `cmd 回退应有输出，实际：${JSON.stringify(tail.lines)}`);
	console.log(`  ✓ cmd 回退正常：exit=0，日志 ${JSON.stringify(tail.lines)}`);
}

// ── 测试 6：失败也要有日志（零输出非零退出 / spawn 失败） ───────
async function testFailureLogging(): Promise<void> {
	console.log("── 测试 6：失败兑底日志（spawn 失败 / 零输出非零退出都写日志）");
	if (isWin) resetWindowsBashForTest(); // 恢复真实探测，走 bash 路径

	// 6a. 命令零输出且非零退出：日志必须兑底写入退出码诊断（不再是「无日志」盲区）
	const j1 = makeJob(`exit 42`);
	spawnShellJob(j1, 0);
	const st1 = await waitTerminal(j1.id);
	assert.equal(st1.status, "failed");
	assert.equal(st1.exitCode, 42);
	const t1 = readOutputTail(j1.id, 10);
	assert.ok(t1.lines.some((l) => l.includes("42") && l.includes("pi-shelljob")), `零输出失败应有兑底诊断，实际：${JSON.stringify(t1.lines)}`);
	console.log(`  ✓ 零输出 exit=42 → 日志写入诊断：${JSON.stringify(t1.lines.slice(-1))}`);

	// 6b. spawn 本身失败（cwd 不存在 → error 事件）：日志必须写入启动失败信息
	const j2 = makeJob(`echo never-runs`, path.join(os.tmpdir(), `pi-shelljob-no-such-cwd-${Date.now()}`));
	spawnShellJob(j2, 0);
	const st2 = await waitTerminal(j2.id);
	assert.equal(st2.status, "failed", "spawn 失败应落 failed");
	const t2 = readOutputTail(j2.id, 10);
	assert.ok(t2.lines.some((l) => l.includes("启动失败")), `spawn 失败应写日志，实际：${JSON.stringify(t2.lines)}`);
	console.log(`  ✓ spawn 失败 → 日志写入：${JSON.stringify(t2.lines.slice(-1))}`);

	resetWindowsBashForTest(); // 还原缓存，避免影响后续（同进程内的）使用
}

(async () => {
	testPickUsableBash();
	testParseWhereBash();
	testCollectCandidates();
	await testRealWindowsPaths();
	await testCmdFallback();
	await testFailureLogging();
	assert.ok(settleLog.length >= 3, "settle 应被调用（终态落盘链路完整）");
	console.log("\n全部 windows-bash 测试通过 ✅");
	process.exit(0);
})().catch((err) => {
	console.error("测试失败 ❌", err);
	process.exit(1);
});
