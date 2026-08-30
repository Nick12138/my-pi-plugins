/**
 * AnyToMD (pi-anytomd) — read any local file (images / Office / PDF) as Markdown.
 *
 * Tools:
 *   - anytomd        : one entry for everything. Auto-dispatch by extension.
 *                        images ×1  : wpscli photo2word (cloud OCR) → pandoc md
 *                        images ×N  : wpscli photo2pdf merge → pdf2word --scanned → pandoc md
 *                        office     : officecli view text (docx/xlsx/pptx), else pandoc,
 *                                     else wpscli convert → pdf2md (legacy doc/xls/ppt/...)
 *                        pdf text   : wpscli pdf2md (auto-detected, page range supported)
 *                        pdf scanned: wpscli pdf2word --scanned --range → pandoc md
 *                        txt / md   : direct read
 *                      Fallback: quality gate (empty / garbled) → Baidu OCR
 *                      (images direct, scanned PDF via pdf2photo pages); last resort the
 *                      model uses its vision tool (result carries fallback: see_image).
 *                      Optional outputPath persists the Markdown (rename-on-exists, no overwrite).
 *   - anytomd_setup  : dependency health report + one-shot auto-install (pandoc via winget,
 *                      officecli via official PowerShell script; wpscli is located, never
 *                      installed; Baidu keys are config-only).
 *
 * Dependencies (no npm packages — only Node built-ins + typebox):
 *   - WPS Office with wpscli.exe (+ VIP for cloud OCR)  : located via WPSCLI_PATH → PATH → install dirs
 *   - pandoc  : docx → Markdown (auto-installable via anytomd_setup)
 *   - officecli : Office direct read (auto-installable)
 *   - BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY : optional second OCR channel
 */

import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 300;
const SCAN_TIMEOUT_SEC = 900; // cloud OCR on many pages can be slow
const MAX_CONTEXT_CHARS = 200_000; // hard cap for the conversation copy
const MIN_TEXT_CHARS = 10; // quality gate: fewer readable chars ⇒ treat as failed
const MAX_GARBLE_RATIO = 0.3; // replacement-char ratio above ⇒ garbled

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff"]);
const OFFICE_NATIVE = new Set([".docx", ".xlsx", ".pptx"]);
const LEGACY_WORD = new Set([".doc", ".wps", ".rtf", ".txt", ".md"]);
const LEGACY_EXCEL = new Set([".xls", ".et"]);
const LEGACY_PPT = new Set([".ppt", ".dps"]);
const READABLE_TEXT = new Set([".txt", ".md", ".markdown"]);

const EXIT_HINTS: Record<number, string> = {
	100: "WPS 未登录：请在 WPS 桌面端登录账号后重试。",
	101: "账号权限不足：该转换通常需要 WPS 会员/超级会员，或当前账号未开通对应服务。",
	202: "wpscli 不认识的参数（内部自动重试修正）。",
	203: "文件不存在或路径不可读。",
	207: "输入文件超过 200MB，wpscli 拒绝处理。",
	209: "PDF 已加密且缺少打开密码。",
	210: "PDF 打开密码错误。",
	211: "输出目录不存在或不可写。",
};

// ---------------------------------------------------------------------------
// CLI discovery
// ---------------------------------------------------------------------------

function runSync(cmd: string, args: string[], timeoutMs = 10_000): string {
	// spawnSync (not execFileSync): the sync API prints the child's stderr to the
	// parent on non-zero exit, leaking GBK console noise (e.g. `where` not found)
	const res = spawnSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs, windowsHide: true });
	return String(res.stdout ?? "").trim();
}

function whereFirst(name: string): string {
	const out = runSync("where", [name]);
	return out.split(/\r?\n/)[0]?.trim() ?? "";
}

function versionOf(exe: string): string {
	const out = runSync(exe, ["--version"], 15_000);
	return out.split(/\r?\n/)[0]?.trim() ?? "";
}

// ---- wpscli ----

let wpscliCache: string | null = null;
let wpscliVersionCache: string | null = null;

function isRunnableWpscli(exe: string): boolean {
	return runSync(exe, ["--version"], 15_000).length > 0;
}

function wpsVersionFromPath(exe: string): string {
	const m = exe.match(/[\\/]WPS Office[\\/](\d+\.\d+\.\d+(?:\.\d+)?)/i);
	return m ? m[1] : "";
}

function isNewerVersion(a: string, b: string): boolean {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

function findWpscli(): string {
	if (wpscliCache) return wpscliCache;
	const candidates: string[] = [];
	const add = (p?: string | null) => {
		const abs = p?.trim();
		if (!abs || !existsSync(abs)) return;
		if (!candidates.some((c) => c.toLowerCase() === abs.toLowerCase())) candidates.push(abs);
	};
	const fromEnv = process.env.WPSCLI_PATH?.trim();
	if (fromEnv && isRunnableWpscli(fromEnv)) return (wpscliCache = fromEnv);
	add(fromEnv);

	for (const p of whereFirst("wpscli").split(/\r?\n/)) add(p);

	const roots = [
		path.join(os.homedir(), "AppData", "Local", "Kingsoft", "WPS Office"),
		"C:\\Program Files\\WPS Office",
	];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root)) {
			if (!/^\d+\.\d+/.test(entry)) continue;
			add(path.join(root, entry, "clitool", "wpscli.exe"));
		}
	}
	if (candidates.length === 0) {
		throw new Error(
			"找不到 wpscli：请安装 WPS Office，或设置 WPSCLI_PATH 指向 wpscli.exe（通常 ...\\WPS Office\\<版本>\\clitool\\wpscli.exe）。",
		);
	}
	candidates.sort((a, b) => {
		const va = wpsVersionFromPath(a) || "0";
		const vb = wpsVersionFromPath(b) || "0";
		if (va === vb) return 0;
		return isNewerVersion(va, vb) ? -1 : 1;
	});
	const exe = candidates[0];
	wpscliCache = exe;
	wpscliVersionCache = versionOf(exe);
	return exe;
}

function wpscliVersion(): string {
	if (wpscliVersionCache) return wpscliVersionCache;
	try {
		wpscliVersionCache = versionOf(findWpscli());
	} catch {
		wpscliVersionCache = "";
	}
	return wpscliVersionCache ?? "";
}

// ---- officecli / pandoc ----

/** Push an existing file into a candidate list (deduped, case-insensitive). */
function pushCandidate(list: string[], p?: string | null): void {
	const abs = p?.trim();
	if (!abs || !existsSync(abs)) return;
	if (!list.some((c) => c.toLowerCase() === abs.toLowerCase())) list.push(abs);
}

/** First candidate that actually runs, else the first existing one. */
function pickRunnable(candidates: string[]): string {
	return candidates.find((c) => versionOf(c)) ?? candidates[0];
}

let officecliCache: string | null = null;
let officecliVersionCache: string | null = null;
function findOfficecli(): string {
	if (officecliCache) return officecliCache;
	const candidates: string[] = [];
	for (const p of whereFirst("officecli").split(/\r?\n/)) pushCandidate(candidates, p);
	// Fallback: the official installer always puts it here; needed because a PATH
	// added mid-session is invisible to this already-running process.
	pushCandidate(candidates, path.join(os.homedir(), "AppData", "Local", "OfficeCLI", "officecli.exe"));
	if (!candidates.length) throw new Error("找不到 officecli：运行 anytomd_setup({ install: true }) 自动安装。");
	const exe = pickRunnable(candidates);
	officecliCache = exe;
	officecliVersionCache = versionOf(exe);
	return exe;
}
function officecliVersion(): string {
	if (!officecliCache) try { findOfficecli(); } catch { return ""; }
	return officecliVersionCache ?? "";
}

let pandocCache: string | null = null;
function findPandoc(): string {
	if (pandocCache) return pandocCache;
	const candidates: string[] = [];
	for (const p of whereFirst("pandoc").split(/\r?\n/)) pushCandidate(candidates, p);
	// Fallbacks for installs whose PATH entry is not yet visible to this process:
	// MSI default locations and the winget package tree (versioned subdir).
	pushCandidate(candidates, path.join(os.homedir(), "AppData", "Local", "Pandoc", "pandoc.exe"));
	pushCandidate(candidates, "C:\\Program Files\\Pandoc\\pandoc.exe");
	const wingetPkgs = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
	try {
		for (const pkg of readdirSync(wingetPkgs)) {
			if (!/^JohnMacFarlane\.Pandoc_/i.test(pkg)) continue;
			for (const sub of readdirSync(path.join(wingetPkgs, pkg))) {
				if (/^pandoc-/i.test(sub)) pushCandidate(candidates, path.join(wingetPkgs, pkg, sub, "pandoc.exe"));
			}
		}
	} catch { /* winget packages dir absent */ }
	if (!candidates.length) throw new Error("找不到 pandoc：运行 anytomd_setup({ install: true }) 自动安装。");
	pandocCache = pickRunnable(candidates);
	return pandocCache;
}

// ---------------------------------------------------------------------------
// Generic command runner
// ---------------------------------------------------------------------------

interface CmdResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

async function runCmd(
	exe: string,
	args: string[],
	opts: { timeoutSec?: number; signal?: AbortSignal } = {},
): Promise<CmdResult> {
	const timeoutMs = (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
	try {
		const { stdout, stderr } = await execFileAsync(exe, args, {
			timeout: timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			signal: opts.signal,
			encoding: "utf-8",
		});
		return { ok: true, code: 0, stdout, stderr };
	} catch (err) {
		const e = err as {
			code?: number | string;
			killed?: boolean;
			signal?: string;
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		if (e.killed || e.signal) {
			return { ok: false, code: typeof e.code === "number" ? e.code : null, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: "命令超时或被中断" };
		}
		return {
			ok: false,
			code: typeof e.code === "number" ? e.code : null,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			error: e.message ?? String(err),
		};
	}
}

/** wpscli subcommands that do NOT accept --timeout/--json extra flags. */
const WPS_NO_EXTRA = new Set(["pdfinfo"]);

/**
 * Run wpscli with an extra --timeout/--json unless the subcommand is known to
 * reject them; on "unknown argument" (202) retry without the extras.
 */
async function runWps(
	args: string[],
	opts: { timeoutSec?: number; signal?: AbortSignal } = {},
): Promise<CmdResult> {
	const exe = findWpscli();
	const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
	const sub = args[0] ?? "";
	const extras = WPS_NO_EXTRA.has(sub) ? [] : ["--timeout", String(timeoutSec), "--json"];
	let res = await runCmd(exe, [...args, ...extras], { timeoutSec: timeoutSec + 30, signal: opts.signal });
	if (!res.ok && res.code === 202 && extras.length) {
		res = await runCmd(exe, args, { timeoutSec: timeoutSec + 30, signal: opts.signal });
	}
	if (!res.ok) {
		const code = res.code;
		const hint = code != null ? EXIT_HINTS[code] : undefined;
		const tail = [res.stdout, res.stderr].filter(Boolean).join("\n").trim().slice(0, 1500);
		res.error = [res.error, hint, tail ? `wpscli 输出: ${tail}` : ""].filter(Boolean).join("\n");
	}
	return res;
}

/** Best-effort parse: JSON first (wpscli --json), else plain text. */
function parseWpsResult(res: CmdResult): { text: string; parsed: unknown } {
	const text = (res.stdout.trim() || res.stderr.trim()).trim();
	let parsed: unknown = null;
	if (text) {
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			const brace = text.lastIndexOf("{");
			if (brace >= 0) {
				try {
					parsed = JSON.parse(text.slice(brace)) as unknown;
				} catch {
					parsed = null;
				}
			}
		}
	}
	return { text, parsed };
}

// ---------------------------------------------------------------------------
// Baidu OCR (trimmed from pi-ocr: token cache, general endpoints, concurrency)
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_ENDPOINTS = {
	general: "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic",
	accurate: "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic",
} as const;
const BASE64_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 10;

type Accuracy = "standard" | "accurate";

interface OcrResponse {
	error_code?: number;
	error_msg?: string;
	direction?: number;
	words_result_num?: number;
	words_result?: Array<{ words?: string; probability?: { average?: number } }>;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
let tokenInflight: Promise<string> | null = null;
let tokenInflightKey = "";

function ocrSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postForm<T>(url: string, data: Record<string, string>, signal?: AbortSignal): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(data).toString(),
		signal: ocrSignal(signal),
	});
	const text = await res.text();
	let parsed: T;
	try {
		parsed = JSON.parse(text) as T;
	} catch {
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	return parsed;
}

async function getAccessTokenCached(apiKey: string, secretKey: string): Promise<string> {
	const cacheKey = `${apiKey}\u0000${secretKey}`;
	const hit = tokenCache.get(cacheKey);
	if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
	if (tokenInflight && tokenInflightKey === cacheKey) return tokenInflight;
	tokenInflightKey = cacheKey;
	tokenInflight = (async () => {
		const data = await postForm<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(
			TOKEN_URL,
			{ grant_type: "client_credentials", client_id: apiKey, client_secret: secretKey },
			undefined,
		);
		if (!data.access_token) {
			throw new Error(`Access token failed: ${data.error_description || data.error || "unknown error"}`);
		}
		tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 2_592_000) * 1000 });
		return data.access_token;
	})().finally(() => {
		tokenInflight = null;
		tokenInflightKey = "";
	});
	return tokenInflight;
}

function baiduErrorHint(code: number, msg: string): string {
	const hints: Record<number, string> = {
		4: "集群超限额，稍后重试",
		17: "当日可用额度已用尽（免费测试资源：个人约 1000 次/月、企业 2000 次/月）——核对配额或开通按量后付费",
		18: "QPS 超限（未付费账号 2 QPS）——把 concurrency 降到 2，或开通按量后付费",
		19: "请求总量超限",
		216102: "图片格式不支持（jpg/png/bmp/gif）",
		216103: "图片太小或质量过差",
		216200: "图片为空或格式错误",
		216202: "图片大小错误（base64 ≤ 4MB、最长边 ≤ 4096px）",
		216630: "图片模糊/过暗——换更清晰的图，或改用 accuracy=accurate",
		216631: "识别失败（图片质量问题）",
	};
	const base = `Baidu OCR error ${code}: ${msg || "unknown"}`;
	const hint = hints[code];
	return hint ? `${base} —— ${hint}` : base;
}

function ocrCredentials(): { apiKey: string; secretKey: string } | { error: string } {
	const apiKey = process.env.BAIDU_OCR_API_KEY?.trim();
	const secretKey = process.env.BAIDU_OCR_SECRET_KEY?.trim();
	if (!apiKey || !secretKey) {
		return {
			error:
				"BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY 未配置——在插件配置页填写，或运行 anytomd_setup 查看状态。",
		};
	}
	return { apiKey, secretKey };
}

async function callOcr(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<OcrResponse> {
	const creds = ocrCredentials();
	if ("error" in creds) throw new Error(creds.error);
	const token = await getAccessTokenCached(creds.apiKey, creds.secretKey);
	let result = await postForm<OcrResponse>(`${url}?access_token=${encodeURIComponent(token)}`, params, signal);
	if (result.error_code != null && [100, 110, 111].includes(result.error_code)) {
		tokenCache.delete(`${creds.apiKey}\u0000${creds.secretKey}`);
		const fresh = await getAccessTokenCached(creds.apiKey, creds.secretKey);
		result = await postForm<OcrResponse>(`${url}?access_token=${encodeURIComponent(fresh)}`, params, signal);
	}
	if (result.error_code != null) throw new Error(baiduErrorHint(result.error_code, result.error_msg || ""));
	return result;
}

async function recognizeGeneral(imagePath: string, accuracy: Accuracy, signal?: AbortSignal): Promise<string> {
	const abs = path.resolve(imagePath);
	const encoded = readFileSync(abs).toString("base64");
	if (encoded.length > BASE64_LIMIT) {
		throw new Error(`图片 base64 超过 4MB（${Math.round(encoded.length / 1024 / 1024)}MB）——压缩后再试。`);
	}
	const endpoint = accuracy === "accurate" ? OCR_ENDPOINTS.accurate : OCR_ENDPOINTS.general;
	const result = await callOcr(endpoint, { image: encoded, detect_direction: "true", paragraph: "true", probability: "true" }, signal);
	return (result.words_result ?? []).map((i) => i.words ?? "").join("\n").trim();
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

/** OCR a list of image paths → per-image text blocks. One failure isolates, never aborts. */
async function ocrImages(
	imagePaths: string[],
	accuracy: Accuracy,
	concurrency: number,
	signal?: AbortSignal,
): Promise<{ sections: Array<{ label: string; text: string; ok: boolean; error?: string }> }> {
	const outcomes = await mapWithConcurrency(imagePaths, concurrency, async (p) => {
		try {
			const text = await recognizeGeneral(p, accuracy, signal);
			return { label: path.basename(p), text, ok: true };
		} catch (err) {
			return { label: path.basename(p), text: "", ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	return { sections: outcomes };
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/** Strip markdown syntax and whitespace → count readable characters. */
function plainLength(md: string): number {
	return md
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // image embeds
		.replace(/```[\s\S]*?```/g, " ") // code fences
		.replace(/`[^`]*`/g, " ") // inline code
		.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
		.replace(/[#>*_~|`\-=\[\](){}:;,.!?'"\\/\d\s]/g, "") // punctuation/digits/space
		.trim();
}

function textQualityOk(md: string): boolean {
	const plain = plainLength(md);
	if (plain.length < MIN_TEXT_CHARS) return false;
	const garble = (md.match(/\uFFFD/g) ?? []).length;
	return garble / Math.max(1, md.length) < MAX_GARBLE_RATIO;
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

function readMdFile(file: string): string {
	const raw = readFileSync(file, "utf-8");
	return raw.replace(/^\uFEFF/, "");
}

/** 过程文件临时目录：AI 当前工作区的 Agent临时工作/temporary/ 下（用后即删） */
function makeTmpDir(): string {
	const base = path.join(process.cwd(), "Agent临时工作", "temporary");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(path.join(base, "anytomd-"));
}

/** 删除临时目录；若父级 temporary 变空则一并移除（不报错） */
function removeTmpDir(tmpDir: string): void {
	const rm = (): boolean => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	};
	// wpscli 云端任务结束后文件句柄可能延迟释放（Windows），失败则短暂重试
	let ok = rm();
	for (let i = 0; !ok && i < 10; i++) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
		ok = rm();
	}
	try {
		const parent = path.dirname(tmpDir);
		if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

/** Persist md to outputPath with rename-on-exists (foo_1.md, foo_2.md, ...). Never overwrites. */
function saveMarkdown(md: string, outputPath: string): string {
	const abs = path.resolve(outputPath);
	const dir = path.dirname(abs);
	const rawName = path.basename(abs);
	const hasMdExt = /\.md$/i.test(rawName);
	const targetName = hasMdExt ? rawName : `${rawName}.md`;
	mkdirSync(dir, { recursive: true });
	let finalName = targetName;
	let counter = 1;
	while (existsSync(path.join(dir, finalName))) {
		const p = path.parse(targetName);
		finalName = `${p.name}_${counter}${p.ext}`;
		counter++;
	}
	const finalPath = path.join(dir, finalName);
	writeFileSync(finalPath, md, "utf-8");
	return finalPath;
}

function truncate(text: string, max = MAX_CONTEXT_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…(内容过长已截断，完整共 ${text.length} 字符；可用 outputPath 落盘获取全文)`;
}

// ---------------------------------------------------------------------------
// Conversion flows
// ---------------------------------------------------------------------------

interface FlowResult {
	md: string;
	route: string;
}

/** docx → markdown via pandoc; fallback officecli view text. */
async function docxToMd(docx: string, tmpDir: string, signal?: AbortSignal): Promise<FlowResult> {
	let pandoc = "";
	try {
		pandoc = findPandoc();
	} catch {
		pandoc = "";
	}
	if (pandoc) {
		const mdOut = path.join(tmpDir, "docx.md");
		const res = await runCmd(pandoc, [docx, "-t", "gfm", "-o", mdOut], { timeoutSec: DEFAULT_TIMEOUT_SEC, signal });
		if (res.ok && existsSync(mdOut)) {
			const md = readMdFile(mdOut);
			if (textQualityOk(md)) return { md, route: "pandoc" };
		}
	}
	// fallback: officecli view text (view a COPY — officecli is a resident server that
	// keeps the most recently viewed file handle open, which would lock our temp dir)
	try {
		const res = await officecliView(docx, signal);
		if (res.ok && textQualityOk(res.stdout)) return { md: res.stdout, route: "officecli view text" };
	} catch {
		// ignore
	}
	throw new Error("docx → md 失败（pandoc 与 officecli 均不可用或结果为空）");
}

/**
 * officecli view via a copy in the OS temp dir. officecli is a resident-server CLI:
 * the first call spawns a long-lived process that holds the most recently viewed
 * file handle open, which would lock the original (user files or our tmpDir).
 */
async function officecliView(file: string, signal?: AbortSignal): Promise<CmdResult> {
	const officecli = findOfficecli();
	const ext = path.extname(file);
	const copy = path.join(
		os.tmpdir(),
		`anytomd-officecli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
	);
	copyFileSync(file, copy);
	try {
		return await runCmd(officecli, ["view", copy, "text"], { timeoutSec: DEFAULT_TIMEOUT_SEC, signal });
	} finally {
		// view starts a resident process that holds the file handle; `close` releases it
		try {
			await runCmd(officecli, ["close", copy], { timeoutSec: 30, signal });
		} catch {
			// ignore
		}
		try {
			rmSync(copy, { force: true });
		} catch {
			// copy may still be held; OS temp will clean it up
		}
	}
}

/** Images via WPS. Single: photo2word. Multiple: photo2pdf merge → pdf2word --scanned. */
async function imagesViaWps(images: string[], tmpDir: string, rangeHint: string | undefined, signal?: AbortSignal): Promise<FlowResult> {
	if (images.length === 1) {
		const outDocx = path.join(tmpDir, "single.docx");
		const res = await runWps(["photo2word", images[0], "-o", outDocx], { timeoutSec: SCAN_TIMEOUT_SEC, signal });
		if (!res.ok) throw new Error(`photo2word 失败：${res.error}`);
		if (!existsSync(outDocx)) throw new Error("photo2word 未产出 docx");
		const md = await docxToMd(outDocx, tmpDir, signal);
		return { ...md, route: `wps photo2word → ${md.route}` };
	}
	// multiple → merge to pdf, then scanned OCR to word
	const pdfOut = path.join(tmpDir, "merged.pdf");
	const res = await runWps(["photo2pdf", ...images, "-o", pdfOut], { timeoutSec: SCAN_TIMEOUT_SEC, signal });
	if (!res.ok) throw new Error(`photo2pdf 失败：${res.error}`);
	if (!existsSync(pdfOut)) throw new Error("photo2pdf 未产出 pdf");

	const info = await wpsPdfInfo(pdfOut);
	const pages = info.pages || images.length;
	const range = rangeHint && /^\d+(-\d+)?$/.test(rangeHint) ? rangeHint : `1-${pages}`;
	const outDocx = path.join(tmpDir, "merged.docx");
	const res2 = await runWps(["pdf2word", pdfOut, "--scanned", "true", "--range", range, "-o", outDocx], {
		timeoutSec: SCAN_TIMEOUT_SEC,
		signal,
	});
	if (!res2.ok) throw new Error(`pdf2word(扫描) 失败：${res2.error}`);
	if (!existsSync(outDocx)) throw new Error("pdf2word 未产出 docx");
	const md = await docxToMd(outDocx, tmpDir, signal);
	return { ...md, route: `wps photo2pdf→pdf2word(扫描) → ${md.route}` };
}

/** Office files. Native → officecli view text; docx fallback pandoc; legacy → wps convert → pdf2md. */
async function officeToMd(file: string, tmpDir: string, signal?: AbortSignal): Promise<FlowResult> {
	const ext = path.extname(file).toLowerCase();
	if (OFFICE_NATIVE.has(ext)) {
		try {
			const res = await officecliView(file, signal);
			if (res.ok && textQualityOk(res.stdout)) return { md: res.stdout, route: "officecli view text" };
		} catch {
			// fall through
		}
		if (ext === ".docx") {
			try {
				const tmpDir = makeTmpDir();
				try {
					return await docxToMd(file, tmpDir, signal);
				} finally {
					removeTmpDir(tmpDir);
				}
			} catch {
				// fall through to wps chain
			}
		}
	}
	// legacy / fallback: convert to pdf via wpscli, then pdf2md
	const toPdfSub = LEGACY_EXCEL.has(ext) ? "excel2pdf" : LEGACY_PPT.has(ext) ? "ppt2pdf" : "word2pdf";
	const pdfOut = path.join(tmpDir, `legacy_${path.basename(file, ext)}.pdf`);
	try {
		const res = await runWps([toPdfSub, file, "-o", pdfOut], { timeoutSec: SCAN_TIMEOUT_SEC, signal });
		if (!res.ok) throw new Error(`${toPdfSub} 失败：${res.error}`);
		if (!existsSync(pdfOut)) throw new Error(`${toPdfSub} 未产出 pdf`);
		return await pdfTextToMd(pdfOut, tmpDir, signal);
	} finally {
		rmSync(pdfOut, { force: true });
	}
}

/** wpscli pdfinfo → { pages, scanned }. Robust to both --json and plain output. */
async function wpsPdfInfo(file: string): Promise<{ pages: number; scanned: boolean; raw: string }> {
	const res = await runWps(["pdfinfo", file], { timeoutSec: 60 });
	const { text, parsed } = parseWpsResult(res);
	const rec = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}) as Record<string, unknown>;
	const get = (keys: string[]): string => {
		for (const k of keys) {
			const v = rec[k];
			if (v != null) return String(v);
		}
		return "";
	};
	const pages = parseInt(get(["page_count", "pages", "pageCount"]) || text.match(/page_count[:\s]+(\d+)/i)?.[1] || "0", 10) || 0;
	const scannedRaw = get(["is_scan_document", "isScanDocument", "scanned"]) || text.match(/is_scan_document[:\s]+(true|false)/i)?.[1] || "";
	const scanned = scannedRaw.toLowerCase() === "true";
	return { pages, scanned, raw: text };
}

/** Text PDF → pdf2md. */
async function pdfTextToMd(pdf: string, tmpDir: string, signal?: AbortSignal, range?: string): Promise<FlowResult> {
	const mdOut = path.join(tmpDir, "pdf.md");
	try {
		const args = ["pdf2md", pdf, "-o", mdOut];
		if (range && /^\d+(-\d+)?$/.test(range)) args.push("--range", range);
		const res = await runWps(args, { timeoutSec: SCAN_TIMEOUT_SEC, signal });
		if (!res.ok) throw new Error(`pdf2md 失败：${res.error}`);
		if (!existsSync(mdOut)) throw new Error("pdf2md 未产出 md");
		const md = readMdFile(mdOut);
		if (!textQualityOk(md)) throw new Error("pdf2md 结果为空（疑似扫描件）");
		return { md, route: "wps pdf2md" };
	} finally {
		rmSync(mdOut, { force: true });
	}
}

/** Scanned PDF → pdf2word --scanned (cloud OCR) → docx → pandoc md. */
async function pdfScannedToMd(pdf: string, pages: number, range: string | undefined, tmpDir: string, signal?: AbortSignal): Promise<FlowResult> {
	const outDocx = path.join(tmpDir, "scanned.docx");
	const useRange = range && /^\d+(-\d+)?$/.test(range) ? range : `1-${Math.max(1, pages)}`;
	const res = await runWps(["pdf2word", pdf, "--scanned", "true", "--range", useRange, "-o", outDocx], {
		timeoutSec: SCAN_TIMEOUT_SEC,
		signal,
	});
	if (!res.ok) throw new Error(`pdf2word(扫描) 失败：${res.error}`);
	if (!existsSync(outDocx)) throw new Error("pdf2word 未产出 docx");
	const md = await docxToMd(outDocx, tmpDir, signal);
	return { ...md, route: `wps pdf2word(扫描 OCR) → ${md.route}` };
}

/** Scanned PDF via pdf2photo pages → Baidu OCR per page. */
async function pdfOcrToMd(pdf: string, accuracy: Accuracy, concurrency: number, tmpDir: string, signal?: AbortSignal): Promise<FlowResult> {
	const outDir = path.join(tmpDir, "pages");
	mkdirSync(outDir, { recursive: true });
	const res = await runWps(["pdf2photo", pdf, "-o", outDir, "--suffix", "jpg", "--image-quality", "high"], {
		timeoutSec: SCAN_TIMEOUT_SEC,
		signal,
	});
	if (!res.ok) throw new Error(`pdf2photo 失败：${res.error}`);
	const pages = readdirSync(outDir)
		.filter((f) => /\.(jpe?g|png)$/i.test(f))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		.map((f) => path.join(outDir, f));
	if (!pages.length) throw new Error("pdf2photo 未产出页面图片");
	const { sections } = await ocrImages(pages, accuracy, concurrency, signal);
	const md = sections
		.map((s, i) => {
			const header = `## 第 ${i + 1} 页`;
			return s.ok ? `${header}\n\n${s.text}` : `${header}\n\n(识别失败) ${s.error ?? "unknown"}`;
		})
		.join("\n\n");
	return { md, route: "wps pdf2photo → Baidu OCR" };
}

/** PDF entry: auto-detect scanned, route accordingly, with OCR last resort. */
async function pdfToMd(
	pdf: string,
	opts: { range?: string; method: "auto" | "wps" | "ocr"; accuracy: Accuracy; concurrency: number; tmpDir: string; signal?: AbortSignal },
): Promise<FlowResult> {
	const { range, method, accuracy, concurrency, tmpDir, signal } = opts;
	if (method === "ocr") return pdfOcrToMd(pdf, accuracy, concurrency, tmpDir, signal);

	let info: { pages: number; scanned: boolean };
	try {
		info = await wpsPdfInfo(pdf);
	} catch {
		info = { pages: 0, scanned: false };
	}

	if (info.scanned) {
		try {
			return await pdfScannedToMd(pdf, info.pages, range, tmpDir, signal);
		} catch (err) {
			if (method === "wps") throw err;
			const note = err instanceof Error ? err.message : String(err);
			try {
				const ocr = await pdfOcrToMd(pdf, accuracy, concurrency, tmpDir, signal);
				return { ...ocr, route: `${ocr.route}（扫描件 WPS 失败后降级: ${note.slice(0, 120)}）` };
			} catch {
				throw err;
			}
		}
	}

	try {
		return await pdfTextToMd(pdf, tmpDir, signal, range);
	} catch (err) {
		if (method === "wps") throw err;
		const note = err instanceof Error ? err.message : String(err);
		// maybe detection was wrong (silently scanned) → try scanned route
		try {
			const scanned = await pdfScannedToMd(pdf, info.pages || 1, range, tmpDir, signal);
			return { ...scanned, route: `${scanned.route}（文字提取为空，按扫描件重试）` };
		} catch {
			try {
				const ocr = await pdfOcrToMd(pdf, accuracy, concurrency, tmpDir, signal);
				return { ...ocr, route: `${ocr.route}（pdf2md 为空后降级: ${note.slice(0, 120)}）` };
			} catch {
				throw err;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Dependency check / install (anytomd_setup)
// ---------------------------------------------------------------------------

interface DepStatus {
	name: string;
	ok: boolean;
	version: string;
	path: string;
	detail: string;
}

function checkDeps(): DepStatus[] {
	const statuses: DepStatus[] = [];

	let wpsPath = "";
	let wpsVer = "";
	try {
		wpsPath = findWpscli();
		wpsVer = wpscliVersion();
		statuses.push({ name: "wpscli", ok: true, version: wpsVer, path: wpsPath, detail: "WPS Office 自带（云端 OCR 需 WPS 会员）" });
	} catch (err) {
		statuses.push({ name: "wpscli", ok: false, version: "", path: "", detail: err instanceof Error ? err.message : String(err) });
	}

	try {
		const officePath = findOfficecli();
		statuses.push({ name: "officecli", ok: true, version: officecliVersion(), path: officePath, detail: "" });
	} catch {
		statuses.push({ name: "officecli", ok: false, version: "", path: "", detail: "未安装——运行 anytomd_setup({ install: true }) 自动安装" });
	}

	let pandocPath = "";
	try {
		pandocPath = findPandoc();
		statuses.push({ name: "pandoc", ok: true, version: versionOf(pandocPath), path: pandocPath, detail: "" });
	} catch (err) {
		statuses.push({ name: "pandoc", ok: false, version: "", path: "", detail: err instanceof Error ? err.message : String(err) });
	}

	const ocrKeys = ocrCredentials();
	if ("apiKey" in ocrKeys) {
		statuses.push({ name: "百度 OCR Key", ok: true, version: "", path: "", detail: "BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY 已配置" });
	} else {
		statuses.push({ name: "百度 OCR Key", ok: false, version: "", path: "", detail: ocrKeys.error });
	}

	return statuses;
}

function depsReport(statuses: DepStatus[]): string {
	const rows = statuses
		.map((s) => {
			const state = s.ok ? "✅" : "❌";
			const ver = s.version ? `v${s.version}` : "";
			const loc = s.path || s.detail;
			return `| ${state} | ${s.name} | ${ver} | ${loc.replace(/\|/g, "\\|")} |`;
		})
		.join("\n");
	return [
		"## 依赖体检报告",
		"",
		"| 状态 | 依赖 | 版本 | 位置/说明 |",
		"|---|---|---|---|",
		rows,
		"",
		statuses.every((s) => s.ok)
			? "全部就绪 ✅"
			: "存在缺失——运行 anytomd_setup({ install: true }) 自动安装可装的项。",
	].join("\n");
}

interface InstallOutcome {
	name: string;
	ranOk: boolean; // installer process exited 0
	detected: boolean; // dependency visible on re-check
	note: string; // error/output tail when something failed
}

/** One-line digest of a failed installer run (error + output tail). */
function installNote(r: CmdResult): string {
	if (r.ok) return "";
	const tail = [r.error, r.stderr, r.stdout]
		.filter(Boolean)
		.join(" | ")
		.replace(/\s+/g, " ")
		.trim();
	return tail ? `原因: ${tail.slice(0, 300)}` : "安装器退出码非 0 且无输出";
}

/**
 * Merge the Machine+User PATH from the registry into this process. Installers
 * only update the registry, so without this a just-installed tool is invisible
 * to `where` until a new terminal session starts.
 */
function refreshProcessPathFromRegistry(): void {
	const out = runSync("powershell", [
		"-NoProfile",
		"-Command",
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
			"[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine')) + ';' + " +
			"[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','User'))",
	], 15_000);
	if (!out) return;
	const current = (process.env.PATH ?? "").split(";").filter(Boolean);
	const seen = new Set(current.map((p) => p.toLowerCase().replace(/[\\/]+$/, "")));
	const extra = out
		.split(";")
		.map((p) => p.trim())
		.filter((p) => p && !seen.has(p.toLowerCase().replace(/[\\/]+$/, "")));
	if (extra.length) process.env.PATH = [...current, ...extra].join(";");
}

async function installMissing(deps: DepStatus[], signal?: AbortSignal): Promise<InstallOutcome[]> {
	const outcomes: InstallOutcome[] = [];
	const office = deps.find((d) => d.name === "officecli" && !d.ok);
	const pandoc = deps.find((d) => d.name === "pandoc" && !d.ok);

	if (office) {
		const r = await runCmd("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://d.officecli.ai/install.ps1 | iex"], {
			timeoutSec: 600,
			signal,
		});
		outcomes.push({ name: "officecli", ranOk: r.ok, detected: false, note: installNote(r) });
	}
	if (pandoc) {
		const r = await runCmd("winget", [
			"install",
			"--id",
			"JohnMacFarlane.Pandoc",
			"-e",
			"--accept-source-agreements",
			"--accept-package-agreements",
			"--disable-interactivity",
		], { timeoutSec: 900, signal });
		outcomes.push({ name: "pandoc", ranOk: r.ok, detected: false, note: installNote(r) });
	}
	if (outcomes.length) {
		// Make registry PATH changes visible, then recheck (fallback path probing
		// in findOfficecli/findPandoc covers the rest).
		refreshProcessPathFromRegistry();
		const recheck = checkDeps();
		for (const o of outcomes) {
			o.detected = recheck.find((d) => d.name === o.name)?.ok === true;
			if (!o.detected && !o.note) o.note = "安装器执行完成，但复查仍未找到（可能装到了非标准位置）";
		}
	}
	return outcomes;
}

// ---------------------------------------------------------------------------
// Tool result helper
// ---------------------------------------------------------------------------

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Warm dependency cache silently at startup (no installs, no notify).
	pi.on("session_start", () => {
		try { findOfficecli(); } catch { /* ignore */ }
		try { findPandoc(); } catch { /* ignore */ }
		try { findWpscli(); } catch { /* ignore */ }
	});

	pi.registerTool({
		name: "anytomd",
		label: "AnyToMD",
		description:
			"Read any local file as Markdown, by path. Auto-dispatch: images (single → WPS photo2word; " +
			"multiple → merge PDF → WPS scanned OCR), Office files (docx/xlsx/pptx → officecli view text; " +
			"legacy doc/xls/ppt/wps/et/dps → wpscli convert → pdf2md), PDF (auto text/scanned detection: " +
			"text → pdf2md, scanned → pdf2word --scanned OCR → markdown), txt/md direct read. " +
			"Quality gate auto-falls-back to Baidu OCR when WPS output is empty/garbled (method=\"ocr\" forces it). " +
			"If everything fails, the result carries fallback=\"see_image\" so the model can try its vision tool. " +
			"Results are always returned in the conversation; optional outputPath also persists a .md file " +
			"(relative paths default to <workspace>/Agent临时工作/output/, absolute paths as-is; rename-on-exists, never overwrites). " +
			"Intermediate process files go to <workspace>/Agent临时工作/temporary/ and are cleaned up after every run. " +
			"Requires wpscli (WPS Office) for the primary chains; " + +
			"pandoc/officecli for office files; run anytomd_setup to check/install.",
		promptSnippet:
			"Read any local file (image/Office/PDF) as Markdown; auto-detects scanned PDFs; Baidu OCR fallback; optional md file output",
		promptGuidelines: [
			"Use anytomd when the user asks to read/extract a local file by path — images, docx/xlsx/pptx, doc/xls/ppt legacy, PDF (text or scanned).",
			"Pass multiple image paths in one call to merge them; one file per section for non-images; PDF page ranges via range (e.g. \"1-5\").",
			"If the returned text looks wrong or garbled, retry the same call with method=\"ocr\" to force Baidu OCR (accuracy=\"accurate\" for blurry scans).",
			"Pass outputPath only when the user wants a Markdown file saved; results are otherwise returned in context only.",
			"Run anytomd_setup (no args) when a dependency error appears; anytomd_setup({install:true}) auto-installs pandoc/officecli.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "One or more local file paths (absolute or relative)" }), {
				description: "文件路径；多张图片会合并为一份结果",
			}),
			outputPath: Type.Optional(
				Type.String({
					description:
						"可选：结果同时落盘为 .md 文件（已存在自动改名，不覆盖）。相对路径优先落到当前工作区的 Agent临时工作/output/ 目录；绝对路径按原样保存。未提供则仅返回上下文，不产生任何文件。",
				}),
			),
			method: Type.Optional(
				Type.Union(
					[Type.Literal("auto"), Type.Literal("wps"), Type.Literal("ocr")],
					{
						description:
							"auto = WPS 优先、质量差自动降级到百度 OCR；wps = 只用 WPS 链路；ocr = 强制百度 OCR（图片/扫描件 PDF）。默认 auto",
						default: "auto",
					},
				),
			),
			accuracy: Type.Optional(
				Type.Union(
					[Type.Literal("standard"), Type.Literal("accurate")],
					{ description: "百度 OCR 精度：standard 标准版（快）/ accurate 高精度版（更准更慢）。默认 standard", default: "standard" },
				),
			),
			concurrency: Type.Optional(
				Type.Number({
					description: `百度 OCR 并发数 1-${MAX_CONCURRENCY}（默认 ${DEFAULT_CONCURRENCY}；未付费百度账号 QPS=2，开按量后可到 10）`,
				}),
			),
			range: Type.Optional(
				Type.String({
					description: "PDF 页码范围（单段，如 \"1-5\" 或 \"3\"），默认全部页；仅对 PDF 生效",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const paths = [...new Set(params.paths.map((p) => p.trim()).filter(Boolean))];
			if (!paths.length) {
				return toolResult("anytomd failed: paths is empty.", { error: "paths is empty" });
			}
			const method = params.method ?? "auto";
			const accuracy = params.accuracy === "accurate" ? "accurate" : "standard";
			const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(params.concurrency ?? DEFAULT_CONCURRENCY)));

			const missing = paths.filter((p) => !existsSync(p));
			if (missing.length) {
				return toolResult(
					`anytomd failed: 文件不存在：${missing.join("、")}`,
					{ error: "file not found", missing },
				);
			}

			const tmpDir = makeTmpDir();
			const sections: Array<{ header: string; md: string; route?: string; error?: string }> = [];
			const details: Record<string, unknown> = { method, accuracy, concurrency };
			const detailsPerFile: Array<Record<string, unknown>> = [];
			let anySuccess = false;

			try {
				// images as one group (merge semantics)
				const images = paths.filter((p) => IMAGE_EXTS.has(path.extname(p).toLowerCase()));
				const others = paths.filter((p) => !IMAGE_EXTS.has(path.extname(p).toLowerCase()));
				const groupLabel = images.length > 1 ? `${images.length} 张图片` : images.length === 1 ? "1 张图片" : "";

				if (images.length) {
					const header = groupLabel ? `## 来源：${groupLabel}` : "";
					try {
						if (method === "ocr") {
							const { sections: ocrSections } = await ocrImages(images, accuracy, concurrency, signal);
							const md = ocrSections
								.map((s, i) => `### ${i + 1}. ${s.label}\n\n${s.ok ? s.text : `(识别失败) ${s.error}`}`)
								.join("\n\n");
							sections.push({ header, md, route: "Baidu OCR" });
							anySuccess = true;
						} else {
							try {
								const flow = await imagesViaWps(images, tmpDir, params.range, signal);
								sections.push({ header, md: flow.md, route: flow.route });
								anySuccess = true;
							} catch (wpsErr) {
								const wpsNote = wpsErr instanceof Error ? wpsErr.message : String(wpsErr);
								if (method === "wps") throw wpsErr;
								const { sections: ocrSections } = await ocrImages(images, accuracy, concurrency, signal);
								const md = ocrSections
									.map((s, i) => `### ${i + 1}. ${s.label}\n\n${s.ok ? s.text : `(识别失败) ${s.error}`}`)
									.join("\n\n");
								sections.push({ header, md, route: `Baidu OCR（WPS 失败降级: ${wpsNote.slice(0, 120)}）` });
								anySuccess = true;
							}
						}
						detailsPerFile.push({ source: images, kind: "image", ok: true });
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						sections.push({ header, md: "", error: message });
						detailsPerFile.push({ source: images, kind: "image", ok: false, error: message });
					}
				}

				// non-image files, each its own section
				for (const file of others) {
					const ext = path.extname(file).toLowerCase();
					const header = `## 来源：${file}`;
					try {
						let flow: FlowResult;
						if (ext === ".pdf") {
							flow = await pdfToMd(file, { range: params.range, method, accuracy, concurrency, tmpDir, signal });
						} else if (READABLE_TEXT.has(ext)) {
							const md = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
							flow = { md, route: "direct read" };
						} else if (IMAGE_EXTS.has(ext)) {
							flow = { md: "", route: "unreachable" }; // handled above
						} else {
							flow = await officeToMd(file, tmpDir, signal);
						}
						sections.push({ header, md: flow.md, route: flow.route });
						anySuccess = true;
						detailsPerFile.push({ source: file, kind: ext.slice(1), ok: true, route: flow.route });
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						sections.push({ header, md: "", error: message });
						detailsPerFile.push({ source: file, kind: ext.slice(1), ok: false, error: message });
					}
				}
			} finally {
				removeTmpDir(tmpDir);
			}

			// Assemble final markdown
			const body = sections
				.map((s) => {
					const parts: string[] = [];
					if (s.header) parts.push(s.header);
					if (s.route) parts.push(`> 处理链路：${s.route}`);
					if (s.error) parts.push(`\n> ⚠️ 读取失败：${s.error}`);
					parts.push(s.md || "");
					return parts.filter(Boolean).join("\n\n");
				})
				.join("\n\n---\n\n");

			let finalText = body;
			const detailsOut: Record<string, unknown> = { ...details, files: detailsPerFile, anySuccess };

			if (params.outputPath) {
				// 相对路径默认落到 AI 当前工作区的 Agent临时工作/output/ 目录；绝对路径按原样
				const out = path.isAbsolute(params.outputPath)
					? params.outputPath
					: path.join(process.cwd(), "Agent临时工作", "output", params.outputPath);
				try {
					const savedTo = saveMarkdown(truncate(body, 10_000_000), out);
					detailsOut.output = savedTo;
					finalText = `${body}\n\n已落盘: ${savedTo}`;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					detailsOut.outputError = message;
					finalText = `${body}\n\n落盘失败: ${message}`;
				}
			}

			if (!anySuccess) {
				const hints: string[] = [];
				const anyImage = sections.some((s) => /图片|来源：/.test(s.header) && !s.error);
				if (anyImage || paths.some((p) => IMAGE_EXTS.has(path.extname(p).toLowerCase()))) {
					hints.push('fallback="see_image"（用视觉工具逐张看图兜底）');
				}
				finalText = `${finalText}\n\n> 全部链路失败。${hints.join("；") || "检查依赖：运行 anytomd_setup() 查看体检报告。"}`;
			}

			return toolResult(truncate(finalText), detailsOut);
		},
	});

	pi.registerTool({
		name: "anytomd_setup",
		label: "AnyToMD Setup",
		description:
			"Dependency health check and one-shot auto-install for AnyToMD. No args → read-only report: " +
			"wpscli (WPS Office, located never installed), officecli, pandoc, Baidu OCR keys. " +
			"install=true → auto-install missing installables: pandoc via winget (JohnMacFarlane.Pandoc), " +
			"officecli via the official PowerShell script (https://d.officecli.ai/install.ps1). " +
			"wpscli is never installed (comes with WPS Office); Baidu keys are config-only " +
			"(BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY). Detection probes known install dirs " +
			"(e.g. %LOCALAPPDATA%\\OfficeCLI, winget packages) and refreshes this process's PATH " +
			"from the registry after installing, so a fresh terminal is not required.",
		promptSnippet:
			"Check or auto-install AnyToMD dependencies (wpscli/officecli/pandoc/Baidu keys); install=true runs the installers",
		promptGuidelines: [
			"Run anytomd_setup() first when anytomd reports a missing dependency or the user asks about the plugin setup.",
			"Pass install=true only when the user has authorized installing software (pandoc, officecli) on this machine.",
			"After install, the report shows per-installer outcomes (installed+detected / installer failed with reason); a fresh terminal is not required.",
		],
		parameters: Type.Object({
			install: Type.Optional(
				Type.Boolean({
					description:
						"true = 自动安装缺失的可安装依赖（pandoc 走 winget、officecli 走官方脚本）；默认 false 只体检不安装",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			let deps = checkDeps();
			let installLog: string[] = [];
			if (params.install === true) {
				const outcomes = await installMissing(deps, signal);
				deps = checkDeps();
				installLog = ["## 安装执行结果", ""];
				if (!outcomes.length) {
					installLog.push("无需安装（体检时无缺失项）。");
				} else {
					for (const o of outcomes) {
						const state = o.detected ? "✅ 已安装并识别" : o.ranOk ? "⚠️ 安装器执行完成但仍未识别" : "❌ 安装器执行失败";
						installLog.push(`- ${o.name}: ${state}`);
						if (!o.detected && o.note) installLog.push(`  ${o.note}`);
					}
					const fixed = outcomes.filter((o) => o.detected).map((o) => o.name);
					if (fixed.length) installLog.push("", `已修复: ${fixed.join("、")}`);
				}
				const still = deps.filter((d) => !d.ok);
				if (still.length) installLog.push("", `仍缺失: ${still.map((d) => d.name).join("、")}`);
			}
			const report = depsReport(deps);
			const body = [report, installLog.join("\n")].filter(Boolean).join("\n\n");
			const details: Record<string, unknown> = {
				statuses: deps.map((d) => ({ name: d.name, ok: d.ok, version: d.version, path: d.path })),
				allReady: deps.every((d) => d.ok),
			};
			return toolResult(body, details);
		},
	});
}
