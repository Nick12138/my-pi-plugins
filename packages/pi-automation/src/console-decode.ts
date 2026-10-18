/**
 * 子进程输出解码：处理 Windows 控制台代码页与 UTF-8 的冲突。
 *
 * 背景：Windows 中文系统 cmd.exe 控制台代码页默认 936（GBK），exec() 回调默认
 * 按 UTF-8 解码字节流，中文全部变成 U+FFFD 且不可逆。这里改为：
 * 1. strict UTF-8 试解优先——现代程序（node/pwsh 等）子进程直接输出 UTF-8，
 *    能无错解出就优先用它（实测：UTF-8 字节按 GBK 解会得到不含 U+FFFD 的
 *    伪中文「涓枃」，所以「替换符计数」式兜底对此无效，必须 strict 试解）；
 * 2. 失败则按控制台代码页解码（进程内跑一次 chcp 查询并缓存；cmd 内建命令
 *    与传统程序输出的是 ANSI/GBK 字节，strict UTF-8 必然解不动）。
 */
import { execSync } from "node:child_process";

/** 控制台代码页 → TextDecoder label；65001 即 utf-8，未知回退 utf-8。 */
const CODE_PAGE_LABELS: Record<number, string> = {
	65001: "utf-8",
	936: "gbk",
	950: "big5",
	932: "shift-jis",
	949: "euc-kr",
	1252: "windows-1252",
};

export function codePageLabel(codePage: number): string {
	return CODE_PAGE_LABELS[codePage] ?? "utf-8";
}

const decoderCache = new Map<string, TextDecoder>();

function decoderFor(label: string, fatal = false): TextDecoder {
	const key = `${label}:${fatal}`;
	let d = decoderCache.get(key);
	if (!d) {
		d = new TextDecoder(label, { fatal });
		decoderCache.set(key, d);
	}
	return d;
}

let cachedCodePage: number | null | undefined;

/** Windows 控制台代码页（进程内缓存，只跑一次 chcp；非 Windows 或查询失败返回 null）。 */
export function windowsConsoleCodePage(): number | null {
	if (cachedCodePage !== undefined) return cachedCodePage;
	cachedCodePage = null;
	if (process.platform !== "win32") return null;
	try {
		// chcp 自身输出也是 GBK，但「活动代码页: 936」的数字部分是 ASCII，
		// 用 latin1 解不会产生替换符、不影响正则提取。
		const out = execSync("chcp", {
			encoding: "buffer",
			windowsHide: true,
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const m = /(\d+)\s*$/.exec(out.toString("latin1"));
		if (m) cachedCodePage = Number(m[1]);
	} catch {
		// 查询失败保持 null，按 utf-8 处理（与旧行为一致）
	}
	return cachedCodePage;
}

/** 按指定代码页解码；codePage 为 null 时按 utf-8（非 Windows 的旧行为）。 */
export function decodeWithCodePage(buf: Buffer, codePage: number | null): string {
	if (codePage === null) return buf.toString("utf8");
	const label = codePageLabel(codePage);
	if (label === "utf-8") return buf.toString("utf8");
	try {
		return decoderFor("utf-8", true).decode(buf); // strict：能无错解出 → 输出本来就是 UTF-8
	} catch {
		return decoderFor(label).decode(buf); // 否则按控制台代码页（GBK 等）
	}
}

/** 解码子进程输出：Windows 按控制台代码页（含 strict UTF-8 优先），其他平台 utf-8。 */
export function decodeConsoleOutput(buf: Buffer): string {
	return decodeWithCodePage(buf, process.platform === "win32" ? windowsConsoleCodePage() : null);
}
