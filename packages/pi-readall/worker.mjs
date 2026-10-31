/**
 * worker.mjs — pi-readall 转换引擎（纯 Node，无 pi 依赖）。
 *
 * 设计原则（与 pi-anytomd worker 的差异）：
 *   - OCR 主力：图片/扫描件一律先走 WPS OCR（图片 → photo2word 分张；PDF → pdf2word --scanned）；
 *   - 多张图片不合并：photo2word 一张一个 docx，结果按原文件名分段，来源可追溯
 *     （合并后整本 OCR 会把多张图内容串页，且定位不到段落出处）；
 *   - 无百度 OCR：原「百度降级」位由「视觉兜底」替代 —— worker 不接触模型注册表，
 *     只负责把需要视觉识别的页面/图片切好（pdf2photo），在结果里返回
 *     needsVision = { images, reason }，由扩展层（有 modelRegistry）执行视觉队列；
 *   - method 三档：auto（WPS 优先，失败视觉兜底）/ wps（只走 WPS）/ vision（强制视觉）。
 *
 * 运行模式：
 *   node worker.mjs --spec <spec.json>   同步转换：读 spec → 转换 → stdout JSON {ok,text,details,needsVision}
 *   node worker.mjs --job <jobDir>       异步任务：驱动 job.json 生命周期（心跳/取消/超时）
 *   node worker.mjs --deps               依赖体检 JSON（readall setup 数据源）
 *   node worker.mjs --install            自动安装缺失依赖后复检（pandoc / officecli）
 *
 * 密码约定（继承 anytomd 的「不落盘」原则）：
 *   密码只经环境变量 READALL_PASSWORD / READALL_JOB_PASSWORD 传入，绝不写入 spec/job.json/log。
 *
 * 注意：异步 job 模式跑在分离进程里，无法访问 pi 的模型注册表，因此 WPS 失败时
 * 不会做视觉兜底（任务失败并提示改用同步 read）。视觉兜底仅在同步 read 可用。
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
} from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { appendUsccWarnings } from "./checks.mjs";

const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 300;
const SCAN_TIMEOUT_SEC = 900;
const MIN_TEXT_CHARS = 10;
const MAX_GARBLE_RATIO = 0.3;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff", ".webp"]);
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
	if (fromEnv) {
		const envVersion = versionOf(fromEnv);
		if (envVersion) {
			wpscliCache = fromEnv;
			wpscliVersionCache = envVersion;
			return fromEnv;
		}
	}
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
		throw new Error("找不到 wpscli：请安装 WPS Office，或设置 WPSCLI_PATH 指向 wpscli.exe。");
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
	if (wpscliVersionCache != null) return wpscliVersionCache;
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
	for (const c of candidates) {
		const version = versionOf(c);
		if (version) return { exe: c, version };
	}
	return { exe: candidates[0], version: "" };
}

let officecliCache = null;
let officecliVersionCache = null;
function findOfficecli() {
	if (officecliCache) return officecliCache;
	const candidates = [];
	for (const p of whereFirst("officecli").split(/\r?\n/)) pushCandidate(candidates, p);
	pushCandidate(candidates, path.join(os.homedir(), "AppData", "Local", "OfficeCLI", "officecli.exe"));
	if (!candidates.length) throw new Error("找不到 officecli：运行 readall({ action: \"setup\", install: true }) 自动安装。");
	const picked = pickRunnable(candidates);
	officecliCache = picked.exe;
	officecliVersionCache = picked.version;
	return picked.exe;
}

function officecliVersion() {
	if (!officecliCache) try { findOfficecli(); } catch { return ""; }
	return officecliVersionCache ?? "";
}

let pandocCache = null;
let pandocVersionCache = null;
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
	if (!candidates.length) throw new Error("找不到 pandoc：运行 readall({ action: \"setup\", install: true }) 自动安装。");
	const picked = pickRunnable(candidates);
	pandocCache = picked.exe;
	pandocVersionCache = picked.version;
	return pandocCache;
}

function pandocVersion() {
	if (!pandocCache) try { findPandoc(); } catch { return ""; }
	return pandocVersionCache ?? "";
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
// 质量门与辅助工具
// ---------------------------------------------------------------------------

function plainLength(md) {
	return md
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
		// 保留数字：纯数字表格（金额、台账）不能被当成空文本
		.replace(/[#>*_~|`\-=\[\](){}:;,.!?'"\\/\s]/g, "")
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
	return mkdtempSync(path.join(base, "readall-"));
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

/**
 * 清掉 pandoc 从 docx 带出的非文字噪声：图片标签、空图片占位 `[]`、多余空行。
 * OCR 结果里这些只有干扰（WPS 的 docx 把每张证照都塞成内嵌图）。
 */
function stripDocxArtifacts(text) {
	return text
		.replace(/<img\b[^>]*>/gi, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\]/g, "")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * docx → 文字/标记。
 *   opts.plain=true（OCR 用）：pandoc -t plain --wrap=none，只留纯文字，来源干净可核对
 *   默认（用户提交的 Office 文档）：gfm，保留标题/表格结构
 */
async function docxToMd(docx, tmpDir, signal, opts = {}) {
	const plain = opts.plain === true;
	const tag = `${path
		.basename(docx, path.extname(docx))
		.replace(/[^\w.-]+/g, "_")
		.slice(0, 40)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
	const outFile = path.join(tmpDir, `${tag}.${plain ? "txt" : "md"}`);

	let pandoc = "";
	try {
		pandoc = findPandoc();
	} catch {
		pandoc = "";
	}
	if (pandoc) {
		const args = [docx, "-t", plain ? "plain" : "gfm", "-o", outFile];
		if (plain) args.push("--wrap=none");
		const res = await runCmd(pandoc, args, { timeoutSec: DEFAULT_TIMEOUT_SEC, signal });
		if (res.ok && existsSync(outFile)) {
			const raw = readMdFile(outFile);
			const md = plain ? stripDocxArtifacts(raw) : raw;
			if (textQualityOk(md)) return { md, route: plain ? "pandoc (plain)" : "pandoc" };
		}
	}
	try {
		const res = await officecliView(docx, signal);
		const text = plain ? stripDocxArtifacts(res.stdout ?? "") : (res.stdout ?? "");
		if (res.ok && textQualityOk(text)) return { md: text, route: "officecli view text" };
	} catch {
		// ignore
	}
	throw new Error("docx → md 失败（pandoc 与 officecli 均不可用或结果为空）");
}

/**
 * officecli 的 `view text` 会在每行前面加 XPath 定位前缀（如 `[/body/p[3]] `），
 * 对 OCR/阅读结果全是噪声。只剔「以 / 开头的中括号路径」，不动正文里的普通方括号。
 */
function stripOfficecliXpath(text) {
	return String(text)
		.replace(/\[(?=\/)(?:[^\[\]\n]|\[[^\]\n]*\])*\]\s*/g, "")
		.replace(/\n{3,}/g, "\n\n");
}

async function officecliView(file, signal) {
	const officecli = findOfficecli();
	const ext = path.extname(file);
	const copy = path.join(
		os.tmpdir(),
		`readall-officecli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
	);
	copyFileSync(file, copy);
	try {
		const res = await runCmd(officecli, ["view", copy, "text"], { timeoutSec: DEFAULT_TIMEOUT_SEC, signal });
		if (typeof res.stdout === "string") res.stdout = stripOfficecliXpath(res.stdout);
		return res;
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
	if (!existsSync(mdOut)) throw new Error("pandoc 未产出 md 文件");
	const md = readMdFile(mdOut);
	return { md, route: `pandoc (reader: ${reader})` };
}

/**
 * 图片（1 张或多张）走 WPS OCR。
 *
 * WPS 客户端的「图片转文字」在 CLI 侧的入口就是 photo2word（云 OCR）：
 *   主线   → photo2word <imgs...> -o <dir>/     不合并，一张一个 docx，按原文件名回配
 *   兜底   → photo2pdf 合并 → pdf2word --scanned 整本 OCR（多张时，photo2word 挂了才用）
 *
 * 为什么不用「合并后整本 OCR」：合并链路会把多张图的内容串页（两页字段混在一起），
 * 且结果里无法定位段落来源；分张 OCR 保留文件名，来源可追溯。
 *
 * 返回 { parts: [{ header, md, route }], route }，由 convertSpec 逐张推送 section。
 */
async function imagesViaWps(images, tmpDir, rangeHint, signal) {
	try {
		return await imagesViaPhoto2word(images, tmpDir, signal);
	} catch (err) {
		if (images.length === 1) throw err;
		const note = err instanceof Error ? err.message : String(err);
		const legacy = await imagesViaMergedPdf(images, tmpDir, rangeHint, signal);
		return {
			...legacy,
			route: `${legacy.route}（photo2word 分张失败，回退合并链路：${note.slice(0, 120)}）`,
		};
	}
}

/** 主线：photo2word 逐张出 docx → 逐张转文字，按原文件名分段。 */
async function imagesViaPhoto2word(images, tmpDir, signal) {
	const outDir = path.join(tmpDir, "photo2word");
	mkdirSync(outDir, { recursive: true });
	const res = await runWps(["photo2word", ...images, "-o", outDir + path.sep], {
		timeoutSec: SCAN_TIMEOUT_SEC,
		signal,
	});
	if (!res.ok) throw new Error(`photo2word 失败：${res.error}`);

	const docxFiles = readdirSync(outDir)
		.filter((f) => /\.(docx?|wps)$/i.test(f))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	if (!docxFiles.length) throw new Error("photo2word 未产出 docx");

	const parts = [];
	const used = new Set();
	for (const img of images) {
		const base = path.basename(img, path.extname(img));
		const stem = (f) => f.replace(/\.(docx?|wps)$/i, "");
		// 先精确同名，再容忍 WPS 的重名后缀 " (1)"，最后按剩余顺序兜底
		const pick =
			docxFiles.find((f) => !used.has(f) && stem(f) === base) ??
			docxFiles.find((f) => !used.has(f) && stem(f).replace(/ \(\d+\)$/, "") === base) ??
			docxFiles.find((f) => !used.has(f));
		if (!pick) break;
		used.add(pick);
		const header = `## 来源：${path.basename(img)}`;
		try {
			const md = await docxToMd(path.join(outDir, pick), tmpDir, signal, { plain: true });
			parts.push({ header, md: md.md, route: `wps photo2word → ${md.route}` });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			parts.push({ header, md: `> ⚠️ 该张 OCR 结果转文字失败：${msg}` });
		}
	}
	if (!parts.length) throw new Error("photo2word 结果无法转文字");

	const missing = images.length - parts.length;
	return {
		parts,
		route: `wps photo2word（分张 OCR ${parts.length}/${images.length} 张${missing > 0 ? `，${missing} 张无产物` : ""}）`,
	};
}

/** 兜底：photo2pdf 合并 → pdf2word(扫描 OCR) 整本识别。 */
async function imagesViaMergedPdf(images, tmpDir, rangeHint, signal) {
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
	const md = await docxToMd(outDocx, tmpDir, signal, { plain: true });
	const route = `wps photo2pdf→pdf2word(扫描 OCR, ${images.length} 张) → ${md.route}`;
	return { parts: [{ header: `## 来源：${images.length} 张图片（合并 OCR）`, md: md.md, route }], route };
}

async function officeToMd(file, tmpDir, password, signal) {
	const ext = path.extname(file).toLowerCase();

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

/**
 * 分批 OCR 的每批页数（READALL_OCR_PAGE_CHUNK，默认 20；0 = 不分批）。
 * 大 PDF 一把梭的风险：第 28 页超时/失败就整本报废，因此超过阈值自动切段。
 */
function ocrChunkSize() {
	const raw = process.env.READALL_OCR_PAGE_CHUNK;
	if (raw == null || raw.trim() === "") return 20;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return 20;
	return Math.min(n, 500);
}

/** 把 "1-5" / "8" 解成页区间（超出总页数的上界会被夹紧）。 */
function parseSpan(range, total) {
	if (range && /^\d+(-\d+)?$/.test(range.trim())) {
		const [a, b] = range.trim().split("-").map((x) => parseInt(x, 10));
		const from = Math.max(1, a);
		const to = Math.max(from, Math.min(b ?? a, Math.max(1, total)));
		return { from, to };
	}
	return { from: 1, to: Math.max(1, total) };
}

/** 按每批页数切段；size<=0 表示不分批。 */
function planPageChunks(from, to, size) {
	if (!size || size <= 0) return [{ from, to }];
	const chunks = [];
	for (let start = from; start <= to; start += size) {
		chunks.push({ from: start, to: Math.min(start + size - 1, to) });
	}
	return chunks;
}

function rangeArgOf(span) {
	return span.from === span.to ? String(span.from) : `${span.from}-${span.to}`;
}

/** 单段扫描 OCR：pdf2word --scanned → docx → 纯文字。 */
async function ocrPdfRange(pdf, span, tmpDir, password, signal, tag) {
	const outDocx = path.join(tmpDir, `scanned-${tag}.docx`);
	const args = ["pdf2word", pdf, "--scanned", "true", "--range", rangeArgOf(span), "-o", outDocx];
	if (password) args.push("--password", password);
	const res = await runWps(args, { timeoutSec: SCAN_TIMEOUT_SEC, signal });
	if (!res.ok) throw new Error(`pdf2word(扫描) 失败：${res.error}`);
	if (!existsSync(outDocx)) throw new Error("pdf2word 未产出 docx");
	return await docxToMd(outDocx, tmpDir, signal, { plain: true });
}

/**
 * 扫描件 PDF → 纯文字。
 *
 * 页数 ≤ READALL_OCR_PAGE_CHUNK：单次调用整本 OCR（原行为）。
 * 页数 > 阈值：按批切段，每段一次 pdf2word；单段失败不拖累其它段，
 * 失败段在 auto 模式下只把「这几页」切成图片交视觉兜底（不重跑成功段）。
 * method=wps（严格模式）时任何一段失败即整体报错。
 */
async function pdfScannedToMd(pdf, pages, range, tmpDir, password, signal, opts = {}) {
	const method = opts.method ?? "auto";
	const total = Math.max(1, pages);
	const span = parseSpan(range, total);
	const chunks = planPageChunks(span.from, span.to, ocrChunkSize());

	if (chunks.length === 1) {
		const md = await ocrPdfRange(pdf, chunks[0], tmpDir, password, signal, "whole");
		return { ...md, route: `wps pdf2word(扫描 OCR, ${total} 页) → ${md.route}` };
	}

	const parts = [];
	const failures = [];
	for (const c of chunks) {
		try {
			const md = await ocrPdfRange(pdf, c, tmpDir, password, signal, `${c.from}-${c.to}`);
			parts.push(`【第 ${c.from}-${c.to} 页】\n\n${md.md}`);
		} catch (err) {
			failures.push({ ...c, error: err instanceof Error ? err.message : String(err) });
		}
	}

	const failedNote = failures.map((f) => `第 ${f.from}-${f.to} 页：${f.error.slice(0, 120)}`).join("；");
	if (!parts.length) {
		throw new Error(`分批 OCR 全部失败（${chunks.length} 批）：${failedNote || "未知错误"}`);
	}
	if (failures.length && method === "wps") {
		throw new Error(`严格模式（method=wps）下部分页 OCR 失败：${failedNote}`);
	}

	const route = `wps pdf2word(扫描 OCR 分批 ${chunks.length} 批 / 共 ${span.from}-${span.to} 页${
		failures.length ? `，${failures.length} 批失败` : ""
	}) → pandoc (plain)`;
	const result = { md: parts.join("\n\n---\n\n"), route };

	if (failures.length) {
		// 只把失败段切图交视觉兜底，成功段不重跑
		const images = [];
		for (const f of failures) {
			try {
				images.push(...(await pdfPagesForVision(pdf, tmpDir, password, signal, { from: f.from, to: f.to })));
			} catch {
				// 该段切图也失败，下面按整本切图兜底
			}
		}
		if (!images.length) {
			try {
				images.push(...(await pdfPagesForVision(pdf, tmpDir, password, signal, span)));
			} catch {
				// 彻底拿不到图片，只把失败信息写进正文
			}
		}
		if (images.length) {
			result.needsVision = {
				images,
				reason: `分批 OCR 有 ${failures.length} 批失败，仅对失败页做视觉兜底：${failedNote}`,
				label: path.basename(pdf),
			};
		} else {
			result.md = `${result.md}\n\n> ⚠️ 部分页 OCR 失败且无法切图：${failedNote}`;
		}
	}

	return result;
}

/**
 * 扫描件 PDF 的视觉兜底准备：逐页切图，返回页图路径列表。
 * worker 不做视觉识别本身（没有模型注册表），只把图备好交给扩展层。
 *
 * 为什么必须逐页叫 pdf2photo：wpscli 1.1.0 的 pdf2photo 会把多页竖向拼成
 * 一张超长图（实测 20 页 = 1122x31740），视觉模型降采样后根本认不出字；
 * 而且不传 --range 时报 exit 214 一个文件也不出。因此按页 --range N 逐张渲染，
 * 并重命名为 page-0001.jpg 便于在视觉结果里定位页码。
 */
async function pdfPagesForVision(pdf, tmpDir, password, signal, span) {
	const tag = span ? `${span.from}-${span.to}` : "all";
	const outDir = path.join(tmpDir, "vision-pages", tag);
	mkdirSync(outDir, { recursive: true });

	let from = span?.from;
	let to = span?.to;
	if (from == null) {
		let info = { pages: 0 };
		try {
			info = await wpsPdfInfo(pdf, password);
		} catch {
			// 拿不到页数就逐页试探到渲染失败为止
		}
		from = 1;
		to = info.pages || 0;
	}

	const renderPage = async (pageNo) => {
		const pageDir = path.join(outDir, `p${pageNo}`);
		mkdirSync(pageDir, { recursive: true });
		const args = ["pdf2photo", pdf, "-o", pageDir, "--suffix", "jpg", "--image-quality", "high", "--range", String(pageNo)];
		if (password) args.push("--password", password);
		const res = await runWps(args, { timeoutSec: SCAN_TIMEOUT_SEC, signal });
		if (!res.ok) return { ok: false, error: res.error };
		const file = readdirSync(pageDir).find((f) => /\.(jpe?g|png)$/i.test(f));
		if (!file) return { ok: false, error: `第 ${pageNo} 页无产物` };
		const target = path.join(outDir, `page-${String(pageNo).padStart(4, "0")}.jpg`);
		copyFileSync(path.join(pageDir, file), target);
		return { ok: true, path: target };
	};

	const images = [];
	const failed = [];
	const last = to || from + 500;
	for (let p = from; p <= last; p++) {
		if (signal?.aborted) throw new Error("已取消");
		const r = await renderPage(p);
		if (r.ok) {
			images.push(r.path);
		} else if (to) {
			// 已知总页数：单页失败跳过，不让一张图拖死整本
			failed.push(`第 ${p} 页：${r.error}`);
		} else {
			// 未知总页数：渲染失败即表示到头
			break;
		}
	}
	if (!images.length) throw new Error(`pdf2photo 未产出页面图片${failed.length ? `：${failed[0]}` : ""}`);
	return images;
}

/**
 * PDF → Markdown 总分流：
 *   method=vision → 直接切页返回视觉兜底清单
 *   scanned       → pdf2word(scanned)；失败 → 切页视觉兜底（auto）或抛错（wps）
 *   文字版        → pdf2md；为空 → 按扫描件重试；仍失败 → 切页视觉兜底（auto）
 */
async function pdfToMd(pdf, opts) {
	const { range, method, tmpDir, password, signal } = opts;

	if (method === "vision") {
		const pages = await pdfPagesForVision(pdf, tmpDir, password, signal);
		return { needsVision: { images: pages, reason: "method=vision 强制视觉识别", label: path.basename(pdf) } };
	}

	let info;
	try {
		info = await wpsPdfInfo(pdf, password);
	} catch {
		info = { pages: 0, scanned: false };
	}

	if (info.scanned) {
		try {
			return await pdfScannedToMd(pdf, info.pages, range, tmpDir, password, signal, { method });
		} catch (err) {
			if (method === "wps") throw err;
			const note = err instanceof Error ? err.message : String(err);
			try {
				const pages = await pdfPagesForVision(pdf, tmpDir, password, signal);
				return { needsVision: { images: pages, reason: `WPS 扫描 OCR 失败后视觉兜底: ${note.slice(0, 160)}`, label: path.basename(pdf) } };
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
			const scanned = await pdfScannedToMd(pdf, info.pages || 1, range, tmpDir, password, signal, { method });
			return { ...scanned, route: `${scanned.route}（文字提取为空，按扫描件重试）` };
		} catch {
			try {
				const pages = await pdfPagesForVision(pdf, tmpDir, password, signal);
				return { needsVision: { images: pages, reason: `pdf2md 与扫描 OCR 均失败后视觉兜底: ${note.slice(0, 160)}`, label: path.basename(pdf) } };
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

	const method = ["auto", "wps", "vision"].includes(spec.method) ? spec.method : "auto";
	const password = spec.password || process.env.READALL_PASSWORD || process.env.READALL_JOB_PASSWORD || undefined;
	/** 视觉兜底清单：跨文件累积，扩展层按此跑视觉队列 */
	const visionRequests = [];
	const sections = [];
	const detailsPerFile = [];
	let anySuccess = false;

	const tmpDir = makeTmpDir(workspace);
	/** 有视觉兜底需求时不能删临时目录：切好的页图要留给扩展进程读取 */
	let keepTmp = false;

	try {
		// 按输入顺序处理：连续的图片合并成一批 photo2word，其余逐个处理，输出顺序与输入一致
		const groups = [];
		for (const p of paths) {
			const isImage = IMAGE_EXTS.has(path.extname(p).toLowerCase());
			const last = groups[groups.length - 1];
			if (isImage && last && last.kind === "image") last.items.push(p);
			else groups.push({ kind: isImage ? "image" : "file", items: [p] });
		}

		for (const group of groups) {
			if (group.kind === "image") {
				const images = group.items;
				// ── 图片批：photo2word 分张 OCR（WPS「图片转文字」原生入口），失败 → 视觉兜底 ──
				if (method === "vision") {
					visionRequests.push({ images, reason: "method=vision 强制视觉识别" });
					detailsPerFile.push({ source: images, kind: "image", ok: false, vision: true });
				} else {
					try {
						const flow = await imagesViaWps(images, tmpDir, spec.range, signal);
						for (const part of flow.parts) {
							sections.push({ header: part.header, md: part.md, route: part.route });
						}
						anySuccess = true;
						detailsPerFile.push({ source: images, kind: "image", ok: true, route: flow.route });
					} catch (wpsErr) {
						const wpsNote = wpsErr instanceof Error ? wpsErr.message : String(wpsErr);
						if (method === "wps") throw wpsErr;
						visionRequests.push({ images, reason: `WPS OCR 失败后视觉兜底: ${wpsNote.slice(0, 160)}` });
						detailsPerFile.push({ source: images, kind: "image", ok: false, vision: true, error: wpsNote });
					}
				}
				continue;
			}

			const file = group.items[0];
			const ext = path.extname(file).toLowerCase();
			const header = `## 来源：${file}`;
			try {
				let flow;
				if (ext === ".pdf") {
					flow = await pdfToMd(file, { range: spec.range, method, tmpDir, password, signal });
				} else if (READABLE_TEXT.has(ext)) {
					const md = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
					flow = { md, route: "direct read" };
				} else if (PANDOC_NATIVE.has(ext)) {
					flow = await pandocNativeToMd(file, PANDOC_NATIVE.get(ext), tmpDir, signal);
				} else {
					// docx, xlsx, pptx 及 legacy doc/xls/ppt/ods/odp
					flow = await officeToMd(file, tmpDir, password, signal);
				}

				if (flow.needsVision) {
					visionRequests.push(flow.needsVision);
					const hasText = !!flow.md?.trim();
					if (hasText) anySuccess = true;
					detailsPerFile.push({ source: file, kind: ext.slice(1), ok: hasText, vision: true, reason: flow.needsVision.reason });
					sections.push({
						header,
						md: flow.md || "",
						route: flow.route || "",
						deferred: `视觉兜底待执行：${flow.needsVision.reason}`,
					});
				} else {
					sections.push({ header, md: flow.md, route: flow.route });
					anySuccess = true;
					detailsPerFile.push({ source: file, kind: ext.slice(1), ok: true, route: flow.route });
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				sections.push({ header, md: "", error: message });
				detailsPerFile.push({ source: file, kind: ext.slice(1), ok: false, error: message });
			}
		}
	} finally {
		keepTmp = visionRequests.length > 0;
		if (!keepTmp) removeTmpDir(tmpDir);
	}

	const body = appendUsccWarnings(
		sections
			.map((s) => {
				const parts = [];
				if (s.header) parts.push(s.header);
				if (s.route) parts.push(`> 处理链路：${s.route}`);
				if (s.deferred) parts.push(`> ⏳ ${s.deferred}`);
				if (s.error) parts.push(`\n> ⚠️ 读取失败：${s.error}`);
				parts.push(s.md || "");
				return parts.filter(Boolean).join("\n\n");
			})
			.join("\n\n---\n\n"),
	);

	let finalText = body;
	const details = {
		method,
		files: detailsPerFile,
		anySuccess,
		visionRequests,
		// 只在有待兜底图片时给出；调用方（扩展层）用完页图需自行删除该目录
		tmpDir: keepTmp ? tmpDir : undefined,
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

	return { ok: anySuccess, text: finalText, details, body };
}

// ---------------------------------------------------------------------------
// 依赖检测与安装模式
// ---------------------------------------------------------------------------

function checkDeps() {
	const statuses = [];
	try {
		const wps = findWpscli();
		statuses.push({ name: "wpscli", ok: true, version: wpscliVersion(), path: wps, detail: "WPS Office 自带（OCR 主力）" });
	} catch (err) {
		statuses.push({ name: "wpscli", ok: false, version: "", path: "", detail: err instanceof Error ? err.message : String(err) });
	}
	try {
		const off = findOfficecli();
		statuses.push({ name: "officecli", ok: true, version: officecliVersion(), path: off, detail: "" });
	} catch (err) {
		statuses.push({ name: "officecli", ok: false, version: "", path: "", detail: "未安装（可选，docx 快速读取）" });
	}
	try {
		const pan = findPandoc();
		statuses.push({ name: "pandoc", ok: true, version: pandocVersion(), path: pan, detail: "" });
	} catch (err) {
		statuses.push({ name: "pandoc", ok: false, version: "", path: "", detail: err instanceof Error ? err.message : String(err) });
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
		// officecli 官方安装方式是从网络拉脚本直接执行（irm | iex），无校验、无固定版本。
		// 默认不自动跑，需用户显式授权 READALL_ALLOW_REMOTE_INSTALL=1。
		if (process.env.READALL_ALLOW_REMOTE_INSTALL !== "1") {
			outcomes.push({
				name: "officecli",
				ranOk: false,
				skipped: true,
				note:
					"已跳过：officecli 安装脚本需从网络下载后直接执行（irm https://d.officecli.ai/install.ps1 | iex），" +
					"默认不自动运行。确认来源可信后可手动执行该命令，或设 READALL_ALLOW_REMOTE_INSTALL=1 后重试 setup。" +
					"（pandoc 走 winget 签名包，不受此限制）",
			});
		} else {
			const r = await runCmd("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://d.officecli.ai/install.ps1 | iex"], {
				timeoutSec: 600,
				signal,
			});
			outcomes.push({ name: "officecli", ranOk: r.ok, note: r.error || r.stderr || "" });
		}
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
		outcomes.push({ name: "pandoc", ranOk: r.ok, note: r.error || r.stderr || "" });
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

const MAX_CONCURRENT_JOBS = parseInt(process.env.READALL_MAX_CONCURRENT || "6", 10);
const JOB_DEADLINE_SEC = parseInt(process.env.READALL_JOB_DEADLINE_SEC || "1800", 10);

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
			if (!existsSync(jobJson)) continue;
			try {
				const meta = JSON.parse(readFileSync(jobJson, "utf-8"));
				if (meta.status === "running" && isProcessAlive(meta.pid)) count++;
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

		// 视觉兜底在分离进程里不可用（无模型注册表）→ 明确失败并指路
		if (res.details?.visionRequests?.length) {
			// 页图不会再有人读，当场回收临时目录
			if (res.details.tmpDir) {
				try {
					rmSync(res.details.tmpDir, { recursive: true, force: true });
				} catch {
					// ignore
				}
			}
			writeFileSync(resultMdPath, res.body || res.text, "utf-8");
			writeFileSync(detailsJsonPath, JSON.stringify(res.details, null, 2), "utf-8");
			updateMeta({
				status: "failed",
				finishedAt: new Date().toISOString(),
				resultPath: resultMdPath,
				error:
					"部分输入 WPS OCR 失败，需要视觉模型兜底；异步任务进程无法访问视觉模型，" +
					"请改用同步 readall({ action: \"read\" }) 分批执行（read 会自动走视觉兜底）。",
			});
			process.exit(1);
		}

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
