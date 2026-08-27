/**
 * pi-wpscli — pi plugin wrapping the local WPS CLI (wpscli).
 *
 * Wrapped subcommands (ported from the wps-pdf-to-word skill):
 *   - pdf2word   : PDF → editable Word; --scanned true runs WPS OCR so scanned
 *                  documents / certificates produce selectable, copyable text
 *                  (NOT an image-only .docx). Scanned mode requires --range.
 *   - to_pdf     : Word/Excel/PPT/TXT → PDF (subcommand picked from extension)
 *   - pdfinfo    : metadata, page count, scanned hint
 *   - pdfcompress/ pdfwatermark
 *   - photo2pdf  : image → PDF (first step of the image→Word pipeline)
 *   - pdf2imgpdf : PDF → image-only PDF
 *   - pdf2photo  : PDF pages → images (output dir is auto-created)
 *   - pdf2md     : PDF → Markdown
 *
 * wpscli resolution order: WPSCLI_PATH env → PATH (`where wpscli`) → newest
 *   *  %LOCALAPPDATA%\Kingsoft\WPS Office\<ver>\clitool\wpscli.exe
 *   *  C:\Program Files\WPS Office\<ver>\clitool\wpscli.exe
 * Never guesses CLI arguments; only known flags are passed.
 *
 * Exit codes handled: 100 = not logged in, 101 = insufficient permissions,
 * 211 = output directory missing. --json is always on.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const DEFAULT_CLI_TIMEOUT_SEC = 300;
const EXIT_HINTS: Record<number, string> = {
	100: "WPS 未登录：请在 WPS 桌面端登录账号后重试。",
	101: "账号权限不足：该转换能力通常需要 WPS 会员/超级会员，或当前账号未开通对应服务。",
	211: "输出目录不存在或不可写：检查输出路径（输出到目录的命令已自动建目录，仍失败则检查权限）。",
};

let cliCache: string | null = null;

function isNewerVersion(a: string, b: string): boolean {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

/** wpscli.exe is runnable if we can invoke it with --version. A stale install root
 * fails immediately, so we skip it instead of crashing the runner. */
function isRunnableWpscli(exe: string): boolean {
	try {
		execFileSync(exe, ["--version"], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 15_000,
		});
		return true;
	} catch {
		return false;
	}
}

/** Extract the WPS version from an install path like ...\\WPS Office\\12.1.0.28043\\clitool\\wpscli.exe */
function wpsVersionFromPath(exe: string): string {
	const m = exe.match(/[\\/]WPS Office[\\/](\d+\.\d+\.\d+(?:\.\d+)?)/i);
	return m ? m[1] : "";
}

function findWpscli(): string {
	if (cliCache) return cliCache;

	// Collect every candidate wpscli.exe: explicit config first, then all PATH hits,
	// then every installed version discovered in the known install roots.
	const candidates: string[] = [];
	const add = (p?: string | null) => {
		const abs = p?.trim();
		if (!abs || !existsSync(abs)) return;
		const norm = abs.toLowerCase();
		if (!candidates.some((c) => c.toLowerCase() === norm)) candidates.push(abs);
	};

	// 1. explicit config
	const fromEnv = process.env.WPSCLI_PATH?.trim();
	if (fromEnv && isRunnableWpscli(fromEnv)) return (cliCache = fromEnv);
	add(fromEnv); // still considered, so a broken explicit value doesn't silently hide others

	// 2. PATH (may point at stale/broken version dirs) — gather ALL hits
	try {
		const out = execFileSync("where", ["wpscli"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		out.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)
			.forEach((p) => add(path.normalize(p)));
	} catch {
		// not on PATH
	}

	// 3. known install roots — discover every installed version
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
			"找不到 wpscli：请安装 WPS Office，或设置 WPSCLI_PATH 环境变量指向 wpscli.exe（通常位于 ...\\WPS Office\\<版本>\\clitool\\wpscli.exe）。",
		);
	}

	// Preferred: the NEWEST RUNNABLE version. If PATH points at an old/dead install
	// that is older than the real one, the newer runnable candidate wins — so WPS
	// upgrades can never break auto-detect again.
	let bestFile: string | null = null;
	let bestVer = "";
	for (const exe of candidates) {
		if (!isRunnableWpscli(exe)) continue;
		const ver = wpsVersionFromPath(exe);
		if (!bestFile || isNewerVersion(ver, bestVer)) {
			bestFile = exe;
			bestVer = ver;
		}
	}

	if (bestFile) return (cliCache = bestFile);

	throw new Error(
		`找到 ${candidates.length} 个 wpscli.exe 候选但均无法运行：\n` +
			candidates.map((c) => `  - ${c}`).join("\n") +
			"\n请检查 WPS 安装是否损坏，或设置 WPSCLI_PATH 指向可用的 wpscli.exe。",
	);
}

interface WpsResult {
	ok: boolean;
	raw: unknown;
}

/** wpscli prints a JSON envelope with --json; if unparseable, return trimmed raw text. */
function parseWpsOutput(stdout: string, stderr: string): { summary: string; parsed: unknown } {
	const text = (stdout.trim() || stderr.trim()).trim();
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return { summary: JSON.stringify(parsed, null, 2), parsed };
	} catch {
		const brace = text.lastIndexOf("{");
		if (brace >= 0) {
			try {
				const parsed = JSON.parse(text.slice(brace));
				return { summary: JSON.stringify(parsed, null, 2), parsed };
			} catch {
				// fall through
			}
		}
		return { summary: text.slice(0, 2000) || "(no output — exit code 0)", parsed: null };
	}
}

async function runWps(args: string[], opts: { timeoutSec?: number; signal?: AbortSignal }): Promise<WpsResult> {
	const exe = findWpscli();
	const timeoutSec = opts.timeoutSec ?? DEFAULT_CLI_TIMEOUT_SEC;
	const fullArgs = [...args, "--timeout", String(timeoutSec), "--json"];

	try {
		const { stdout, stderr } = await execFileAsync(exe, fullArgs, {
			encoding: "utf-8",
			windowsHide: true,
			maxBuffer: 32 * 1024 * 1024,
			timeout: timeoutSec * 1000 + 60_000,
			signal: opts.signal,
		});
		const { summary, parsed } = parseWpsOutput(stdout, stderr);
		return { ok: true, raw: parsed ?? summary };
	} catch (err: unknown) {
		const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
		if (e.killed || opts.signal?.aborted) {
			return { ok: false, raw: `WPS CLI 调用超时或被取消（超过 ${timeoutSec}s + 60s 余量）。` };
		}
		const exitCode = typeof e.code === "number" ? e.code : null;
		const hint = exitCode != null ? EXIT_HINTS[exitCode] : undefined;
		const outTail = [e.stdout, e.stderr].filter(Boolean).join("\n").trim().slice(0, 1500);
		const parts = [
			`wpscli 退出码 ${e.code ?? "unknown"}${hint ? `：${hint}` : ""}`,
			outTail ? `输出：${outTail}` : null,
		].filter(Boolean);
		return { ok: false, raw: parts.join("\n") };
	}
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function defaultOutput(input: string, suffix: string): string {
	const dir = path.dirname(input);
	const base = path.basename(input, path.extname(input));
	return path.join(dir, base + suffix);
}

function ensureParent(file: string): string {
	mkdirSync(path.dirname(file), { recursive: true });
	return file;
}

function boolFlag(v: boolean | undefined, name: string): string[] {
	return v ? [name, "true"] : [];
}

export default function (pi: ExtensionAPI) {
	// ── pdfinfo ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_pdfinfo",
		label: "WPS PDF Info",
		description:
			"Inspect a PDF with the local WPS CLI: metadata, page count, and whether it looks scanned. " +
			"Call this BEFORE wps_pdf2word when the PDF type is unknown, so scanned mode and page ranges can be chosen correctly.",
		promptSnippet: "Inspect PDF metadata/page count/scanned-hint via local WPS CLI",
		promptGuidelines: ["Run wps_pdfinfo before wps_pdf2word on unknown PDFs to decide scanned mode and --range."],
		parameters: Type.Object({
			file: Type.String({ description: "PDF file path" }),
		}),
		async execute(_id, params, signal) {
			const res = await runWps(["pdfinfo", params.file], { signal });
			const text = res.ok
				? `pdfinfo ok: ${params.file}\n${typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw, null, 2)}`
				: `pdfinfo failed: ${res.raw}`;
			return toolResult(text, { file: params.file, ok: res.ok });
		},
	});

	// ── pdf2word ─────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_pdf2word",
		label: "WPS PDF→Word",
		description:
			"Convert a PDF to an editable Word .docx using WPS CLI. For scanned PDFs / photos / certificates, enable " +
			"scanned=true: WPS OCR produces selectable, copyable text (never fall back to inserting page images). " +
			"Scanned mode requires an explicit page range. Requires WPS login (exit 100) and possibly membership (exit 101).",
		promptSnippet: "Convert PDF to editable Word via WPS CLI (scanned=true → OCR, needs range)",
		promptGuidelines: [
			"For image-like/scanned PDFs always use scanned=true and pass a page range; call wps_pdfinfo first if the page count is unknown.",
			"Use aiFix=true when page orientation or scan quality may be bad (sideways certificates, tilted scans).",
			"Never replace this tool with rendering PDF pages to images and inserting them into Word — that yields copy-proof image-only docx.",
		],
		parameters: Type.Object({
			file: Type.String({ description: "Input PDF path" }),
			output: Type.Optional(Type.String({ description: "Output .docx path (default: <name>_WPS转换.docx next to input)" })),
			scanned: Type.Optional(Type.Boolean({ description: "true = WPS OCR mode for scanned/image PDFs (requires range)" })),
			range: Type.Optional(Type.String({ description: "Page range like '1-2' or '1' (required when scanned=true)" })),
			aiFix: Type.Optional(Type.Boolean({ description: "true = AI layout/orientation fix" })),
			overwrite: Type.Optional(Type.Boolean({ description: "true = overwrite existing output" })),
			timeoutSec: Type.Optional(Type.Number({ description: `CLI timeout seconds (default ${DEFAULT_CLI_TIMEOUT_SEC})` })),
		}),
		async execute(_id, params, signal) {
			if (params.scanned && !params.range?.trim()) {
				return toolResult(
					"scanned=true 必须显式指定页码范围（range，如 '1-2'）。页数未知时先用 wps_pdfinfo 查看。",
					{ ok: false, error: "missing-range" },
				);
			}
			const out = ensureParent(params.output ?? path.join(path.dirname(params.file), `${path.basename(params.file, path.extname(params.file))}_WPS转换.docx`));
			const args = [
				"pdf2word",
				params.file,
				"--output",
				out,
				...(params.scanned ? ["--scanned", "true"] : []),
				...(params.range?.trim() ? ["--range", params.range.trim()] : []),
				...boolFlag(params.aiFix, "--ai-fix"),
			];
			const res = await runWps(args, { timeoutSec: params.timeoutSec, signal });
			return toolResult(
				res.ok
					? `OK: ${out}\n${typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw, null, 2)}\n提示：OCR 可能识别错相近汉字/数字/编号，正式使用前请人工核对关键字段。`
					: `wps_pdf2word failed: ${res.raw}`,
				{ file: params.file, output: out, scanned: !!params.scanned, ok: res.ok },
			);
		},
	});

	// ── office/txt → pdf ─────────────────────────────────────────────────────
	const TO_PDF: Array<{ exts: string[]; cmd: string }> = [
		{ exts: [".doc", ".docx", ".wps"], cmd: "word2pdf" },
		{ exts: [".xls", ".xlsx", ".et"], cmd: "excel2pdf" },
		{ exts: [".ppt", ".pptx", ".dps"], cmd: "ppt2pdf" },
		{ exts: [".txt"], cmd: "txt2pdf" },
	];
	pi.registerTool({
		name: "wps_to_pdf",
		label: "WPS Office→PDF",
		description:
			"Convert Word/Excel/PPT/TXT to PDF with WPS CLI (subcommand auto-selected by file extension: word2pdf/excel2pdf/ppt2pdf/txt2pdf).",
		promptSnippet: "Convert Word/Excel/PPT/TXT to PDF via WPS CLI",
		promptGuidelines: ["Use wps_to_pdf for final-deliverable PDF conversion; WPS keeps layout fidelity better than generic converters."],
		parameters: Type.Object({
			file: Type.String({ description: "Input .doc/.docx/.wps/.xls/.xlsx/.et/.ppt/.pptx/.dps/.txt path" }),
			output: Type.Optional(Type.String({ description: "Output .pdf path (default: same folder, same name, .pdf)" })),
			timeoutSec: Type.Optional(Type.Number({ description: `CLI timeout seconds (default ${DEFAULT_CLI_TIMEOUT_SEC})` })),
		}),
		async execute(_id, params, signal) {
			const ext = path.extname(params.file).toLowerCase();
			const hit = TO_PDF.find((t) => t.exts.includes(ext));
			if (!hit) {
				return toolResult(`不支持的格式 ${ext || "(无扩展名)"}；支持：${TO_PDF.flatMap((t) => t.exts).join(", ")}`, {
					ok: false,
					error: "unsupported-ext",
				});
			}
			const out = ensureParent(defaultOutput(params.file, ".pdf"));
			const res = await runWps([hit.cmd, params.file, "--output", params.output ?? out], { timeoutSec: params.timeoutSec, signal });
			return toolResult(
				res.ok ? `OK: ${params.output ?? out}` : `wps_to_pdf(${hit.cmd}) failed: ${res.raw}`,
				{ file: params.file, output: params.output ?? out, command: hit.cmd, ok: res.ok },
			);
		},
	});

	// ── pdfcompress ──────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_pdfcompress",
		label: "WPS PDF 压缩",
		description: "Compress a PDF with WPS CLI (--press-quality low|medium|high).",
		promptSnippet: "Compress a PDF via WPS CLI",
		parameters: Type.Object({
			file: Type.String({ description: "Input PDF path" }),
			output: Type.Optional(Type.String({ description: "Output PDF path (default: <name>_压缩.pdf)" })),
			quality: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "press-quality (default medium)" })),
			timeoutSec: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const out = ensureParent(params.output ?? defaultOutput(params.file, "_压缩.pdf"));
			const res = await runWps(["pdfcompress", params.file, "--output", out, "--press-quality", params.quality ?? "medium"], { timeoutSec: params.timeoutSec, signal });
			return toolResult(res.ok ? `OK: ${out}` : `wps_pdfcompress failed: ${res.raw}`, { file: params.file, output: out, ok: res.ok });
		},
	});

	// ── pdfwatermark ─────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_pdfwatermark",
		label: "WPS PDF 加水印",
		description: "Add a text watermark to a PDF with WPS CLI.",
		promptSnippet: "Add text watermark to a PDF via WPS CLI",
		parameters: Type.Object({
			file: Type.String({ description: "Input PDF path" }),
			text: Type.String({ description: "Watermark text" }),
			output: Type.Optional(Type.String({ description: "Output PDF path (default: <name>_水印.pdf)" })),
			opacity: Type.Optional(Type.Number({ description: "Opacity 0-100 (default 50)" })),
			rotateAngle: Type.Optional(Type.Number({ description: "Rotation angle degrees (default 45)" })),
			timeoutSec: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const out = ensureParent(params.output ?? defaultOutput(params.file, "_水印.pdf"));
			const args = [
				"pdfwatermark",
				params.file,
				"--output",
				out,
				"--text",
				params.text,
				"--opacity",
				String(params.opacity ?? 50),
				"--rotate-angle",
				String(params.rotateAngle ?? 45),
			];
			const res = await runWps(args, { timeoutSec: params.timeoutSec, signal });
			return toolResult(res.ok ? `OK: ${out}` : `wps_pdfwatermark failed: ${res.raw}`, { file: params.file, output: out, ok: res.ok });
		},
	});

	// ── photo2pdf ────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_photo2pdf",
		label: "WPS 图片转PDF",
		description:
			"Convert an image to PDF with WPS CLI. Also the first step of the image→editable-Word pipeline: photo2pdf then wps_pdf2word(scanned=true).",
		promptSnippet: "Convert image to PDF via WPS CLI (step 1 of image→Word OCR pipeline)",
		promptGuidelines: [
			"To turn a photo/certificate INTO an editable Word: wps_photo2pdf first, then wps_pdf2word with scanned=true and range='1'.",
		],
		parameters: Type.Object({
			image: Type.String({ description: "Image path (jpg/png/bmp/...)" }),
			output: Type.Optional(Type.String({ description: "Output PDF path (default: <name>.pdf next to image)" })),
			overwrite: Type.Optional(Type.Boolean({ description: "true = overwrite existing output" })),
			timeoutSec: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const out = ensureParent(params.output ?? defaultOutput(params.image, ".pdf"));
			const res = await runWps(["photo2pdf", params.image, "--output", out, ...boolFlag(params.overwrite, "--overwrite")], {
				timeoutSec: params.timeoutSec,
				signal,
			});
			return toolResult(
				res.ok ? `OK: ${out}\n如需可编辑 Word：再用 wps_pdf2word(file="${out}", scanned=true, range="1")` : `wps_photo2pdf failed: ${res.raw}`,
				{ image: params.image, output: out, ok: res.ok },
			);
		},
	});

	// ── pdf2imgpdf ───────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_pdf2imgpdf",
		label: "WPS PDF转图片版PDF",
		description: "Convert a PDF into an image-only PDF with WPS CLI (no selectable text).",
		promptSnippet: "Convert PDF to image-only PDF via WPS CLI",
		parameters: Type.Object({
			file: Type.String({ description: "Input PDF path" }),
			output: Type.Optional(Type.String({ description: "Output PDF path (default: <name>_图片版.pdf)" })),
			timeoutSec: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const out = ensureParent(params.output ?? defaultOutput(params.file, "_图片版.pdf"));
			const res = await runWps(["pdf2imgpdf", params.file, "--output", out], { timeoutSec: params.timeoutSec, signal });
			return toolResult(res.ok ? `OK: ${out}` : `wps_pdf2imgpdf failed: ${res.raw}`, { file: params.file, output: out, ok: res.ok });
		},
	});

	// ── pdf2photo ────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_pdf2photo",
		label: "WPS PDF页面转图片",
		description: "Render PDF pages to image files with WPS CLI. Output directory is created automatically.",
		promptSnippet: "Render PDF pages to images via WPS CLI",
		parameters: Type.Object({
			file: Type.String({ description: "Input PDF path" }),
			outputDir: Type.Optional(Type.String({ description: "Output directory (default: <name>_pages/ next to input)" })),
			range: Type.Optional(Type.String({ description: "Page range like '1-3' (default: all pages)" })),
			suffix: Type.Optional(StringEnum(["png", "jpg"] as const, { description: "Image format (default png)" })),
			imageQuality: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "Image quality (default high)" })),
			timeoutSec: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const dir = params.outputDir ?? path.join(path.dirname(params.file), `${path.basename(params.file, path.extname(params.file))}_pages`);
			mkdirSync(dir, { recursive: true });
			const args = [
				"pdf2photo",
				params.file,
				"--output",
				dir + path.sep,
				"--suffix",
				params.suffix ?? "png",
				"--image-quality",
				params.imageQuality ?? "high",
				...(params.range?.trim() ? ["--range", params.range.trim()] : []),
			];
			const res = await runWps(args, { timeoutSec: params.timeoutSec, signal });
			let files: string[] = [];
			if (res.ok) {
				try {
					files = readdirSync(dir).map((f) => path.join(dir, f));
				} catch {
					// ignore
				}
			}
			return toolResult(
				res.ok
					? `OK: ${dir}${files.length ? `\n生成 ${files.length} 个文件：\n${files.slice(0, 50).join("\n")}` : ""}`
					: `wps_pdf2photo failed: ${res.raw}`,
				{ file: params.file, outputDir: dir, files, ok: res.ok },
			);
		},
	});

	// ── pdf2md ───────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "wps_pdf2md",
		label: "WPS PDF转Markdown",
		description: "Convert a PDF to Markdown with WPS CLI.",
		promptSnippet: "Convert PDF to Markdown via WPS CLI",
		parameters: Type.Object({
			file: Type.String({ description: "Input PDF path" }),
			output: Type.Optional(Type.String({ description: "Output .md path (default: same name, .md)" })),
			timeoutSec: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const out = ensureParent(params.output ?? defaultOutput(params.file, ".md"));
			const res = await runWps(["pdf2md", params.file, "--output", out], { timeoutSec: params.timeoutSec, signal });
			return toolResult(res.ok ? `OK: ${out}` : `wps_pdf2md failed: ${res.raw}`, { file: params.file, output: out, ok: res.ok });
		},
	});

}
