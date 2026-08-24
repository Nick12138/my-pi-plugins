/** 子进程 runner：spawn 独立的 pi 子进程（detached），stdout 事件流落盘 events.jsonl。 */
import { spawn, execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResultData, RunTask } from "./types.ts";
import { ensureRunDir, eventsPath, runDir, sessionDir, stderrPath } from "./store.ts";
import { channelDir } from "./supervisor-protocol.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

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

/** PATH 上是否有 pi 命令（agent CLI）。探测一次并缓存。 */
let piOnPath: boolean | null = null;
function hasPiCommand(): boolean {
	if (piOnPath !== null) return piOnPath;
	try {
		const res = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], {
			windowsHide: true,
			encoding: "utf8",
		});
		piOnPath = res.status === 0;
	} catch {
		piOnPath = false;
	}
	return piOnPath;
}

/** 定位包内 agent CLI（cli.js），作为 PATH 无 pi 时的兜底。 */
function resolveAgentCli(): string | undefined {
	const candidates: string[] = [];

	// 1) 当前模块的解析路径（插件随 pi-coding-agent 一起安装时生效）
	try {
		const require = createRequire(import.meta.url);
		candidates.push(require.resolve("@earendil-works/pi-coding-agent/dist/cli.js"));
	} catch {
		/* 插件以 repo 方式加载（node_modules 不在仓库内）时此处不可用，继续探测 */
	}

	// 2) 常见 host 安装位置：PiDeck pi-host/<hash>/node_modules（repo 加载插件时唯一可用来源）
	const piHostCandidates = [process.env.LOCALAPPDATA, process.env.APPDATA]
		.filter((d): d is string => !!d)
		.map((d) => path.join(d, "com.nick12138.pideck", "pi-host"));
	for (const root of piHostCandidates) {
		try {
			const dirs = fs
				.readdirSync(root, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort((a, b) => fs.statSync(path.join(root, b)).mtimeMs - fs.statSync(path.join(root, a)).mtimeMs);
			for (const dir of dirs) {
				const p = path.join(root, dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
				if (fs.existsSync(p)) {
					candidates.push(p);
					break;
				}
			}
		} catch {
			/* 目录不存在/不可读则跳过 */
		}
	}

	for (const c of candidates) {
		if (c && fs.existsSync(c)) return c;
	}
	return undefined;
}

/**
 * 解析出当前 pi 可执行文件的调用方式（Windows 兼容）。
 *
 * 注意：主进程可能是 Pi host 守护进程（如 PiDeck 的 pi-host/main.js），
 * 其入口脚本不解析 CLI 参数。只有确认当前入口是 agent CLI（cli.js）时
 * 才复用当前解释器；否则必须用 PATH 上的 pi（agent CLI）。
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const isAgentCli =
		!!currentScript &&
		!isBunVirtualScript &&
		fs.existsSync(currentScript) &&
		/^cli(\.(js|mjs|cjs))?$/i.test(path.basename(currentScript));
	if (isAgentCli) {
		// 运行在 node/bun cli.js 下：复用当前解释器，避免依赖 PATH 上的 pi
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		// 原生可执行（pi.exe 等）
		return { command: process.execPath, args };
	}
	// 解释器环境但入口不是 CLI（如 PiDeck host main.js）：优先 PATH 上的 pi
	if (hasPiCommand()) return { command: "pi", args };
	// 兜底：包内 cli.js
	const cli = resolveAgentCli();
	if (cli) return { command: process.execPath, args: [cli, ...args] };
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
	// 注入子代理侧 supervisor 客户端扩展（contact_supervisor 工具，见 supervisor-client.ts）
	const supervisorClient = path.join(MODULE_DIR, "supervisor-client.ts");
	if (fs.existsSync(supervisorClient)) args.push("--extension", supervisorClient);
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.projectTrusted === true) args.push("--approve");
	else args.push("--no-approve");

	// 角色 system prompt：直接指向 agents/*.md 文件
	const agentFile = path.join(MODULE_DIR, "..", "agents", `${task.agent}.md`);
	if (fs.existsSync(agentFile)) args.push("--append-system-prompt", agentFile);

	// 任务 prompt：写入 prompt.md，用 @file 传入（不依赖 stdin 生命周期，detached 安全）
	ensureRunDir(task.id);
	const promptFile = path.join(runDir(task.id), "prompt.md");
	const resumeNote =
		options.resume === true
			? `\n\n--- 恢复运行 ---\n你上次执行此任务时因以下原因中断：${options.lastError ?? "未知原因"}\n已完成的工作仍然有效，会话历史已保留。请先检查当前实际进度，只继续完成剩余部分（包括最终总结），不要重复已完成的工作。`
			: "";
	// 结果文件契约：要求子代理把最终总结写入固定文件，主代理优先读取（比解析事件流可靠）
	const finalOutputPath = path.join(runDir(task.id), "final-output.txt");
	fs.writeFileSync(
		promptFile,
		`Task: ${task.task}${resumeNote}\n\n完成后，把最终总结原样写入文件：${finalOutputPath}\n（用 write 或 bash 写入；文件内容应与你的最终回复一致）`,
		"utf-8",
	);
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
			// supervisor 文件信箱元数据（contact_supervisor 工具读取）
			PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR: channelDir(options.task.id, options.task.agent),
			PI_SUBAGENT_RUN_ID: options.task.id,
			PI_SUBAGENT_CHILD_AGENT: options.task.agent,
		},
	});
	// spawn 失败（命令不存在等）会 emit 'error'；若不处理，未捕获错误会崩溃主进程（Pi Host）。
	// 同时补一个假的 exit，让调度器的 exit 流程正常定终态，避免 run 卡在 running。
	proc.on("error", (err) => {
		try {
			fs.appendFileSync(stderrPath(options.task.id), `[spawn error] ${err.message}\n`);
		} catch {
			/* 写日志失败忽略 */
		}
		proc.emit("exit", undefined);
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
	// 结果文件契约：子代理按要求把最终总结写入 final-output.txt，优先读取（比解析事件流可靠）
	try {
		const finalOutputPath = path.join(runDir(runId), "final-output.txt");
		if (fs.existsSync(finalOutputPath)) {
			const fileOutput = fs.readFileSync(finalOutputPath, "utf-8").trim();
			if (fileOutput) result.output = fileOutput;
		}
	} catch {
		/* 文件读取失败则回退事件流解析 */
	}
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
					// 最后一条 assistant 文本 = 最终输出（仅当结果文件缺失/为空时兜底）
					for (const part of Array.isArray(msg.content) ? msg.content : []) {
						if (part?.type === "text" && part.text && !result.output) result.output = part.text;
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
