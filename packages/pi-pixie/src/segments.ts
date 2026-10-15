/**
 * 会话段（换段前后）的正文读取与文本装配。
 *
 * 事实前提：Pi 把每个会话段存成 <sessionDir>/<ISO>_<uuid>.jsonl，换段只是换了
 * 活动会话文件，上一段正文一直在盘上。这里不依赖 Host 的任何新端点：直接用
 * node:fs 读当前工作区会话目录里的兄弟会话。
 *
 * 段序口径：按【创建时间】新→旧（产品规则：创建时间最新的会话就是当前段）。
 * 创建时间取会话 header 的 `timestamp`，缺失时退回文件名里的 ISO 时间戳，
 * 两者都没有才用文件 mtime 兜底。
 *
 * 分工：
 * - listSegments()：目录里的历史段索引（新→旧，排除当前会话文件）。
 * - buildHandoffCard()：新段首轮注入的「段索引 + 上一段收尾」。
 * - recallSegmentsText()：pixie_recall 工具的主体（index/tail/search）。
 *
 * 只读；历史段取自当前会话目录，唯一可能越出目录的是 header.parentSession 明确
 * 指向的那个文件。正文渲染剔除工具噪声与本插件自己注入的条目。
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** 本插件注入的交接卡片的 customType（回读时过滤，避免自我复读）。 */
export const PIXIE_SEGMENT_CUSTOM_TYPE = "pixie-segments";

/** 单段最多读取的字节数（超出只读尾部，头部信息退回文件名）。 */
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
/** 索引默认列出的历史段数。 */
export const DEFAULT_INDEX_SEGMENTS = 8;
/** tail 模式默认返回的尾部消息条数。 */
const DEFAULT_TAIL_MESSAGES = 12;
/** search 模式默认返回的命中条数。 */
const DEFAULT_SEARCH_HITS = 8;
/** 单条消息渲染上限。 */
const MAX_MESSAGE_CHARS = 1200;
/** 单次工具输出总字符上限。 */
const MAX_OUTPUT_CHARS = 6000;
/** 交接卡片里「上一段收尾」的消息条数与字符上限。 */
const HANDOFF_TAIL_MESSAGES = 6;
const HANDOFF_TAIL_CHARS = 1600;

export type SegmentRole = "user" | "assistant" | "custom";

export type SegmentMessage = {
	role: SegmentRole;
	text: string;
	/** 条目 ISO 时间戳（渲染成 HH:MM，取不到则空）。 */
	at: string;
	/** 该条里的工具调用名（连续纯调用条目合并时用，正文里仍以〔调用 x〕标记呈现）。 */
	toolCalls?: string[];
};

export type SegmentRecord = {
	file: string;
	/** 会话 id（header.id，取不到退回文件名）。 */
	id: string;
	/** 会话显示名（最后一条 session_info），无名时为空串。 */
	name: string;
	/** 段创建时间（header.timestamp，ISO）。 */
	created: string;
	/** 文件修改时间（ms），排序用。 */
	modifiedMs: number;
	/** 渲染后的消息条数（已剔除工具噪声）。 */
	messageCount: number;
	/** 首条用户消息前缀，用于索引预览。 */
	preview: string;
	/** 渲染后的正文。 */
	messages: SegmentMessage[];
	/** 文件超限、只读了尾部时为 true。 */
	tailOnly: boolean;
};

export type RecallMode = "index" | "tail" | "search";

export type RecallResult = { ok: true; text: string } | { ok: false; error: string };

const ROLE_LABEL: Record<SegmentRole, string> = {
	user: "用户",
	assistant: "小精灵",
	custom: "注入",
};

/**
 * 从 execute/event 的 ctx 安全取会话目录或会话文件路径（拿不到返回 null，绝不抛出）。
 * Pi 的 ReadonlySessionManager 保证这两个方法存在；测试可注入假 ctx。
 */
export function sessionPathFromCtx(ctx: unknown, method: "getSessionDir" | "getSessionFile"): string | null {
	try {
		const manager = (ctx as { sessionManager?: Record<string, unknown> } | undefined)?.sessionManager;
		const value = (manager?.[method] as (() => unknown) | undefined)?.();
		return typeof value === "string" && value ? value : null;
	} catch {
		return null;
	}
}

/** 本段是否已经不需要再灌交接卡片（已有用户消息，或已注入过卡片）。 */
export function needsHandoffCard(ctx: unknown): boolean {
	try {
		const manager = (ctx as { sessionManager?: { getEntries?: () => unknown[] } } | undefined)?.sessionManager;
		const entries = manager?.getEntries?.();
		// 判定不了就不注入：宁可少一张卡片，也不能每一轮都灌一遍。
		if (!Array.isArray(entries)) return false;
		return !entries.some((entry) => {
			if (entry === null || typeof entry !== "object") return false;
			const record = entry as Record<string, unknown>;
			if (record.type === "custom_message" && String(record.customType ?? "").startsWith("pixie")) return true;
			if (record.type !== "message") return false;
			const message = record.message as Record<string, unknown> | undefined;
			if (message?.role === "user") return true;
			return message?.role === "custom" && String(message.customType ?? "").startsWith("pixie");
		});
	} catch {
		return false;
	}
}

/** 时间戳归一到分钟：`2026-10-15T13:40:00.123Z` → `10-15 13:40`；ISO 之外原样。 */
function formatStamp(iso: string | undefined): string {
	if (!iso) return "";
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
	return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : "";
}

function clip(text: string, max: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	if (one.length <= max) return one;
	return `${one.slice(0, max)}…`;
}

/** 大小写无关的路径比较键（Windows 上盘符/路径大小写不稳定）。 */
function pathKey(path: string): string {
	return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

/** 读取文件文本：超限只读尾部 MAX_SEGMENT_BYTES（对齐到第一个完整行）。 */
function readSessionText(file: string): { text: string; tailOnly: boolean } {
	let size = 0;
	try {
		size = statSync(file).size;
	} catch {
		return { text: "", tailOnly: false };
	}
	if (size === 0) return { text: "", tailOnly: false };
	if (size <= MAX_SEGMENT_BYTES) {
		try {
			return { text: readFileSync(file, "utf8"), tailOnly: false };
		} catch {
			return { text: "", tailOnly: false };
		}
	}
	const fd = openSync(file, "r");
	try {
		const start = size - MAX_SEGMENT_BYTES;
		const buffer = Buffer.allocUnsafe(MAX_SEGMENT_BYTES);
		const bytesRead = readSync(fd, buffer, 0, MAX_SEGMENT_BYTES, start);
		const chunk = buffer.subarray(0, bytesRead).toString("utf8");
		const newline = chunk.indexOf("\n");
		return { text: newline >= 0 ? chunk.slice(newline + 1) : chunk, tailOnly: true };
	} finally {
		closeSync(fd);
	}
}

type RawEntry = Record<string, unknown>;

function parseEntries(text: string): { header: RawEntry | null; entries: RawEntry[] } {
	let header: RawEntry | null = null;
	const entries: RawEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const record = parsed as RawEntry;
		if (record.type === "session" && header === null) header = record;
		else entries.push(record);
	}
	return { header, entries };
}

/** 把 message.content（字符串或内容块数组）拆成正文与工具调用名。 */
function extractParts(content: unknown): { text: string; toolCalls: string[] } {
	if (typeof content === "string") return { text: content, toolCalls: [] };
	if (!Array.isArray(content)) return { text: "", toolCalls: [] };
	const texts: string[] = [];
	const toolCalls: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
		else if (item.type === "toolCall" && typeof item.name === "string") toolCalls.push(item.name);
		else if (item.type === "image") texts.push(`〔图片 ${typeof item.mimeType === "string" ? item.mimeType : ""}〕`);
	}
	const marker = toolCalls.length > 0 ? `〔调用 ${toolCalls.join("、")}〕` : "";
	return { text: [...texts, marker].join(" ").trim(), toolCalls };
}

function segmentOf(entry: RawEntry): SegmentMessage | null {
	if (entry.type === "custom_message" || (entry.type === "message" && (entry.message as RawEntry | undefined)?.role === "custom")) {
		const source = entry.type === "custom_message" ? entry : (entry.message as RawEntry);
		const customType = typeof source.customType === "string" ? source.customType : "";
		// 本插件注入的索引卡片不回读，否则每段都会复述上一段看到的卡片。
		if (customType.startsWith("pixie")) return null;
		const parts = extractParts(source.content);
		const timestamp = String(entry.timestamp ?? "");
		return parts.text ? { role: "custom", text: parts.text, at: timestamp, toolCalls: parts.toolCalls } : null;
	}
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (message === null || typeof message !== "object") return null;
	const role = (message as RawEntry).role;
	const timestamp = String(entry.timestamp ?? (message as RawEntry).timestamp ?? "");
	if (role !== "user" && role !== "assistant") {
		// toolResult / bashExecution / branchSummary / compactionSummary 不进回读正文：
		// 前者是噪声，后者属于压缩产物，段级索引已经够用。
		return null;
	}
	const parts = extractParts((message as RawEntry).content);
	if (!parts.text) return null;
	return { role, text: parts.text, at: timestamp, toolCalls: parts.toolCalls };
}

/**
 * 合并连续「只有工具调用、没有正文」的条目：实测小精灵一段的收尾大半是这种行，
 * 逐条渲染会把交接卡片挤满噪声。调用名来自提取阶段的结构化字段，不在这里重解文本。
 */
function isToolOnly(message: SegmentMessage): boolean {
	if ((message.toolCalls?.length ?? 0) === 0) return false;
	// 合并后的条目带着「（共 N 次）」尾注，剥掉标记与尾注才算纯调用行。
	const stripped = message.text
		.replace(/〔调用[^〕]*〕/g, "")
		.replace(/（共 \d+ 次）/g, "")
		.trim();
	return stripped === "";
}

function labelRun(calls: string[]): string {
	const counts = new Map<string, number>();
	for (const name of calls) counts.set(name, (counts.get(name) ?? 0) + 1);
	const label = [...counts.entries()]
		.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
		.join("、");
	return calls.length > 1 ? `〔调用 ${label}〕（共 ${calls.length} 次）` : `〔调用 ${label}〕`;
}

function collapseToolRuns(messages: SegmentMessage[]): SegmentMessage[] {
	const out: SegmentMessage[] = [];
	for (const message of messages) {
		const last = out[out.length - 1];
		if (!last || !isToolOnly(message) || !isToolOnly(last) || last.role !== message.role) {
			out.push(message);
			continue;
		}
		const calls = [...(last.toolCalls ?? []), ...(message.toolCalls ?? [])];
		out[out.length - 1] = { role: message.role, text: labelRun(calls), at: last.at, toolCalls: calls };
	}
	return out;
}

function parseSegment(file: string, modifiedMs: number): SegmentRecord {
	const { text, tailOnly } = readSessionText(file);
	const { header, entries } = parseEntries(text);
	const collected: SegmentMessage[] = [];
	let name = "";
	for (const entry of entries) {
		if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
		const message = segmentOf(entry);
		if (message) collected.push(message);
	}
	const messages = collapseToolRuns(collected);
	const headerTimestamp = header && typeof header.timestamp === "string" ? header.timestamp : "";
	const fileNameStamp = fileNameTimestamp(file);
	return {
		file,
		id: header && typeof header.id === "string" ? header.id : basename(file).replace(/\.jsonl$/, ""),
		name,
		created: headerTimestamp || fileNameStamp,
		modifiedMs,
		messageCount: messages.length,
		preview: messages.find((message) => message.role === "user")?.text ?? messages[0]?.text ?? "",
		messages,
		tailOnly,
	};
}

/** 从 `<ISO-with-dashes>_<uuid>.jsonl` 文件名还原 ISO 时间（头部缺失时的兜底）。 */
function fileNameTimestamp(file: string): string {
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(basename(file));
	return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : "";
}

/** 文件名时间戳的毫秒值（预切片排序用；文件名不带 ISO 前缀时返回 null）。 */
function fileNameTimestampMs(file: string): number | null {
	const ms = Date.parse(fileNameTimestamp(file));
	return Number.isFinite(ms) ? ms : null;
}

/** 段的创建时间毫秒值：header/文件名 ISO 优先，mtime 兜底。 */
function segmentCreatedMs(segment: SegmentRecord): number {
	const ms = Date.parse(segment.created);
	return Number.isFinite(ms) ? ms : segment.modifiedMs;
}

function sameFile(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

/**
 * 列出目录里的历史段（按创建时间新→旧）。`currentFile` 命中时排除自身；
 * 只保留有可见消息的段——空的、坏掉的、以及正在写入的本段之外才算历史。
 * 预切片按便宜的stat信息排序（文件名 ISO 优先、mtime 兜底），解析后再按
 * header 的真实创建时间重排，保证老但相关的段不因 mtime 被提前丢弃。
 */
export function listSegments(input: {
	sessionDir: string;
	currentFile?: string | null;
	maxSegments?: number;
}): SegmentRecord[] {
	const dir = resolve(input.sessionDir);
	let files: string[];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const current = input.currentFile ? resolve(input.currentFile) : null;
	const max = Math.max(1, input.maxSegments ?? DEFAULT_INDEX_SEGMENTS);
	const candidates = files
		.map((name) => join(dir, name))
		.filter((file) => (current ? !sameFile(file, current) : true))
		.map((file) => {
			let modifiedMs = 0;
			try {
				modifiedMs = statSync(file).mtimeMs;
			} catch {
				modifiedMs = 0;
			}
			return { file, modifiedMs, createdMs: fileNameTimestampMs(file) ?? modifiedMs };
		})
		.sort((a, b) => b.createdMs - a.createdMs || b.file.localeCompare(a.file))
		.slice(0, max * 3)
		.map(({ file, modifiedMs }) => parseSegment(file, modifiedMs))
		.filter((segment) => segment.messageCount > 0)
		.sort((a, b) => segmentCreatedMs(b) - segmentCreatedMs(a) || a.file.localeCompare(b.file));
	return candidates.slice(0, max);
}

/**
 * 上一段指针 + 与之对齐的历史清单：优先 header.parentSession（Pi 原生 newSession
 * 会写），退回按创建时间最新的那个历史段。返回的 history 保证「上一段」就在
 * index 0——卡片里的序号、pixie_recall 省略 segment 时的默认落点，三者必须一致。
 */
export function previousSegment(input: {
	sessionDir: string;
	currentFile?: string | null;
	maxSegments?: number;
}): { previous: SegmentRecord | null; history: SegmentRecord[] } {
	const history = listSegments(input);
	const parent = input.currentFile ? parentSessionOf(input.currentFile) : null;
	if (!parent) return { previous: history[0] ?? null, history };
	const index = history.findIndex((segment) => sameFile(segment.file, parent));
	if (index === 0) return { previous: history[0] ?? null, history };
	if (index > 0) {
		const [hit] = history.splice(index, 1);
		return { previous: hit, history: [hit, ...history] };
	}
	const outside = parseSegment(resolve(parent), safeMtime(parent));
	if (outside.messageCount === 0) return { previous: history[0] ?? null, history };
	return { previous: outside, history: [outside, ...history] };
}

function parentSessionOf(file: string): string | null {
	try {
		const { text } = readSessionText(file);
		const { header } = parseEntries(text);
		return header && typeof header.parentSession === "string" ? header.parentSession : null;
	} catch {
		return null;
	}
}

function safeMtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function renderMessage(message: SegmentMessage, index: number): string {
	const stamp = formatStamp(message.at);
	const head = stamp ? `[${index + 1}] ${stamp} ${ROLE_LABEL[message.role]}` : `[${index + 1}] ${ROLE_LABEL[message.role]}`;
	return `${head}: ${clip(message.text, MAX_MESSAGE_CHARS)}`;
}

function renderSegmentHead(segment: SegmentRecord, ordinal: number): string {
	const title = segment.name || clip(segment.preview, 24) || "（未命名段）";
	const stamp = formatStamp(segment.created) || "时间未知";
	return `── 段 ${ordinal} · ${title} · ${stamp} · ${segment.messageCount} 条 · ${basename(segment.file)}`;
}

/** 索引行（一段一行，供注入卡片与 mode=index 复用）。 */
export function formatSegmentIndex(history: SegmentRecord[]): string {
	if (history.length === 0) return "（没有找到历史会话段）";
	return history
		.map((segment, index) => {
			const title = segment.name || clip(segment.preview, 24) || "（未命名段）";
			const stamp = formatStamp(segment.created) || "时间未知";
			return `${index}. ${title} · ${stamp} · ${segment.messageCount} 条`;
		})
		.join("\n");
}

/**
 * 新段首轮注入的交接卡片：段索引 + 上一段收尾。
 * 没有任何历史段时返回 null（首段/目录缺失，绝不注入空卡片）。
 */
export function buildHandoffCard(input: {
	sessionDir: string;
	currentFile?: string | null;
	currentName?: string | null;
	maxSegments?: number;
}): string | null {
	const { previous, history } = previousSegment({
		sessionDir: input.sessionDir,
		currentFile: input.currentFile,
		maxSegments: input.maxSegments ?? DEFAULT_INDEX_SEGMENTS,
	});
	if (!previous && history.length === 0) return null;
	const lines: string[] = [
		`<${PIXIE_SEGMENT_CUSTOM_TYPE}>`,
		"你在小精灵工作区开启了一个新的会话段。上一段并没有丢：正文都存在本机 Pi 会话目录里。",
		"要回看细节就调用 pixie_recall（segment 省略 = 上一段；mode=search 可按关键词找）。",
		"",
		`最近 ${history.length} 段（新→旧，序号即 pixie_recall 的 segment 参数，0 = 上一段）：`,
		formatSegmentIndex(history),
	];
	if (previous) {
		const tail = previous.messages.slice(-HANDOFF_TAIL_MESSAGES);
		const rendered: string[] = [];
		let used = 0;
		for (const message of tail) {
			const line = renderMessage(message, rendered.length);
			used += line.length;
			if (used > HANDOFF_TAIL_CHARS) break;
			rendered.push(line);
		}
		lines.push(
			"",
			`上一段（${previous.name || clip(previous.preview, 24) || "未命名"}）的收尾：`,
			...rendered,
		);
	}
	lines.push(`</${PIXIE_SEGMENT_CUSTOM_TYPE}>`);
	return lines.join("\n");
}

function locateSegment(history: SegmentRecord[], target: string | undefined): SegmentRecord | null {
	if (target === undefined || target === "") return history[0] ?? null;
	const trimmed = target.trim();
	const asIndex = Number(trimmed);
	if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < history.length) return history[asIndex] ?? null;
	const lower = trimmed.toLowerCase();
	return (
		history.find(
			(segment) =>
				segment.name.toLowerCase().includes(lower) ||
				segment.id.toLowerCase().startsWith(lower) ||
				basename(segment.file).toLowerCase().includes(lower),
		) ?? null
	);
}

/** pixie_recall 主体：按模式产出文本（index/tail/search）。 */
export function recallSegmentsText(input: {
	sessionDir: string;
	currentFile?: string | null;
	mode?: RecallMode;
	segment?: string;
	query?: string;
	limit?: number;
}): RecallResult {
	const mode: RecallMode = input.mode ?? "tail";
	// 与交接卡片同一套定位：省略 segment 必须落在卡片标为 0 的那一段上。
	const { history } = previousSegment({ sessionDir: input.sessionDir, currentFile: input.currentFile });
	if (history.length === 0) {
		return { ok: false, error: "小精灵工作区里没有其它会话段（目录为空或都读不到）。" };
	}
	if (mode === "index") {
		return { ok: true, text: cap(`本工作区的历史会话段（新→旧）：\n${formatSegmentIndex(history)}\n\n用 pixie_recall 带 segment=序号 读取某一段。`) };
	}
	const segment = locateSegment(history, input.segment);
	if (!segment) {
		return { ok: false, error: `找不到会话段「${input.segment ?? ""}」。先用 mode=index 看有哪些段。` };
	}
	if (mode === "search") {
		const query = (input.query ?? "").trim();
		if (!query) return { ok: false, error: "mode=search 需要 query。" };
		const hits = searchMessages(segment, query, input.limit ?? DEFAULT_SEARCH_HITS);
		if (hits.length === 0) {
			return { ok: true, text: `在段「${segment.name || "未命名"}」里没有找到「${query}」（共 ${segment.messageCount} 条消息）。` };
		}
		return { ok: true, text: cap([renderSegmentHead(segment, 0), `命中「${query}」${hits.length} 处：`, ...hits].join("\n\n")) };
	}
	const limit = Math.max(1, input.limit ?? DEFAULT_TAIL_MESSAGES);
	const tail = segment.messages.slice(-limit);
	return {
		ok: true,
		text: cap(
			[
				renderSegmentHead(segment, history.indexOf(segment)),
				...(segment.tailOnly ? ["（本段过大，只读了尾部）"] : []),
				...tail.map((message, index) => renderMessage(message, index)),
			].join("\n"),
		),
	};
}

function searchMessages(segment: SegmentRecord, query: string, limit: number): string[] {
	const needle = query.toLowerCase();
	const out: string[] = [];
	for (let i = 0; i < segment.messages.length && out.length < limit; i += 1) {
		const message = segment.messages[i];
		if (!message.text.toLowerCase().includes(needle)) continue;
		const context: string[] = [];
		if (i > 0) context.push(renderMessage(segment.messages[i - 1], i - 1));
		context.push(`→ ${renderMessage(message, i)}`);
		if (i + 1 < segment.messages.length) context.push(renderMessage(segment.messages[i + 1], i + 1));
		out.push(context.join("\n"));
	}
	return out;
}

function cap(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（输出已截断，可用 segment/query/limit 缩小范围）`;
}
