/** 子进程 runner：spawn 独立的 pi 子进程（detached），stdout 事件流落盘 events.jsonl。 */
import { spawn, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResultData, RunTask } from "./types.ts";
import { ensureRunDir, eventsPath, runDir, sessionDir, stderrPath } from "./store.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface SpawnOptions {
	task: RunTask;
	/** 已解析的模型（provider/id），缺省不传 --model */
	model?: string;
	thinking?: string;
	/** 恢复运行：true = 同 session-id 续跑，prompt 用恢复模板 */
	resume?: boolean;
	/** 上次失败原因（恢复 prompt 里带上） */
	lastError?: string;
	/** 项目信任：--approve / --no-approve */
	projectTrusted?: boolean;
}

/** 解析出当前 pi 可执行文件的调用方式（Windows 兼容） */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		// 运行在 node/bun cli.js 下：复用当前解释器，避免依赖 PATH 上的 pi
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		// 原生可执行（pi.exe 等）
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** 构建子进程命令行参数 */
export function buildPiArgs(options: SpawnOptions): string[] {
	const { task } = options;
	const args: string[] = [
		"--mode", "json",
		"-p",
		"--session-id", `sub-${task.id}`,
		"--session-dir", sessionDir(task.id),
		"--name", task.title,
		"--exclude-tools", "subagent",
		"--no-context-files",
	];
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.projectTrusted === true) args.push("--approve");
	else args.push("--no-approve");

	// 角色 system prompt：直接指向 agents/*.md 文件
	const agentFile = path.join(EXTENSION_DIR, "..", "agents", `${task.agent}.md`);
	if (fs.existsSync(agentFile)) args.push("--append-system-prompt", agentFile);

	// 任务 prompt：写入 prompt.md，用 @file 传入（不依赖 stdin 生命周期，detached 安全）
	ensureRunDir(task.id);
	const promptFile = path.join(runDir(task.id), "prompt.md");
	const resumeNote =
		options.resume === true
			? `\n\n--- 恢复运行 ---\n你上次执行此任务时因以下原因中断：${options.lastError ?? "未知原因"}\n已完成的工作仍然有效，会话历史已保留。请先检查当前实际进度，只继续完成剩余部分（包括最终总结），不要重复已完成的工作。`
			: "";
	fs.writeFileSync(promptFile, `Task: ${task.task}${resumeNote}`, "utf-8");
	args.push(`@${promptFile}`);

	return args;
}

export interface ChildHandle {
	pid: number;
	proc: ReturnType<typeof spawn>;
}

/**
 * 启动子 pi 进程。
 * - detached: 新进程组，主 pi 退出不影响
 * - stdout → events.jsonl（原始 NDJSON 事件流，前端全部信息的来源）
 * - stderr → stderr.log
 */
export function spawnChild(options: SpawnOptions): ChildHandle {
	ensureRunDir(options.task.id);
	const invocation = getPiInvocation(buildPiArgs(options));
	const cwd = options.task.worktreePath ?? options.task.cwd;
	const outFd = fs.openSync(eventsPath(options.task.id), "a");
	const errFd = fs.openSync(stderrPath(options.task.id), "a");
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		detached: true,
		windowsHide: true,
		stdio: ["ignore", outFd, errFd],
		env: {
			...process.env,
			PI_SUBAGENT_DEPTH: "1",
		},
	});
	// 句柄由子进程持有，父进程这边立即释放
	fs.closeSync(outFd);
	fs.closeSync(errFd);
	// detached 子进程不阻止父进程退出
	proc.unref();
	return { pid: proc.pid!, proc };
}

/** Windows 上检查进程是否存活 */
export function isProcessAlive(pid: number): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, stdout) => {
			if (err) return resolve(false);
			resolve(/^\s*"[\w.]+".*,\s*"?\d+"?/m.test(stdout) && stdout.includes(`"${pid}"`));
		});
	});
}

/** 从 events.jsonl 解析最终结果 */
export function parseResult(runId: string, exitCode: number): RunResultData {
	const result: RunResultData = {
		output: "",
		usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
		finishedAt: Date.now(),
	};
	try {
		const raw = fs.readFileSync(eventsPath(runId), "utf-8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event?.type === "message_end" && event.message) {
				const msg = event.message;
				if (msg.role === "assistant") {
					result.usage.turns++;
					const u = msg.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						result.usage.contextTokens = u.totalTokens || 0;
					}
					if (msg.model && !result.model) result.model = msg.model;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					// 最后一条 assistant 文本 = 最终输出
					for (const part of Array.isArray(msg.content) ? msg.content : []) {
						if (part?.type === "text" && part.text) result.output = part.text;
					}
				}
			}
		}
	} catch {
		/* events 文件损坏时返回空结果 */
	}
	if (exitCode !== 0 && !result.errorMessage) {
		result.errorMessage = `子进程退出码 ${exitCode}`;
	}
	return result;
}
