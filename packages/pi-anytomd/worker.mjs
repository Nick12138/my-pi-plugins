/**
 * worker.mjs — AnyToMD 转换引擎（纯 Node，无 pi 依赖）。
 *
 * 运行模式：
 *   node worker.mjs --spec <spec.json>   同步转换：读 spec → 转换 → stdout 输出 JSON {ok, text, details}
 *   node worker.mjs --job <jobDir>       异步任务：驱动 job.json 生命周期（并发槽/心跳/取消/超时）
 *   node worker.mjs --deps               依赖体检 JSON（anytomd_setup 数据源）
 *   node worker.mjs --install            自动安装缺失依赖后复检（anytomd_setup install=true）
 *
 * 密码约定（对应 myagents-anydoc 的“不落盘”原则）：
 *   密码只经环境变量 ANYTOMD_PASSWORD / ANYTOMD_JOB_PASSWORD 传入，绝不写入 spec/job.json/log。
 */

import { execFile, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	readdirSync,
	mkdtempSync,
	utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 300;
const SCAN_TIMEOUT_SEC = 900;
const MIN_TEXT_CHARS = 10;
const MAX_GARBLE_RATIO = 0.3;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff"]);
const OFFICE_NATIVE = new Set([".docx", ".xlsx", ".pptx"]);
const PANDOC_NATIVE = new Map([
	[".odt", "odt"],
	[".epub", "epub"],
	[".rtf", "rtf"],
	[".csv", "csv"],
	[".tsv", "tsv"],
]);
const LEGACY_WORD = new Set([".doc", ".wps"]);
const LEGACY_EXCEL = new Set([".xls", ".et", ".ods"]);
const LEGACY_PPT = new Set([".ppt", ".dps", ".odp"]);
const READABLE_TEXT = new Set([".txt", ".md", ".markdown"]);

const EXIT_HINTS = {
	100: "WPS 未登录：请在 WPS 桌面端登录账号后重试。",
	101: "账号权限不足：该转换通常需要 WPS 会员/超级会员，或当前账号未开通对应服务。",
	202: "wpscli 不认识的参数（内部自动重试修正）。",
	203: "文件不存在或路径不可读。",
	207: "输入文件超过 200MB，wpscli 拒绝处理。",
	209: "文档已加密且缺少打开密码（请传入 password 参数）。",
	210: "文档打开密码错误。",
	211: "输出目录不存在或不可写。",
	218: "格式不受 wpscli 原生支持（已尝试降级或转备用链路）。",
};

// ---------------------------------------------------------------------------
// CLI 探测与调用
// ---------------------------------------------------------------------------

function runSync(cmd, args, timeoutMs = 15000) {
	const res = spawnSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs, windowsHide: true });
	return String(res.stdout ?? "").trim();
}

function whereFirst(name) {
	const out = runSync("where", [name]);
	return out.split(/\r?\n/)[0]?.trim() ?? "";
}

function versionOf(exe) {
	const out = runSync(exe, ["--version"], 15000);
	return out.split(/\r?\n/)[0]?.trim() ?? "";
}

let wpscliCache = null;
let wpscliVersionCache = null;

function isRunnableWpscli(exe) {
	return runSync(exe, ["--version"], 15000).length > 0;
}

function wpsVersionFromPath(exe) {
	const m = exe.match(/[\\/]WPS Office[\\/](\d+\.\d+\.\d+(?:\.\d+)?)/i);
	return m ? m[1] : "";
}

function isNewerVersion(a, b) {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

function findWpscli() {
	if (wpscliCache) return wpscliCache;
	const candidates = [];
	const add = (p) => {
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
		try {
			for (const entry of readdirSync(root)) {
				if (!/^\d+\.\d+/.test(entry)) continue;
				add(path.join(root, entry, "clitool", "wpscli.exe"));
			}
		} catch {
			// ignore
		}
	}
	if (candidates.length === 0) {
		throw new Error(
			"找不到 wpscli：请安装 WPS Office，或设置 WPSCLI_PATH 指向 wpscli.exe。"
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

function wpscliVersion() {
	if (wpscliVersionCache) return wpscliVersionCache;
	try {
		wpscliVersionCache = versionOf(findWpscli());
	} catch {
		wpscliVersionCache = "";
	}
	return wpscliVersionCache ?? "";
}

function pushCandidate(list, p) {
	const abs = p?.trim();
	if (!abs || !existsSync(abs)) return;
	if (!list.some((c) => c.toLowerCase() === abs.toLowerCase())) list.push(abs);
}

function pickRunnable(candidates) {
	return candidates.find((c) => versionOf(c)) ?? candidates[0];
}

let officecliCache = null;
let officecliVersionCache = null;
function findOfficecli() {
	if (officecliCache) return officecliCache;
	const candidates = [];
	for (const p of whereFirst("officecli").split(/\r?\n/)) pushCandidate(candidates, p);
	pushCandidate(candidates, path.join(os.homedir(), "AppData", "Local", "OfficeCLI", "officecli.exe"));
	if (!candidates.length) throw new Error("找不到 officecli：运行 anytomd_setup({ install: true }) 自动安装。");
	const exe = pickRunnable(candidates);
	officecliCache = exe;
	officecliVersionCache = versionOf(exe);
	return exe;
}

function officecliVersion() {
	if (!officecliCache) try { findOfficecli(); } catch { return ""; }
	return officecliVersionCache ?? "";
}

let pandocCache = null;
function findPandoc() {
	if (pandocCache) return pandocCache;
	const candidates = [];
	for (const p of whereFirst("pandoc").split(/\r?\n/)) pushCandidate(candidates, p);
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
	} catch { /* ignore */ }
	if (!candidates.length) throw new Error("找不到 pandoc：运行 anytomd_setup({ install: true }) 自动安装。");
	pandocCache = pickRunnable(candidates);
	return pandocCache;
}

async function runCmd(exe, args, opts = {}) {
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
		const e = err;
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

const WPS_NO_EXTRA = new Set(["pdfinfo"]);

async function runWps(args, opts = {}) {
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

function parseWpsResult(res) {
	const text = (res.stdout.trim() || res.stderr.trim()).trim();
	let parsed = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			const brace = text.lastIndexOf("{");
			if (brace >= 0) {
				try {
					parsed = JSON.parse(text.slice(brace));
				} catch {
					parsed = null;
				}
			}
		}
	}
	return { text, parsed };
}

// ---------------------------------------------------------------------------
// 百度 OCR
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_ENDPOINTS = {
	general: "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic",
	accurate: "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic",
};
const BASE64_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 10;

const tokenCache = new Map();
let tokenInflight = null;
let tokenInflightKey = "";

function ocrSignal(signal) {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postForm(url, data, signal) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(data).toString(),
		signal: ocrSignal(signal),
	});
	const text = await res.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	return parsed;
}

async function getAccessTokenCached(apiKey, secretKey) {
	const cacheKey = `${apiKey}\u0000${secretKey}`;
	const hit = tokenCache.get(cacheKey);
	if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
	if (tokenInflight && tokenInflightKey === cacheKey) return tokenInflight;
	tokenInflightKey = cacheKey;
	tokenInflight = (async () => {
		const data = await postForm(
			TOKEN_URL,
			{ grant_type: "client_credentials", client_id: apiKey, client_secret: secretKey },
			undefined
		);
		if (!data.access_token) {
			throw new Error(`Access token failed: ${data.error_description || data.error || "unknown error"}`);
		}
		tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 2592000) * 1000 });
		return data.access_token;
	})().finally(() => {
		tokenInflight = null;
		tokenInflightKey = "";
	});
	return tokenInflight;
}

function baiduErrorHint(code, msg) {
	const hints = {
		4: "集群超限额，稍后重试",
		17: "当日可用额度已用尽（免费测试资源已耗尽）",
		18: "QPS 超限（未付费账号 2 QPS）",
		19: "请求总量超限",
		216102: "图片格式不支持（jpg/png/bmp/gif）",
		216103: "图片太小或质量过差",
		216200: "图片为空或格式错误",
		216202: "图片大小错误（base64 ≤ 4MB）",
		216630: "图片模糊/过暗",
		216631: "识别失败（图片质量问题）",
	};
	const base = `Baidu OCR error ${code}: ${msg || "unknown"}`;
	const hint = hints[code];
	return hint ? `${base} —— ${hint}` : base;
}

function ocrCredentials() {
	const apiKey = process.env.BAIDU_OCR_API_KEY?.trim();
	const secretKey = process.env.BAIDU_OCR_SECRET_KEY?.trim();
	if (!apiKey || !secretKey) {
		return {
			error: "BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY 未配置——在插件配置页填写，或运行 anytomd_setup 查看状态。",
		};
	}
	return { apiKey, secretKey };
}

async function callOcr(url, params, signal) {
	const creds = ocrCredentials();
	if ("error" in creds) throw new Error(creds.error);
	const token = await getAccessTokenCached(creds.apiKey, creds.secretKey);
	let result = await postForm(`${url}?access_token=${encodeURIComponent(token)}`, params, signal);
	if (result.error_code != null && [100, 110, 111].includes(result.error_code)) {
		tokenCache.delete(`${creds.apiKey}\u0000${creds.secretKey}`);
		const fresh = await getAccessTokenCached(creds.apiKey, creds.secretKey);
		result = await postForm(`${url}?access_token=${encodeURIComponent(fresh)}`, params, signal);
	}
	if (result.error_code != null) throw new Error(baiduErrorHint(result.error_code, result.error_msg || ""));
	return result;
}

async function recognizeGeneral(imagePath, accuracy, signal) {
	const abs = path.resolve(imagePath);
	const encoded = readFileSync(abs).toString("base64");
	if (encoded.length > BASE64_LIMIT) {
		throw new Error(`图片 base64 超过 4MB（${Math.round(encoded.length / 1024 / 1024)}MB）——压缩后再试。`);
	}
	const endpoint = accuracy === "accurate" ? OCR_ENDPOINTS.accurate : OCR_ENDPOINTS.general;
	const result = await callOcr(endpoint, { image: encoded, detect_direction: "true", paragraph: "true", probability: "true" }, signal);
	return (result.words_result ?? []).map((i) => i.words ?? "").join("\n").trim();
}

async function mapWithConcurrency(items, limit, worker) {
	const results = new Array(items.length);
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

async function ocrImages(imagePaths, accuracy, concurrency, signal) {
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
// 质量门与辅助工具
// ---------------------------------------------------------------------------

function plainLength(md) {
	return md
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
		.replace(/[#>*_~|`\-=\[\](){}:;,.!?'"\\/\d\s]/g, "")
		.trim();
}

function textQualityOk(md) {
	const plain = plainLength(md);
	if (plain.length < MIN_TEXT_CHARS) return false;
	const garble = (md.match(/\uFFFD/g) ?? []).length;
	return garble / Math.max(1, md.length) < MAX_GARBLE_RATIO;
}

function readMdFile(file) {
	const raw = readFileSync(file, "utf-8");
	return raw.replace(/^\uFEFF/, "");
}

function makeTmpDir(workspace) {
	const base = path.join(workspace || process.cwd(), "Agent临时工作", "temporary");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(path.join(base, "anytomd-"));
}

function removeTmpDir(tmpDir) {
	const rm = () => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	};
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

function saveMarkdown(md, outputPath) {
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

// ---------------------------------------------------------------------------
// 转换核心流程
// ---------------------------------------------------------------------------

async function docxToMd(docx, tmpDir, signal) {
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
	try {
		const res = await officecliView(docx, signal);
		if (res.ok && textQualityOk(res.stdout)) return { md: res.stdout, route: "officecli view text" };
	} catch {
		// ignore
	}
	throw new Error("docx → md 失败（pandoc 与 officecli 均不可用或结果为空）");
}

async function officecliView(file, signal) {
	const officecli = findOfficecli();
	const ext = path.extname(file);
	const copy = path.join(
		os.tmpdir(),
		`anytomd-officecli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
	);
	copyFileSync(file, copy);
	try {
		return await runCmd(officecli, ["view", copy, "text"], { timeoutSec: DEFAULT_TIMEOUT_SEC, signal });
	} finally {
		try {
			await runCmd(officecli, ["close", copy], { timeoutSec: 30, signal });
		} catch {
			// ignore
		}
		try {
			rmSync(copy, { force: true });
		} catch {
			// ignore
		}
	}
}

/** pandoc 原生支持格式（.odt, .epub, .rtf, .csv, .tsv） */
async function pandocNativeToMd(file, reader, tmpDir, signal) {
	const pandoc = findPandoc();
	const mdOut = path.join(tmpDir, `pandoc_${path.basename(file)}.md`);
	const args = [file, "-f", reader, "-t", "gfm", "-o", mdOut];
	const res = await runCmd(pandoc, args, { timeoutSec: DEFAULT_TIMEOUT_SEC, signal });
	if (!res.ok) throw new Error(`pandoc (${reader}) 转换失败: ${res.error || res.stderr}`);
	if (!existsSync(mdOut)) throw new Error(`pandoc 未产出 md 文件`);
	const md = readMdFile(mdOut);
	return { md, route: `pandoc (reader: ${reader})` };
}

async function imagesViaWps(images, tmpDir, rangeHint, signal) {
	if (images.length === 1) {
		const outDocx = path.join(tmpDir, "single.docx");
		const res = await runWps(["photo2word", images[0], "-o", outDocx], { timeoutSec: SCAN_TIMEOUT_SEC, signal });
		if (!res.ok) throw new Error(`photo2word 失败：${res.error}`);
		if (!existsSync(outDocx)) throw new Error("photo2word 未产出 docx");
		const md = await docxToMd(outDocx, tmpDir, signal);
		return { ...md, route: `wps photo2word → ${md.route}` };
	}
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

async function officeToMd(file, tmpDir, password, signal) {
	const ext = path.extname(file).toLowerCase();

	// 如果没有密码，优先尝试 officecli/pandoc 快速读取
	if (!password && OFFICE_NATIVE.has(ext)) {
		try {
			const res = await officecliView(file, signal);
			if (res.ok && textQualityOk(res.stdout)) return { md: res.stdout, route: "officecli view text" };
		} catch {
			// fall through
		}
		if (ext === ".docx") {
			try {
				return await docxToMd(file, tmpDir, signal);
			} catch {
				// fall through to wps chain
			}
		}
	}

	// 走 wps 转换链路（支持 password）
	const toPdfSub = LEGACY_EXCEL.has(ext) || ext === ".xlsx"
		? "excel2pdf"
		: LEGACY_PPT.has(ext) || ext === ".pptx"
		? "ppt2pdf"
		: "word2pdf";

	const pdfOut = path.join(tmpDir, `legacy_${path.basename(file, ext)}.pdf`);
	const args = [toPdfSub, file, "-o", pdfOut];
	if (password) args.push("--password", password);

	try {
		const res = await runWps(args, { timeoutSec: SCAN_TIMEOUT_SEC, signal });
		if (!res.ok) throw new Error(`${toPdfSub} 失败：${res.error}`);
		if (!existsSync(pdfOut)) throw new Error(`${toPdfSub} 未产出 pdf`);
		return await pdfTextToMd(pdfOut, tmpDir, signal, undefined, password);
	} finally {
		rmSync(pdfOut, { force: true });
	}
}

async function wpsPdfInfo(file, password) {
	const args = ["pdfinfo", file];
	if (password) args.push("--password", password);
	const res = await runWps(args, { timeoutSec: 60 });
	const { text, parsed } = parseWpsResult(res);
	const rec = parsed && typeof parsed === "object" ? parsed : {};
	const get = (keys) => {
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

async function pdfTextToMd(pdf, tmpDir, signal, range, password) {
	const mdOut = path.join(tmpDir, "pdf.md");
	try {
		const args = ["pdf2md", pdf, "-o", mdOut];
		if (range && /^\d+(-\d+)?$/.test(range)) args.push("--range", range);
		if (password) args.push("--password", password);
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

async function pdfScannedToMd(pdf, pages, range, tmpDir, password, signal) {
	const outDocx = path.join(tmpDir, "scanned.docx");
	const useRange = range && /^\d+(-\d+)?$/.test(range) ? range : `1-${Math.max(1, pages)}`;
	const args = ["pdf2word", pdf, "--scanned", "true", "--range", useRange, "-o", outDocx];
	if (password) args.push("--password", password);
	const res = await runWps(args, { timeoutSec: SCAN_TIMEOUT_SEC, signal });
	if (!res.ok) throw new Error(`pdf2word(扫描) 失败：${res.error}`);
	if (!existsSync(outDocx)) throw new Error("pdf2word 未产出 docx");
	const md = await docxToMd(outDocx, tmpDir, signal);
	return { ...md, route: `wps pdf2word(扫描 OCR) → ${md.route}` };
}

async function pdfOcrToMd(pdf, accuracy, concurrency, tmpDir, password, signal) {
	const outDir = path.join(tmpDir, "pages");
	mkdirSync(outDir, { recursive: true });
	const args = ["pdf2photo", pdf, "-o", outDir, "--suffix", "jpg", "--image-quality", "high"];
	if (password) args.push("--password", password);
	const res = await runWps(args, { timeoutSec: SCAN_TIMEOUT_SEC, signal });
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

async function pdfToMd(pdf, opts) {
	const { range, method, accuracy, concurrency, tmpDir, password, signal } = opts;
	if (method === "ocr") return pdfOcrToMd(pdf, accuracy, concurrency, tmpDir, password, signal);

	let info;
	try {
		info = await wpsPdfInfo(pdf, password);
	} catch {
		info = { pages: 0, scanned: false };
	}

	if (info.scanned) {
		try {
			return await pdfScannedToMd(pdf, info.pages, range, tmpDir, password, signal);
		} catch (err) {
			if (method === "wps") throw err;
			const note = err instanceof Error ? err.message : String(err);
			try {
				const ocr = await pdfOcrToMd(pdf, accuracy, concurrency, tmpDir, password, signal);
				return { ...ocr, route: `${ocr.route}（扫描件 WPS 失败后降级: ${note.slice(0, 120)}）` };
			} catch {
				throw err;
			}
		}
	}

	try {
		return await pdfTextToMd(pdf, tmpDir, signal, range, password);
	} catch (err) {
		if (method === "wps") throw err;
		const note = err instanceof Error ? err.message : String(err);
		try {
			const scanned = await pdfScannedToMd(pdf, info.pages || 1, range, tmpDir, password, signal);
			return { ...scanned, route: `${scanned.route}（文字提取为空，按扫描件重试）` };
		} catch {
			try {
				const ocr = await pdfOcrToMd(pdf, accuracy, concurrency, tmpDir, password, signal);
				return { ...ocr, route: `${ocr.route}（pdf2md 为空后降级: ${note.slice(0, 120)}）` };
			} catch {
				throw err;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 统一入口：convertSpec
// ---------------------------------------------------------------------------

async function convertSpec(spec, signal) {
	const workspace = spec.workspace || process.cwd();
	const rawPaths = spec.paths || (spec.file ? [spec.file] : []);
	const paths = [...new Set(rawPaths.map((p) => path.resolve(workspace, p.trim())).filter(Boolean))];
	if (!paths.length) throw new Error("输入路径不能为空");

	const missing = paths.filter((p) => !existsSync(p));
	if (missing.length) throw new Error(`文件不存在：${missing.join("、")}`);

	const method = spec.method ?? "auto";
	const accuracy = spec.accuracy === "accurate" ? "accurate" : "standard";
	const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(spec.concurrency ?? DEFAULT_CONCURRENCY)));
	const password = spec.password || process.env.ANYTOMD_PASSWORD || process.env.ANYTOMD_JOB_PASSWORD || undefined;

	const tmpDir = makeTmpDir(workspace);
	const sections = [];
	const detailsPerFile = [];
	let anySuccess = false;

	try {
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
						const flow = await imagesViaWps(images, tmpDir, spec.range, signal);
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

		for (const file of others) {
			const ext = path.extname(file).toLowerCase();
			const header = `## 来源：${file}`;
			try {
				let flow;
				if (ext === ".pdf") {
					flow = await pdfToMd(file, { range: spec.range, method, accuracy, concurrency, tmpDir, password, signal });
				} else if (READABLE_TEXT.has(ext)) {
					const md = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
					flow = { md, route: "direct read" };
				} else if (PANDOC_NATIVE.has(ext)) {
					// 核心补全：ODT, EPUB, RTF, CSV, TSV 走 pandoc
					flow = await pandocNativeToMd(file, PANDOC_NATIVE.get(ext), tmpDir, signal);
				} else {
					// docx, xlsx, pptx 及 legacy doc/xls/ppt/ods/odp
					flow = await officeToMd(file, tmpDir, password, signal);
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

	const body = sections
		.map((s) => {
			const parts = [];
			if (s.header) parts.push(s.header);
			if (s.route) parts.push(`> 处理链路：${s.route}`);
			if (s.error) parts.push(`\n> ⚠️ 读取失败：${s.error}`);
			parts.push(s.md || "");
			return parts.filter(Boolean).join("\n\n");
		})
		.join("\n\n---\n\n");

	let finalText = body;
	const details = {
		method,
		accuracy,
		concurrency,
		files: detailsPerFile,
		anySuccess,
	};

	if (spec.outputPath) {
		const out = path.isAbsolute(spec.outputPath)
			? spec.outputPath
			: path.join(workspace, "Agent临时工作", "output", spec.outputPath);
		try {
			const savedTo = saveMarkdown(body, out);
			details.output = savedTo;
			finalText = `${body}\n\n已落盘: ${savedTo}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			details.outputError = msg;
			finalText = `${body}\n\n落盘失败: ${msg}`;
		}
	}

	if (!anySuccess) {
		const hints = [];
		if (paths.some((p) => IMAGE_EXTS.has(path.extname(p).toLowerCase()))) {
			hints.push('fallback="see_image"（用视觉工具看图兜底）');
		}
		finalText = `${finalText}\n\n> 全部链路失败。${hints.join("；") || "请检查文件格式或依赖配置。"}`;
	}

	return { ok: anySuccess, text: finalText, details, body };
}

// ---------------------------------------------------------------------------
// 依赖检测与安装模式
// ---------------------------------------------------------------------------

function checkDeps() {
	const statuses = [];
	try {
		const wps = findWpscli();
		statuses.push({ name: "wpscli", ok: true, version: wpscliVersion(), path: wps, detail: "WPS Office 自带" });
	} catch (err) {
		statuses.push({ name: "wpscli", ok: false, version: "", path: "", detail: err instanceof Error ? err.message : String(err) });
	}

	try {
		const off = findOfficecli();
		statuses.push({ name: "officecli", ok: true, version: officecliVersion(), path: off, detail: "" });
	} catch (err) {
		statuses.push({ name: "officecli", ok: false, version: "", path: "", detail: "未安装" });
	}

	try {
		const pan = findPandoc();
		statuses.push({ name: "pandoc", ok: true, version: versionOf(pan), path: pan, detail: "" });
	} catch (err) {
		statuses.push({ name: "pandoc", ok: false, version: "", path: "", detail: err instanceof Error ? err.message : String(err) });
	}

	const ocrKeys = ocrCredentials();
	if ("apiKey" in ocrKeys) {
		statuses.push({ name: "百度 OCR Key", ok: true, version: "", path: "", detail: "已配置" });
	} else {
		statuses.push({ name: "百度 OCR Key", ok: false, version: "", path: "", detail: ocrKeys.error });
	}
	return statuses;
}

function refreshProcessPathFromRegistry() {
	const out = runSync("powershell", [
		"-NoProfile",
		"-Command",
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
			"[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine')) + ';' + " +
			"[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','User'))",
	], 15000);
	if (!out) return;
	const current = (process.env.PATH ?? "").split(";").filter(Boolean);
	const seen = new Set(current.map((p) => p.toLowerCase().replace(/[\\/]+$/, "")));
	const extra = out
		.split(";")
		.map((p) => p.trim())
		.filter((p) => p && !seen.has(p.toLowerCase().replace(/[\\/]+$/, "")));
	if (extra.length) process.env.PATH = [...current, ...extra].join(";");
}

async function installMissing(deps, signal) {
	const outcomes = [];
	const office = deps.find((d) => d.name === "officecli" && !d.ok);
	const pandoc = deps.find((d) => d.name === "pandoc" && !d.ok);

	if (office) {
		const r = await runCmd("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://d.officecli.ai/install.ps1 | iex"], {
			timeoutSec: 600,
			signal,
		});
		outcomes.push({ name: "officecli", ranOk: r.ok, detected: false, note: r.error || r.stderr || "" });
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
		outcomes.push({ name: "pandoc", ranOk: r.ok, detected: false, note: r.error || r.stderr || "" });
	}
	if (outcomes.length) {
		refreshProcessPathFromRegistry();
		const recheck = checkDeps();
		for (const o of outcomes) {
			o.detected = recheck.find((d) => d.name === o.name)?.ok === true;
		}
	}
	return outcomes;
}

// ---------------------------------------------------------------------------
// 异步 Job 管理模式
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_JOBS = parseInt(process.env.ANYTOMD_MAX_CONCURRENT || "16", 10);
const JOB_DEADLINE_SEC = parseInt(process.env.ANYTOMD_JOB_DEADLINE_SEC || "1800", 10);
const STALE_HEARTBEAT_SEC = 60;

function isProcessAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function countActiveJobs(jobsDir, selfJobId) {
	let count = 0;
	try {
		for (const entry of readdirSync(jobsDir)) {
			if (entry === selfJobId) continue;
			const jobJson = path.join(jobsDir, entry, "job.json");
			const hbFile = path.join(jobsDir, entry, "heartbeat");
			if (!existsSync(jobJson)) continue;
			try {
				const meta = JSON.parse(readFileSync(jobJson, "utf-8"));
				if (meta.status === "running") {
					// stale 检查
					let alive = isProcessAlive(meta.pid);
					if (existsSync(hbFile)) {
						const age = (Date.now() - readFileSync(hbFile).length) / 1000; // fallback
					}
					if (alive) count++;
				}
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
	return count;
}

async function runJobMode(jobDir) {
	const jobJsonPath = path.join(jobDir, "job.json");
	const hbPath = path.join(jobDir, "heartbeat");
	const cancelFlagPath = path.join(jobDir, "cancel.flag");
	const resultMdPath = path.join(jobDir, "result.md");
	const detailsJsonPath = path.join(jobDir, "details.json");

	if (!existsSync(jobJsonPath)) {
		console.error(`job.json 不存在: ${jobJsonPath}`);
		process.exit(1);
	}

	const meta = JSON.parse(readFileSync(jobJsonPath, "utf-8"));
	const jobsDir = path.dirname(jobDir);
	const selfId = meta.id;

	const updateMeta = (patch) => {
		Object.assign(meta, patch);
		writeFileSync(jobJsonPath, JSON.stringify(meta, null, 2), "utf-8");
	};

	// 1. 等待并发槽（自调节队列）
	while (countActiveJobs(jobsDir, selfId) >= MAX_CONCURRENT_JOBS) {
		if (existsSync(cancelFlagPath)) {
			updateMeta({ status: "cancelled", finishedAt: new Date().toISOString() });
			process.exit(0);
		}
		await new Promise((r) => setTimeout(r, 2000));
	}

	if (existsSync(cancelFlagPath)) {
		updateMeta({ status: "cancelled", finishedAt: new Date().toISOString() });
		process.exit(0);
	}

	// 2. 标记 running，启动心跳
	updateMeta({
		status: "running",
		pid: process.pid,
		startedAt: new Date().toISOString(),
	});

	writeFileSync(hbPath, String(Date.now()), "utf-8");
	const hbTimer = setInterval(() => {
		try {
			writeFileSync(hbPath, String(Date.now()), "utf-8");
		} catch {
			// ignore
		}
	}, 3000);

	// 3. 执行转换（带 deadline 超时）
	const abortCtrl = new AbortController();
	const deadlineTimer = setTimeout(() => {
		abortCtrl.abort("job deadline exceeded");
	}, JOB_DEADLINE_SEC * 1000);

	try {
		const res = await convertSpec(meta.spec, abortCtrl.signal);
		clearTimeout(deadlineTimer);
		clearInterval(hbTimer);

		// 写入最终产物
		writeFileSync(resultMdPath, res.body || res.text, "utf-8");
		writeFileSync(detailsJsonPath, JSON.stringify(res.details, null, 2), "utf-8");

		updateMeta({
			status: res.ok ? "succeeded" : "failed",
			finishedAt: new Date().toISOString(),
			resultPath: resultMdPath,
			outputPath: res.details.output || undefined,
			error: res.ok ? undefined : "全部链路转换失败",
		});
		process.exit(res.ok ? 0 : 1);
	} catch (err) {
		clearTimeout(deadlineTimer);
		clearInterval(hbTimer);

		const isCancel = existsSync(cancelFlagPath) || abortCtrl.signal.aborted;
		const finalStatus = isCancel ? "cancelled" : "failed";
		const errMsg = err instanceof Error ? err.message : String(err);

		updateMeta({
			status: finalStatus,
			finishedAt: new Date().toISOString(),
			error: errMsg,
		});
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	const mode = args[0];

	if (mode === "--deps") {
		const deps = checkDeps();
		const allOk = deps.every((d) => d.ok);
		process.stdout.write(JSON.stringify({ deps, allOk }) + "\n");
		return;
	}

	if (mode === "--install") {
		const deps = checkDeps();
		const outcomes = await installMissing(deps);
		const recheck = checkDeps();
		process.stdout.write(JSON.stringify({ outcomes, deps: recheck, allOk: recheck.every((d) => d.ok) }) + "\n");
		return;
	}

	if (mode === "--job") {
		const jobDir = args[1];
		if (!jobDir) {
			console.error("用法: node worker.mjs --job <jobDir>");
			process.exit(1);
		}
		await runJobMode(path.resolve(jobDir));
		return;
	}

	if (mode === "--spec") {
		const specFile = args[1];
		if (!specFile) {
			console.error("用法: node worker.mjs --spec <spec.json>");
			process.exit(1);
		}
		const spec = JSON.parse(readFileSync(specFile, "utf-8"));
		try {
			const res = await convertSpec(spec);
			process.stdout.write(JSON.stringify(res) + "\n");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stdout.write(JSON.stringify({ ok: false, text: `读取失败: ${msg}`, details: { error: msg } }) + "\n");
		}
		return;
	}

	console.error("未知命令。可用模式: --spec <file>, --job <dir>, --deps, --install");
	process.exit(1);
}

main().catch((err) => {
	console.error("Fatal worker error:", err);
	process.exit(1);
});
