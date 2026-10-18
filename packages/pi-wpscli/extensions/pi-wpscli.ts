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

/** 合并后的 9 个子能力的参数定义（并集，字段名与旧单工具保持一致）。 */
const WPS_ACTIONS = [
	"pdfinfo",
	"pdf2word",
	"to_pdf",
	"pdfcompress",
	"pdfwatermark",
	"photo2pdf",
	"pdf2imgpdf",
	"pdf2photo",
	"pdf2md",
] as const;

type WpsAction = (typeof WPS_ACTIONS)[number];

// office/txt → pdf 的子命令映射
const TO_PDF: Array<{ exts: string[]; cmd: string }> = [
	{ exts: [".doc", ".docx", ".wps"], cmd: "word2pdf" },
	{ exts: [".xls", ".xlsx", ".et"], cmd: "excel2pdf" },
	{ exts: [".ppt", ".pptx", ".dps"], cmd: "ppt2pdf" },
	{ exts: [".txt"], cmd: "txt2pdf" },
];

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "wps",
		label: "WPS 转换",
		description:
			"本地 WPS CLI 封装，按 action 选能力：pdfinfo（元信息/页数/扫描判别）、pdf2word（PDF→可编辑 Word，扫描件必须 scanned=true 且给 range）、to_pdf（Office/TXT→PDF，版式保真）、pdfcompress、pdfwatermark、photo2pdf（图片→PDF）、pdf2imgpdf（图片版 PDF）、pdf2photo（页面转图片）、pdf2md。需要 WPS 登录，部分能力需会员。",
		promptSnippet: "WPS 文档转换（PDF/Word/压缩/水印）",
		promptGuidelines: [
			"未知 PDF 先 wps(action:\"pdfinfo\")，再决定 pdf2word 是否 scanned 与 range。",
			"图片/证书变可编辑 Word：wps(action:\"photo2pdf\") → wps(action:\"pdf2word\", scanned=true, range=\"1\")，绝不要把页面渲染成图片插进 Word 冒充。",
		],
		parameters: Type.Object({
			action: StringEnum(WPS_ACTIONS, {
				description:
					"pdfinfo|pdf2word|to_pdf|pdfcompress|pdfwatermark|photo2pdf|pdf2imgpdf|pdf2photo|pdf2md",
			}),
			file: Type.Optional(
				Type.String({ description: "输入文件路径（PDF/Office/TXT；除 photo2pdf 外的 action 都用它）" }),
			),
			image: Type.Optional(Type.String({ description: "图片路径（photo2pdf 用）" })),
			output: Type.Optional(Type.String({ description: "输出文件路径（省略时按 action 用默认命名）" })),
			outputDir: Type.Optional(Type.String({ description: "输出目录（pdf2photo 用，默认 <名>_pages/，自动创建）" })),
			text: Type.Optional(Type.String({ description: "水印文字（pdfwatermark 必填）" })),
			scanned: Type.Optional(Type.Boolean({ description: "true=OCR 模式（扫描件/图片 PDF，必须配 range）" })),
			range: Type.Optional(Type.String({ description: "页码范围，如 \"1-2\"（scanned 时必填）" })),
			aiFix: Type.Optional(Type.Boolean({ description: "true=AI 纠正版式/方向" })),
			overwrite: Type.Optional(Type.Boolean({ description: "true=覆盖已有输出" })),
			quality: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "压缩档位，默认 medium" })),
			opacity: Type.Optional(Type.Number({ description: "水印不透明度 0-100，默认 50" })),
			rotateAngle: Type.Optional(Type.Number({ description: "水印旋转角度，默认 45" })),
			suffix: Type.Optional(StringEnum(["png", "jpg"] as const, { description: "图片格式，默认 png" })),
			imageQuality: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "画质，默认 high" })),
			timeoutSec: Type.Optional(Type.Number({ description: `CLI 超时秒数，默认 ${DEFAULT_CLI_TIMEOUT_SEC}` })),
		}),

		async execute(_id, params, signal) {
			const action = params.action as WpsAction;
			const file = params.file ?? "";
			const image = params.image ?? "";

			switch (action) {
				// ── pdfinfo ────────────────────────────────────────────────────────
				case "pdfinfo": {
					if (!file) return toolResult("pdfinfo 需要 file（PDF 路径）", { ok: false, error: "missing-file" });
					const res = await runWps(["pdfinfo", file], { signal });
					const text = res.ok
						? `pdfinfo ok: ${file}\n${typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw, null, 2)}`
						: `pdfinfo failed: ${res.raw}`;
					return toolResult(text, { action, file, ok: res.ok });
				}

				// ── pdf2word ───────────────────────────────────────────────────────
				case "pdf2word": {
					if (!file) return toolResult("pdf2word 需要 file（PDF 路径）", { ok: false, error: "missing-file" });
					if (params.scanned && !params.range?.trim()) {
						return toolResult(
							"scanned=true 必须显式指定页码范围（range，如 '1-2'）。页数未知时先 wps(action:\"pdfinfo\") 查看。",
							{ ok: false, error: "missing-range" },
						);
					}
					const out = ensureParent(params.output ?? path.join(path.dirname(file), `${path.basename(file, path.extname(file))}_WPS转换.docx`));
					const args = [
						"pdf2word",
						file,
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
							: `pdf2word failed: ${res.raw}`,
						{ action, file, output: out, scanned: !!params.scanned, ok: res.ok },
					);
				}

				// ── to_pdf ─────────────────────────────────────────────────────────
				case "to_pdf": {
					if (!file) return toolResult("to_pdf 需要 file（.doc/.docx/.wps/.xls/.xlsx/.et/.ppt/.pptx/.dps/.txt）", { ok: false, error: "missing-file" });
					const ext = path.extname(file).toLowerCase();
					const hit = TO_PDF.find((t) => t.exts.includes(ext));
					if (!hit) {
						return toolResult(`不支持的格式 ${ext || "(无扩展名)"}；支持：${TO_PDF.flatMap((t) => t.exts).join(", ")}`, {
							ok: false,
							error: "unsupported-ext",
						});
					}
					const out = ensureParent(params.output ?? defaultOutput(file, ".pdf"));
					const res = await runWps([hit.cmd, file, "--output", out], { timeoutSec: params.timeoutSec, signal });
					return toolResult(
						res.ok ? `OK: ${out}` : `to_pdf(${hit.cmd}) failed: ${res.raw}`,
						{ action, file, output: out, command: hit.cmd, ok: res.ok },
					);
				}

				// ── pdfcompress ────────────────────────────────────────────────────
				case "pdfcompress": {
					if (!file) return toolResult("pdfcompress 需要 file（PDF 路径）", { ok: false, error: "missing-file" });
					const out = ensureParent(params.output ?? defaultOutput(file, "_压缩.pdf"));
					const res = await runWps(["pdfcompress", file, "--output", out, "--press-quality", params.quality ?? "medium"], { timeoutSec: params.timeoutSec, signal });
					return toolResult(res.ok ? `OK: ${out}` : `pdfcompress failed: ${res.raw}`, { action, file, output: out, ok: res.ok });
				}

				// ── pdfwatermark ───────────────────────────────────────────────────
				case "pdfwatermark": {
					if (!file) return toolResult("pdfwatermark 需要 file（PDF 路径）", { ok: false, error: "missing-file" });
					if (!params.text?.trim()) return toolResult("pdfwatermark 需要 text（水印文字）", { ok: false, error: "missing-text" });
					const out = ensureParent(params.output ?? defaultOutput(file, "_水印.pdf"));
					const args = [
						"pdfwatermark",
						file,
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
					return toolResult(res.ok ? `OK: ${out}` : `pdfwatermark failed: ${res.raw}`, { action, file, output: out, ok: res.ok });
				}

				// ── photo2pdf ──────────────────────────────────────────────────────
				case "photo2pdf": {
					if (!image) return toolResult("photo2pdf 需要 image（图片路径）", { ok: false, error: "missing-image" });
					const out = ensureParent(params.output ?? defaultOutput(image, ".pdf"));
					const res = await runWps(["photo2pdf", image, "--output", out, ...boolFlag(params.overwrite, "--overwrite")], {
						timeoutSec: params.timeoutSec,
						signal,
					});
					return toolResult(
						res.ok
							? `OK: ${out}\n如需可编辑 Word：再调 wps(action:"pdf2word", file="${out}", scanned=true, range="1")`
							: `photo2pdf failed: ${res.raw}`,
						{ action, image, output: out, ok: res.ok },
					);
				}

				// ── pdf2imgpdf ─────────────────────────────────────────────────────
				case "pdf2imgpdf": {
					if (!file) return toolResult("pdf2imgpdf 需要 file（PDF 路径）", { ok: false, error: "missing-file" });
					const out = ensureParent(params.output ?? defaultOutput(file, "_图片版.pdf"));
					const res = await runWps(["pdf2imgpdf", file, "--output", out], { timeoutSec: params.timeoutSec, signal });
					return toolResult(res.ok ? `OK: ${out}` : `pdf2imgpdf failed: ${res.raw}`, { action, file, output: out, ok: res.ok });
				}

				// ── pdf2photo ──────────────────────────────────────────────────────
				case "pdf2photo": {
					if (!file) return toolResult("pdf2photo 需要 file（PDF 路径）", { ok: false, error: "missing-file" });
					const dir = params.outputDir ?? path.join(path.dirname(file), `${path.basename(file, path.extname(file))}_pages`);
					mkdirSync(dir, { recursive: true });
					const args = [
						"pdf2photo",
						file,
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
							: `pdf2photo failed: ${res.raw}`,
						{ action, file, outputDir: dir, files, ok: res.ok },
					);
				}

				// ── pdf2md ─────────────────────────────────────────────────────────
				case "pdf2md": {
					if (!file) return toolResult("pdf2md 需要 file（PDF 路径）", { ok: false, error: "missing-file" });
					const out = ensureParent(params.output ?? defaultOutput(file, ".md"));
					const res = await runWps(["pdf2md", file, "--output", out], { timeoutSec: params.timeoutSec, signal });
					return toolResult(res.ok ? `OK: ${out}` : `pdf2md failed: ${res.raw}`, { action, file, output: out, ok: res.ok });
				}
			}
		},
	});
}
