/**
 * 小精灵运行契约（`<pixie-context>` 块）的插件侧装配。
 *
 * v0.10 起这份契约由本插件注入。此前它挂在 Host 的 prompt 前导里
 * （桌面宿主 `pixie-agent-runner.ts` 的 `buildSegmentContextPreamble()`），
 * 只有从桌面端界面 / 控制面发消息才会带上
 * ——用户直接用裸 `pi` CLI 打开小精灵工作区时，模型拿不到任何委派契约。
 *
 * 契约文案与 Host 同源（措辞照搬），两处差异：
 * 1. 不再带 `[pixie|<source>]` 来源标记行——那行是 Host 投递信封时给自己用的，
 *    插件不投递信封，没有来源可标；
 * 2. 时间锚点在插件里现跑 `new Date()`（每段注入一次，见 buildHandoffCard）。
 *
 * 已知工作区列表优先读 Host 落盘的 `<agentDir>/pixie/context.json`（旧版
 * 宿主落盘在 `<agentDir>/piabyss/pixie/context.json`，作为遗留路径兜底）；
 * 没有这个文件（纯 CLI 场景）时按 Pi 的会话目录编码反推，取最近活跃的前 5 个。
 *
 * 全部只读、全部 best-effort：任何一步失败都退化成「少一行」，绝不抛出。
 */
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** 契约块的定界标签（前端按它对整卡做二次抽取，必须成对出现）。 */
export const PIXIE_CONTEXT_TAG = "pixie-context";

/** 会话目录扫描兜底时最多列出的工作区数。 */
const MAX_SCANNED_WORKSPACES = 5;

/** Pi 的 agentDir：`PI_CODING_AGENT_DIR` 优先，回退 `~/.pi/agent`。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return configured;
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || ".";
	return join(home, ".pi", "agent");
}

/**
 * 新会话段的时间锚点。卡片每段只注入一次（段可能开很久），所以这行写的是
 * 「本段开始」的时刻；不注入的话，模型会拿备忘录里的「周一」这类线索硬猜今天。
 *
 * 这行只是**锚点**，不承担「当前时间」——段开久了锚点就是旧的，所以措辞上把
 * 「今天 / 周几 / 是否逾期」一律指向现跑的 date（与 Host 的定义逐字一致）。
 */
export function pixieClockLine(now: Date): string {
	const date = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(now);
	const time = new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(now);
	const offsetHours = -now.getTimezoneOffset() / 60;
	const zone = `UTC${offsetHours < 0 ? "−" : "+"}${Math.abs(offsetHours)}`;
	return `本段开始时间：${date}（${weekday}）${time}，${zone}。这是段开始那一刻的锚点，段可能开很久；判断今天/周几/是否逾期，一律以现跑 date 为准，不要凭记忆推。`;
}

/** Host 落盘的已知工作区：`<agentDir>/pixie/context.json`（新）或
 * `<agentDir>/piabyss/pixie/context.json`（旧版宿主遗留路径，兜底）。 */
export function readContextWorkspaces(agentDir: string): string[] {
	const candidates = [join(agentDir, "pixie", "context.json"), join(agentDir, "piabyss", "pixie", "context.json")];
	for (const path of candidates) {
		const workspaces = readWorkspacesFile(path);
		if (workspaces !== null) return workspaces;
	}
	return [];
}

function readWorkspacesFile(path: string): string[] | null {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const list = (parsed as { workspaces?: unknown }).workspaces;
		if (!Array.isArray(list)) return [];
		return list
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.map((value) => value.trim());
	} catch {
		return null;
	}
}

/**
 * Pi 的会话目录名 → 工作区路径（兜底用）。
 *
 * 编码规则：路径里的 `\` `/` `:` 一律换成 `-`，两侧再各包一层 `-`，于是
 * `D:\我的项目\PiAbyss` → `--D--我的项目-PiAbyss--`。
 *
 * 反解不可能百分百准确（真实路径里的连字符与分隔符混在一起，`my-pi-plugins`
 * 这类名字无法区分），所以只当兜底；明显解析不了的脏形态（嵌套编码产生的
 * `---`、空组件、非盘符形态）一律丢弃，宁可少列一个工作区也不给错路径。
 */
export function decodeSessionDirName(name: string): string | null {
	if (!name.startsWith("--") || !name.endsWith("--") || name.length <= 5) return null;
	const inner = name.slice(2, -2);
	const match = /^([A-Za-z])--(.+)$/.exec(inner);
	if (!match) return null;
	const rest = match[2];
	// `--` 出现在盘符之后 = 空组件或嵌套编码（`--C--...-sessions---C--...--`），丢弃。
	if (rest.startsWith("-") || rest.endsWith("-") || rest.includes("--")) return null;
	const parts = rest.split("-");
	if (parts.some((part) => part.length === 0)) return null;
	return `${match[1].toUpperCase()}:\\${parts.join("\\")}`;
}

/** 目录内最新会话文件（文件名 ISO 时间戳优先，mtime 兜底）；没有会话返回 null。 */
function latestSession(dir: string): { file: string; at: number } | null {
	let files: string[];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return null;
	}
	let latest: { file: string; at: number } | null = null;
	for (const file of files) {
		let ms: number;
		const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file);
		if (m) {
			ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
		} else {
			try {
				ms = statSync(join(dir, file)).mtimeMs;
			} catch {
				continue;
			}
		}
		if (!Number.isFinite(ms)) continue;
		if (latest === null || ms > latest.at) latest = { file: join(dir, file), at: ms };
	}
	return latest;
}

/**
 * 从会话文件头部（第一行 session header）读该会话真实记录的 cwd。
 * 目录名编码是有损的（真实路径里的连字符还原不回来），header 里的 cwd 才是
 * 权威值；读不到（旧文件/被截断/无 cwd）返回 null，由调用方退回名字反解。
 */
function sessionHeaderCwd(file: string): string | null {
	try {
		const fd = openSync(file, "r");
	try {
			const buffer = Buffer.allocUnsafe(8192);
			const bytesRead = readSync(fd, buffer, 0, 8192, 0);
			const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
			const parsed = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
			if (parsed?.type !== "session") return null;
			const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
			// 只认绝对路径，别把相对串当工作区列出去。
			return /^([A-Za-z]:[\\/]|[\\/])/.test(cwd) ? cwd : null;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/**
 * 扫 `<agentDir>/sessions/` 子目录名反推工作区，按最新会话时间倒序取前 5 个。
 *
 * 路径优先取该目录最新会话 header 里的 cwd（权威），读不到才用目录名反解。
 */
export function scanSessionWorkspaces(agentDir: string): string[] {
	const sessionsDir = join(agentDir, "sessions");
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: Array<{ path: string; at: number }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(sessionsDir, entry.name);
		const latest = latestSession(dir);
		// 没有会话文件的目录（空壳、脏编码）不参与排序：反推不出「最近用过」。
		if (!latest) continue;
		const path = sessionHeaderCwd(latest.file) ?? decodeSessionDirName(entry.name);
		if (!path) continue;
		found.push({ path, at: latest.at });
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of found.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))) {
		const key = process.platform === "win32" ? item.path.toLowerCase() : item.path;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item.path);
		if (out.length >= MAX_SCANNED_WORKSPACES) break;
	}
	return out;
}

/**
 * 已知工作区：Host 落盘的 context.json 优先；缺失/解析失败/空数组时退回会话目录
 * 扫描（纯 CLI 场景没有 Host 推过来的列表）。全失败返回空数组。
 */
export function knownWorkspaces(agentDir: string = resolveAgentDir()): string[] {
	const fromContext = readContextWorkspaces(agentDir);
	if (fromContext.length > 0) {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const path of fromContext) {
			const key = process.platform === "win32" ? path.toLowerCase() : path;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(path);
		}
		return out;
	}
	try {
		return scanSessionWorkspaces(agentDir);
	} catch {
		return [];
	}
}

/**
 * 组装完整契约块（含 `<pixie-context>` 定界标签）。文案与桌面宿主同源，
 * 只有来源标记行与「界面里创建」这类归属措辞按插件侧实情微调。
 *
 * automation 的字段规范也住在这里：pi-automation 没有自己的注入通道，而计划是
 * 无人值守的重复执行，必须让模型每次都能看到「只读不写 + 草案格式」。
 */
export function buildPixieContextPreamble(agentDir: string = resolveAgentDir(), now: Date = new Date()): string {
	let workspaces: string[] = [];
	try {
		workspaces = knownWorkspaces(agentDir);
	} catch {
		workspaces = [];
	}
	const lines = [
		`<${PIXIE_CONTEXT_TAG}>`,
		pixieClockLine(now),
		"- 落点：默认只复用【你自己创建的】会话，没有就新开一个。用户自己创建的会话不要自动复用；只有用户明确给出会话 id 时才用 sessionId 参数指定——找不到会直接报错，不要改派到别的会话。",
		"- 排队：目标会话有活在跑时，新任务会排队并返回排队说明。不要重复派单，也不用自己数着等——对方回调时你会收到信封。",
		"- 回调：信封自带处理要求，照它办。三种各按规矩来：",
		"  - 完成：只转述、不代写总结。",
		"  - 报错：在「原样重试 / 调整委派词再派 / 如实报告」里选；同一任务连败 3 次就别再试，带全部现场升级给用户。",
		"  - 询问：立刻转述给用户、不要代答；用户的下一条消息就是答复。",
		"- 模型与推理深度：默认不传 model / thinkingLevel（跟随会话当前设置）。仅当用户在对话中明确指定（如「用 xxx 模型跑」「深度调到 high」）时才传，绝不主动更换。",
		"- 委派 cwd：必须来自下方已知工作区列表（或用户当前打开的工作区）；用户手动指令的优先级最高。",
		"- 自动化（`automation` 工具）：**只读不写**。可以 list / get / history / status 查现状与结果；create / update / cancel / enable / disable / run_now / reply 一律不许调用，落库由用户在确认卡上点「确认」完成，你只出草案、也不许声称已创建或已更新。",
		"  要改配置时，输出一个 ```automation-plan 代码块，内容为完整配置的 JSON（每次都写完整，未确定的字段写 null，用户没说的不要臆造）：",
		'  name: string；kind: "prompt" | "command"；prompt: string（command 型写 ""）；command: string | null；cwd: string 绝对路径；',
		'  trigger: { "type": "manual" } | { "type": "once", "at": "<ISO时间>" } | { "type": "interval", "every": "<数字><s|m|h|d|w|mo>" } | { "type": "cron", "cron": "<5段表达式>", "timezone"?: string }；',
		'  permission: "read_only" | "write" | "full"（仅 prompt 型有意义）；model: { "provider": string, "id": string } | null（null=宿主默认）；',
		'  missedWindow: "catch_up_one" | "skip"；timeoutMs: number（毫秒）；maxRuns: number | null；tags: string[]；notify: "none" | "system" | "tg"；',
		"  jobId: string | null（只有这份草案是改现有计划时才带上它的 id，新建一律不写）。",
	];
	if (workspaces.length > 0) {
		lines.push("已知的工作区：", ...workspaces.map((path) => `- ${path}`));
	}
	lines.push(`</${PIXIE_CONTEXT_TAG}>`);
	return lines.join("\n");
}
