/**
 * pi-computer-control — let the AI see and operate the real desktop.
 *
 * Backend: a persistent PowerShell child process hosting embedded C#
 * (user32 SendInput + GDI screen capture). No native npm dependencies.
 * Coordinates are PHYSICAL screen pixels (the backend sets
 * DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 at startup).
 *
 * Cross-monitor: coordinates use the Windows virtual screen, whose origin
 * may be negative when a secondary monitor sits left/above the primary.
 *
 * v0.2: window management (computer_window), window-scoped screenshots,
 * background (focus-preserving) input to a specific window, and UIA
 * element-level lookup/invocation (computer_find / computer_invoke).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const BACKEND_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "backend.ps1");

/** Resolve a PowerShell executable: prefer PATH, fall back to the standard system locations. */
function resolvePowerShell(): string {
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of pathDirs) {
		const candidate = path.join(dir, "powershell.exe");
		if (existsSync(candidate)) return candidate;
	}
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	for (const candidate of [
		path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return "powershell.exe"; // let spawn produce a useful ENOENT error
}
const RPC_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Backend host: PowerShell child process, JSON-RPC (one JSON object per line)
// ---------------------------------------------------------------------------

class Backend {
	private proc: ChildProcess | null = null;
	private seq = 0;
	private buffer = "";
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private startPromise: Promise<void> | null = null;

	private ensureStarted(): Promise<void> {
		if (this.proc) return Promise.resolve();
		if (this.startPromise) return this.startPromise;
		this.startPromise = new Promise<void>((resolve, reject) => {
			const proc = spawn(
				resolvePowerShell(),
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", BACKEND_PATH],
				{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
			);
			let stderrTail = "";
			proc.stderr?.on("data", (d: Buffer) => {
				stderrTail = (stderrTail + d.toString("utf8")).slice(-4000);
			});
			proc.stdout?.on("data", (d: Buffer) => this.onStdout(d));
			proc.on("error", (err) => {
				this.failAll(new Error(`backend spawn failed: ${err.message}`));
				this.proc = null;
				this.startPromise = null;
				reject(err);
			});
			proc.on("exit", (code) => {
				this.proc = null;
				this.startPromise = null;
				this.failAll(new Error(`backend exited (code ${code}): ${stderrTail.trim() || "no stderr"}`));
			});
			this.proc = proc;
			// Warmup/ping also proves the C# Add-Type compiled successfully.
			this.call("ping", {}, 60_000)
				.then(() => resolve())
				.catch((err) => reject(err))
				.finally(() => {
					this.startPromise = null;
				});
		});
		return this.startPromise;
	}

	private onStdout(d: Buffer) {
		this.buffer += d.toString("utf8");
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // backend wrote non-JSON noise; ignore
			}
			const entry = this.pending.get(msg.id);
			if (!entry) continue;
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.ok) entry.resolve(msg.result);
			else entry.reject(new Error(msg.error ?? "backend error"));
		}
	}

	private failAll(err: Error) {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(err);
			this.pending.delete(id);
		}
	}

	async call(method: string, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
		await this.ensureStarted();
		if (!this.proc?.stdin) throw new Error("backend is not running");
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`backend call "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
		});
	}

	async shutdown() {
		const proc = this.proc;
		if (!proc) return;
		this.proc = null;
		try {
			await this.call("shutdown", {}, 3000);
		} catch {
			try {
				proc.kill();
			} catch {
				/* ignore */
			}
		}
	}
}

const backend = new Backend();

// ---------------------------------------------------------------------------
// Keyboard: "ctrl+shift+s" / "enter" -> virtual key codes (parsed in JS)
// ---------------------------------------------------------------------------

const NAMED_KEYS: Record<string, number> = {
	enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b,
	backspace: 0x08, space: 0x20, spacebar: 0x20,
	up: 0x26, down: 0x28, left: 0x25, right: 0x27,
	home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
	insert: 0x2d, ins: 0x2d, delete: 0x2e, del: 0x2e,
	ctrl: 0xa2, control: 0xa2, lctrl: 0xa2, rctrl: 0xa3,
	shift: 0xa0, lshift: 0xa0, rshift: 0xa1,
	alt: 0xa4, lalt: 0xa4, ralt: 0xa5,
	win: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
	capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2c,
	pause: 0x13, contextmenu: 0x5d, apps: 0x5d,
};

export function parseKeyCombo(combo: string): number[] {
	const parts = combo
		.split("+")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (parts.length === 0) throw new Error(`Empty key combo`);
	return parts.map((name) => {
		if (name.length === 1) {
			const c = name.toUpperCase();
			if (/[A-Z0-9]/.test(c)) return c.charCodeAt(0);
		}
		const f = /^f([1-9]|1[0-2])$/.exec(name);
		if (f) return 0x6f + Number(f[1]);
		const vk = NAMED_KEYS[name];
		if (vk !== undefined) return vk;
		throw new Error(`Unknown key name: "${name}". Use letters/digits, F1-F12, or names like enter/ctrl/alt/shift/tab/esc.`);
	});
}

/** Send type text base64(utf8)-encoded so PowerShell console code pages never corrupt CJK. */
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Screenshot helper shared by computer_screenshot and computer_action
// ---------------------------------------------------------------------------

const ScreenshotParams = {
	maxWidth: Type.Optional(Type.Number({ description: "Downscale so the delivered image is at most this wide. Default 1568; use 0 for full resolution." })),
	maxHeight: Type.Optional(Type.Number({ description: "Downscale so the delivered image is at most this tall. 0 = unconstrained (default)." })),
	format: Type.Optional(StringEnum(["jpeg", "png"] as const, { description: "Image encoding. jpeg (default) is much smaller; png is lossless." })),
	quality: Type.Optional(Type.Number({ description: "JPEG quality 1-100. Default 70." })),
};

interface ShotResult {
	image: string;
	regionX: number; regionY: number; regionWidth: number; regionHeight: number;
	imageWidth: number; imageHeight: number;
	virtualLeft: number; virtualTop: number; virtualWidth: number; virtualHeight: number;
	mimeType: string;
}

async function takeScreenshot(params: {
	x?: number; y?: number; width?: number; height?: number; maxWidth?: number; maxHeight?: number; format?: string; quality?: number;
}) {
	const maxW = clampInt(params.maxWidth, 0, 8192, 1568);
	const maxH = clampInt(params.maxHeight, 0, 8192, 0);
	const r: ShotResult = await backend.call("screenshot", {
		x: Math.round(params.x ?? 0),
		y: Math.round(params.y ?? 0),
		w: Math.round(params.width ?? 0),
		h: Math.round(params.height ?? 0),
		maxW,
		maxH,
		fmt: params.format === "png" ? "png" : "jpeg",
		quality: clampInt(params.quality, 1, 100, 70),
	});
	const sx = r.regionWidth / r.imageWidth;
	const sy = r.regionHeight / r.imageHeight;
	const text =
		`Screenshot captured. Region (${r.regionX},${r.regionY}) ${r.regionWidth}x${r.regionHeight}, ` +
		`image delivered at ${r.imageWidth}x${r.imageHeight}. ` +
		`Coordinate system: PHYSICAL pixels of the virtual screen (${r.virtualWidth}x${r.virtualHeight} starting at (${r.virtualLeft},${r.virtualTop})). ` +
		(sx > 1.001 || sy > 1.001
			? `The image is downscaled ~${sx.toFixed(2)}x: multiply any (x,y) you read from the image by ${sx.toFixed(3)} and add (${r.regionX},${r.regionY}) to get physical coordinates.`
			: `Image coordinates equal physical coordinates plus offset (${r.regionX},${r.regionY}).`);
	return { r, text };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piComputerControl(pi: ExtensionAPI) {
	// Session-level safety switch: when disabled, all control tools refuse to run.
	let enabled = true;

	function guard() {
		if (!enabled) throw new Error("computer-control is disabled in this session. Re-enable it with the /computer-control command (off -> on).");
	}

	// WindowRef: address a window either by its hwnd handle (from listWindows)
	// or by a 0-based index into the most recent listWindows result.
	const WindowRef = {
		hwnd: Type.Optional(Type.Number({ description: "Window handle (hwnd) from computer_window list." })),
		index: Type.Optional(Type.Number({ description: "0-based index into the most recent computer_window list result (alternative to hwnd)." })),
	};

	function windowRefDesc(): string {
		return "Provide hwnd (from computer_window list) or index (0-based position in the last list result).";
	}

	async function resolveHwnd(params: { hwnd?: number; index?: number }): Promise<number> {
		if (params.hwnd !== undefined) return Math.round(params.hwnd);
		if (params.index !== undefined) return -Math.round(params.index) - 1; // negative index encoding -> backend resolves via last list
		throw new Error(windowRefDesc());
	}

	const ScreenshotToolParams = Type.Object({
		x: Type.Optional(Type.Number({ description: "Region left (physical px). Omit for full virtual screen." })),
		y: Type.Optional(Type.Number({ description: "Region top (physical px)." })),
		width: Type.Optional(Type.Number({ description: "Region width (physical px)." })),
		height: Type.Optional(Type.Number({ description: "Region height (physical px)." })),
		...ScreenshotParams,
	});

	function makeScreenshotTool() {
		return {
			name: "computer_screenshot",
			label: "Computer Screenshot",
			description:
				"Take a screenshot of the Windows desktop (full virtual screen or a region) and return it as an image you can see. " +
				"Use this FIRST to ground any mouse/keyboard action in real coordinates.",
			promptSnippet: "See the screen; run before acting so coordinates are grounded.",
			promptGuidelines: [
				"Always call computer_screenshot before the first computer_action of a task, and again after actions when you need to verify their effect.",
				"computer_action coordinates are physical screen pixels; when the screenshot image is downscaled, multiply image coordinates by the scale factor stated in the screenshot result.",
			],
			parameters: ScreenshotToolParams,
			async execute(_id: string, params: any) {
				guard();
				const { r, text } = await takeScreenshot(params);
				return {
					content: [
						{ type: "text", text },
						{ type: "image", data: r.image, mimeType: r.mimeType },
					],
					details: {
						regionX: r.regionX, regionY: r.regionY, regionWidth: r.regionWidth, regionHeight: r.regionHeight,
						imageWidth: r.imageWidth, imageHeight: r.imageHeight,
						virtualWidth: r.virtualWidth, virtualHeight: r.virtualHeight,
					},
				};
			},
		};
	}

	const MouseButton = StringEnum(["left", "right", "middle"] as const);
	const ActionSchema = Type.Union([
		Type.Object({ type: Type.Literal("move"), x: Type.Number(), y: Type.Number() }),
		Type.Object({
			type: Type.Literal("click"), x: Type.Number(), y: Type.Number(),
			button: Type.Optional(MouseButton),
			count: Type.Optional(Type.Number({ description: "1 = single click (default), 2 = double click", minimum: 1, maximum: 3 })),
		}),
		Type.Object({
			type: Type.Literal("drag"),
			x1: Type.Number(), y1: Type.Number(), x2: Type.Number(), y2: Type.Number(),
			button: Type.Optional(MouseButton),
			steps: Type.Optional(Type.Number({ description: "Interpolation steps, default 20" })),
		}),
		Type.Object({
			type: Type.Literal("scroll"),
			x: Type.Optional(Type.Number({ description: "If x/y are given the cursor moves there first (wheel events go to the window under the cursor)." })),
			y: Type.Optional(Type.Number()),
			deltaY: Type.Optional(Type.Number({ description: "Wheel notches: negative scrolls DOWN (content moves up), positive scrolls UP. Default -3." })),
			deltaX: Type.Optional(Type.Number({ description: "Horizontal wheel notches. Default 0." })),
		}),
		Type.Object({
			type: Type.Literal("type"),
			text: Type.String({ description: "Text typed literally, including CJK/unicode. Types into whatever currently has keyboard focus — click the target field first." }),
		}),
		Type.Object({
			type: Type.Literal("key"),
			keys: Type.String({ description: 'Key or combo, e.g. "enter", "tab", "esc", "f5", "ctrl+c", "ctrl+shift+s", "alt+tab".' }),
		}),
		Type.Object({ type: Type.Literal("wait"), ms: Type.Number({ description: "Sleep between actions, for UI settling." }) }),
	]);
	type Action = Static<typeof ActionSchema>;

	// Index-based window references are encoded as negative numbers so the backend
	// resolves them against its last listWindows result without extra state here.
	function encodeWindowRef(params: { hwnd?: number; index?: number }): number {
		if (params.hwnd !== undefined) return Math.round(params.hwnd);
		if (params.index !== undefined) return -(Math.round(params.index) + 1);
		throw new Error("Provide 'hwnd' or 'index' to identify the target window.");
	}

	function makeActionTool() {
		return {
			name: "computer_action",
			label: "Computer Action",
			description:
				"Execute a batch of real mouse/keyboard actions on the Windows desktop: move, click (single/double), drag, scroll, " +
				"type text (unicode/CJK via synthetic input), press key combos, wait. " +
				"Coordinates are physical pixels of the virtual screen. Set screenshot=true to receive a screenshot after the batch.",
			promptSnippet: "Act on the screen: click, drag, type, press keys, scroll — batched, with optional follow-up screenshot.",
			promptGuidelines: [
				"Batch dependent steps into ONE computer_action call (e.g. click into a field, then type, then press enter), and set screenshot=true when you need to see the outcome instead of calling computer_screenshot separately.",
				"For text input: click the target field first, then pass a type action WITHOUT coordinates — input goes to the focused control.",
			],
			parameters: Type.Object({
				actions: Type.Array(ActionSchema, { minItems: 1, maxItems: 30 }),
				screenshot: Type.Optional(Type.Boolean({ description: "Return a screenshot after the batch completes (default false)." })),
				maxWidth: ScreenshotParams.maxWidth,
				maxHeight: ScreenshotParams.maxHeight,
				format: ScreenshotParams.format,
				quality: ScreenshotParams.quality,
			}),
			async execute(_id: string, params: any) {
				guard();
				const lines: string[] = [];
				for (const [i, a] of params.actions.entries()) {
					const label = `#${i + 1} ${a.type}`;
					try {
						switch (a.type) {
							case "move": {
								const p = await backend.call("move", { x: Math.round(a.x), y: Math.round(a.y) });
								lines.push(`${label} -> cursor at (${p.x},${p.y})`);
								break;
							}
							case "click":
								await backend.call("click", { x: Math.round(a.x), y: Math.round(a.y), button: a.button ?? "left", count: a.count ?? 1 });
								lines.push(`${label} ${a.button ?? "left"} x${a.count ?? 1} at (${Math.round(a.x)},${Math.round(a.y)})`);
								break;
							case "drag":
								await backend.call("drag", {
									x1: Math.round(a.x1), y1: Math.round(a.y1), x2: Math.round(a.x2), y2: Math.round(a.y2),
									button: a.button ?? "left", steps: a.steps ?? 20,
								});
								lines.push(`${label} (${Math.round(a.x1)},${Math.round(a.y1)}) -> (${Math.round(a.x2)},${Math.round(a.y2)})`);
								break;
							case "scroll":
								await backend.call("scroll", {
									...(a.x !== undefined ? { x: Math.round(a.x) } : {}),
									...(a.y !== undefined ? { y: Math.round(a.y) } : {}),
									deltaY: Math.round(a.deltaY ?? -3), deltaX: Math.round(a.deltaX ?? 0),
								});
								lines.push(`${label} deltaY=${Math.round(a.deltaY ?? -3)} deltaX=${Math.round(a.deltaX ?? 0)}`);
								break;
							case "type":
								await backend.call("type", { textB64: b64(a.text) }, 60_000);
								lines.push(`${label} ${a.text.length} chars`);
								break;
							case "key": {
								const vks = parseKeyCombo(a.keys);
								await backend.call("key", { vks });
								lines.push(`${label} ${a.keys}`);
								break;
							}
							case "wait":
								await new Promise((r2) => setTimeout(r2, clampInt(a.ms, 0, 30_000, 500)));
								lines.push(`${label} ${a.ms}ms`);
								break;
						}
					} catch (err) {
						lines.push(`${label} FAILED: ${err instanceof Error ? err.message : String(err)}`);
						return {
							content: [{ type: "text", text: `Batch aborted at action ${i + 1}/${params.actions.length}.\n` + lines.join("\n") }],
							isError: true,
						};
					}
				}
				const content: any[] = [{ type: "text", text: lines.join("\n") || "No actions." }];
				if (params.screenshot) {
					const { r, text } = await takeScreenshot(params);
					content.push({ type: "text", text }, { type: "image", data: r.image, mimeType: r.mimeType });
				}
				return { content };
			},
		};
	}

	const infoTool = {
		name: "computer_info",
		label: "Computer Info",
		description:
			"Get screen metrics (virtual screen size, which may start at negative coordinates with multiple monitors), " +
			"current cursor position, and the active window title. Also serves as a health check for the control backend.",
		promptSnippet: "Screen size, cursor position, active window; backend health check.",
		parameters: Type.Object({}),
		async execute(_id: string) {
			guard();
			const info = await backend.call("screenInfo");
			return {
				content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
				details: info,
			};
		},
	};

	// ------------------------------------------------------------------
	// v0.2: window management
	// ------------------------------------------------------------------
	const windowTool = {
		name: "computer_window",
		label: "Computer Window",
		description:
			"Window management for the Windows desktop. Actions:\n" +
			"- list: enumerate visible top-level windows (title, hwnd, position, size, minimized/maximized, foreground). Supports a title substring filter.\n" +
			"- info: details about one window (client area size, class name, pid).\n" +
			"- activate: bring a window to the foreground.\n" +
			"- minimize / maximize / restore / hide / show: window state.\n" +
			"- move: position and/or resize a window (x, y, width, height; omitted values keep the current ones).\n" +
			"- close: politely ask the window to close (WM_CLOSE; app may prompt).",
		promptSnippet: "List, activate, move, resize, minimize or close desktop windows.",
		promptGuidelines: [
			"Use computer_window list first and pass the returned hwnd to subsequent window operations.",
			"Window coordinates (x, y, width, height) are physical pixels, consistent with screenshots.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "info", "activate", "minimize", "maximize", "restore", "hide", "show", "move", "close"] as const, {
				description: "Window management action.",
			}),
			filter: Type.Optional(Type.String({ description: "(list) case-insensitive title substring filter; empty = all windows." })),
			limit: Type.Optional(Type.Number({ description: "(list) max windows to return. Default 40." })),
			hwnd: WindowRef.hwnd,
			index: WindowRef.index,
			x: Type.Optional(Type.Number({ description: "(move) new left position (physical px)." })),
			y: Type.Optional(Type.Number({ description: "(move) new top position (physical px)." })),
			width: Type.Optional(Type.Number({ description: "(move) new width (physical px)." })),
			height: Type.Optional(Type.Number({ description: "(move) new height (physical px)." })),
		}),
		async execute(_id: string, params: any) {
			guard();
			switch (params.action) {
				case "list": {
					const r = await backend.call("listWindows", { filter: params.filter ?? "", limit: params.limit ?? 40 });
					const text = r.total === 0
						? "No visible top-level windows matched."
						: `${r.total} windows (showing ${r.shown}):\n` + r.windows.map((w: any, i: number) =>
							`[${i}] hwnd=${w.hwnd} "${w.title}" ${w.width}x${w.height} @(${w.x},${w.y})${w.minimized ? " minimized" : ""}${w.maximized ? " maximized" : ""}${w.foreground ? " [foreground]" : ""}`
						).join("\n");
					return { content: [{ type: "text", text }], details: r };
				}
				case "info": {
					const r = await backend.call("windowInfo", { hwnd: encodeWindowRef(params) });
					return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], details: r };
				}
				case "activate":
					await backend.call("activateWindow", { hwnd: encodeWindowRef(params) });
					return { content: [{ type: "text", text: "Window activated." }] };
				case "minimize":
				case "maximize":
				case "restore":
				case "hide":
				case "show":
					await backend.call("setWindowState", { hwnd: encodeWindowRef(params), state: params.action });
					return { content: [{ type: "text", text: `Window ${params.action}d.` }] };
				case "move": {
					const info: any = await backend.call("windowInfo", { hwnd: encodeWindowRef(params) });
					const x = params.x !== undefined ? Math.round(params.x) : info.x;
					const y = params.y !== undefined ? Math.round(params.y) : info.y;
					const w = params.width !== undefined ? Math.round(params.width) : info.width;
					const hgt = params.height !== undefined ? Math.round(params.height) : info.height;
					const r = await backend.call("moveWindow", { hwnd: encodeWindowRef(params), x, y, width: w, height: hgt });
					return { content: [{ type: "text", text: `Window moved to (${r.x},${r.y}) ${r.width}x${r.height}.` }], details: r };
				}
				case "close":
					await backend.call("closeWindow", { hwnd: encodeWindowRef(params) });
					return { content: [{ type: "text", text: "Close request sent to the window." }] };
			}
		},
	};

	// Window-scoped screenshot (works even when the window is not in the foreground, best effort)
	const windowScreenshotTool = {
		name: "computer_window_screenshot",
		label: "Computer Window Screenshot",
		description:
			"Capture a screenshot of a specific window (identified by hwnd) instead of the whole screen. " +
			"Uses PrintWindow and usually works even when the window is partially covered (NOT while minimized). " +
			"The returned coordinates are still physical screen pixels (region = window bounds), so you can click what you see.",
		promptSnippet: "Screenshot one window via hwnd, even if covered.",
		parameters: Type.Object({
			hwnd: Type.Optional(Type.Number({ description: "Window handle from computer_window list." })),
			index: Type.Optional(Type.Number({ description: "0-based index into the last computer_window list." })),
			maxWidth: ScreenshotParams.maxWidth,
			maxHeight: ScreenshotParams.maxHeight,
			format: ScreenshotParams.format,
			quality: ScreenshotParams.quality,
		}),
		async execute(_id: string, params: any) {
			guard();
			const r: ShotResult = await backend.call("windowScreenshot", {
				hwnd: encodeWindowRef(params),
				maxW: clampInt(params.maxWidth, 0, 8192, 1568),
				maxH: clampInt(params.maxHeight, 0, 8192, 0),
				fmt: params.format === "png" ? "png" : "jpeg",
				quality: clampInt(params.quality, 1, 100, 70),
			});
			const sx = r.regionWidth / r.imageWidth;
			const text =
				`Window screenshot. Region (${r.regionX},${r.regionY}) ${r.regionWidth}x${r.regionHeight}, image ${r.imageWidth}x${r.imageHeight}. ` +
				(sx > 1.001
					? `Image downscaled ~${sx.toFixed(2)}x: multiply image coordinates by ${sx.toFixed(3)} and add (${r.regionX},${r.regionY}) for physical coordinates.`
					: `Image coordinates equal physical coordinates plus offset (${r.regionX},${r.regionY}).`);
			return {
				content: [{ type: "text", text }, { type: "image", data: r.image, mimeType: r.mimeType }],
				details: { regionX: r.regionX, regionY: r.regionY, imageWidth: r.imageWidth, imageHeight: r.imageHeight },
			};
		},
	};

	// ------------------------------------------------------------------
	// v0.2: background (focus-preserving) input
	// ------------------------------------------------------------------
	const bgActionTool = {
		name: "computer_bg_action",
		label: "Computer Background Action",
		description:
			"Send keyboard/mouse input to a SPECIFIC WINDOW without moving the mouse or stealing keyboard focus " +
			"(via PostMessage). The user can keep working in the foreground while the agent drives a background window.\n" +
			"Actions: click (x,y are CLIENT-AREA coordinates, relative to the window's top-left), doubleClick, scroll, type, key.\n" +
			"IMPORTANT compatibility notes: works best with classic Win32 controls and many WinForms/WPF apps. " +
			"Apps with custom input pipelines (Chromium/Electron browsers, WinUI3) may ignore synthetic background input — " +
			"fall back to computer_action (foreground) for those. Typing targets the window's focused child control.",
		promptSnippet: "Type/click/scroll inside a specific window without stealing focus.",
		promptGuidelines: [
			"Use computer_window list to get the hwnd, then batch background steps into ONE computer_bg_action call (click into a field, then type, then key).",
			"For window-scoped screenshots use computer_window_screenshot. Prefer UIA (computer_find/computer_invoke) for controls that support it.",
			"If background input has no effect (e.g. Chromium apps), fall back to foreground computer_action.",
		],
		parameters: Type.Object({
			hwnd: Type.Optional(Type.Number({ description: "Target window handle from computer_window list." })),
			index: Type.Optional(Type.Number({ description: "0-based index into the last computer_window list." })),
			actions: Type.Array(Type.Union([
				Type.Object({ type: Type.Literal("click"), x: Type.Number(), y: Type.Number(), button: Type.Optional(MouseButton), double: Type.Optional(Type.Boolean({ description: "true = double click" })) }),
				Type.Object({ type: Type.Literal("scroll"), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), deltaY: Type.Optional(Type.Number({ description: "Negative scrolls down. Default -3." })), deltaX: Type.Optional(Type.Number()) }),
				Type.Object({ type: Type.Literal("type"), text: Type.String({ description: "Text typed into the window's focused control (CJK supported)." }) }),
				Type.Object({ type: Type.Literal("key"), keys: Type.String({ description: 'Key or combo, e.g. "enter", "ctrl+s".' }) }),
				Type.Object({ type: Type.Literal("wait"), ms: Type.Number({ description: "Sleep between actions, 0-30000." }) }),
			]), { minItems: 1, maxItems: 30 }),
		}),
		async execute(_id: string, params: any) {
			guard();
			const hwnd = encodeWindowRef(params);
			const lines: string[] = [];
			for (const [i, a] of params.actions.entries()) {
				const label = `#${i + 1} bg.${a.type}`;
				try {
					switch (a.type) {
						case "click":
							await backend.call(a.double ? "bgDoubleClick" : "bgClick", { hwnd, x: Math.round(a.x), y: Math.round(a.y), button: a.button ?? "left" });
							lines.push(`${label} ${a.button ?? "left"}${a.double ? " x2" : ""} at client (${Math.round(a.x)},${Math.round(a.y)})`);
							break;
						case "scroll":
							await backend.call("bgScroll", {
								hwnd,
								...(a.x !== undefined ? { x: Math.round(a.x) } : {}),
								...(a.y !== undefined ? { y: Math.round(a.y) } : {}),
								deltaY: Math.round(a.deltaY ?? -3), deltaX: Math.round(a.deltaX ?? 0),
							});
							lines.push(`${label} deltaY=${Math.round(a.deltaY ?? -3)}`);
							break;
						case "type":
							await backend.call("bgType", { hwnd, textB64: b64(a.text) }, 60_000);
							lines.push(`${label} ${a.text.length} chars`);
							break;
						case "key": {
							const vks = parseKeyCombo(a.keys);
							await backend.call("bgKey", { hwnd, vks });
							lines.push(`${label} ${a.keys}`);
							break;
						}
						case "wait":
							await new Promise((r2) => setTimeout(r2, clampInt(a.ms, 0, 30_000, 500)));
							lines.push(`${label} ${a.ms}ms`);
							break;
					}
				} catch (err) {
					lines.push(`${label} FAILED: ${err instanceof Error ? err.message : String(err)}`);
					return {
						content: [{ type: "text", text: `Background batch aborted at action ${i + 1}/${params.actions.length}.\n` + lines.join("\n") }],
						isError: true,
					};
				}
			}
			return { content: [{ type: "text", text: lines.join("\n") || "No actions." }] };
		},
	};

	// ------------------------------------------------------------------
	// v0.2: UIA element-level find & invoke
	// ------------------------------------------------------------------
	const WindowRefFields = {
		hwnd: Type.Optional(Type.Number({ description: "Window handle from computer_window list." })),
		index: Type.Optional(Type.Number({ description: "0-based index into the last computer_window list." })),
	};

	const findTool = {
		name: "computer_find",
		label: "Computer Find",
		description:
			"Find UI elements (buttons, text boxes, menu items...) inside a window using UI Automation, WITHOUT pixel guessing. " +
			"Filter by visible text (name substring), automationId and/or control type. Returns each match's bounding box " +
			"(centerX/centerY are ready-to-use physical coordinates for computer_action clicks) and its current state.",
		promptSnippet: "Find a control by name/type and get its exact coordinates.",
		promptGuidelines: [
			"Prefer computer_find over screenshot-based coordinate guessing whenever you know the control's label.",
			"Combine filters to narrow results; increase limit to scan more elements (default 15).",
		],
		parameters: Type.Object({
			...WindowRefFields,
			name: Type.Optional(Type.String({ description: "Case-insensitive substring of the element's visible name/text." })),
			automationId: Type.Optional(Type.String({ description: "Case-insensitive substring of the element's automationId." })),
			controlType: Type.Optional(Type.String({ description: 'Control type filter, e.g. "button", "edit", "document", "menuItem", "checkBox".' })),
			limit: Type.Optional(Type.Number({ description: "Max matches to return. Default 15." })),
		}),
		async execute(_id: string, params: any) {
			guard();
			if (params.name === undefined && params.automationId === undefined && params.controlType === undefined)
				throw new Error("Provide at least one filter: name, automationId or controlType.");
			const r = await backend.call("findElements", {
				hwnd: encodeWindowRef(params),
				name: params.name ?? "",
				automationId: params.automationId ?? "",
				controlType: params.controlType ?? "",
				limit: params.limit ?? 15,
			}, 90_000);
			const text = r.elements.length === 0
				? "No matching elements found. Try a shorter name substring or a different filter."
				: r.elements.map((e: any, i: number) =>
					`[${i}] ${e.controlType} "${e.name}"${e.automationId ? ` id="${e.automationId}"` : ""}${e.enabled ? "" : " [disabled]"} center=(${e.centerX},${e.centerY}) ${e.width}x${e.height}`
				).join("\n");
			return { content: [{ type: "text", text }], details: r };
		},
	};

	const invokeTool = {
		name: "computer_invoke",
		label: "Computer Invoke",
		description:
			"Invoke a UI element found by computer_find without clicking coordinates: uses the UIA Invoke/Toggle/Select/Expand pattern " +
			"when available, otherwise falls back to a real mouse click at the element's center. This is the most reliable way to " +
			"press buttons, toggle checkboxes and select list items.",
		promptSnippet: "Press a button/toggle a control by name (UIA), no coordinates needed.",
		parameters: Type.Object({
			...WindowRefFields,
			name: Type.Optional(Type.String({ description: "Case-insensitive substring of the element's visible name/text." })),
			automationId: Type.Optional(Type.String({ description: "Case-insensitive substring of the element's automationId." })),
		}),
		async execute(_id: string, params: any) {
			guard();
			if (params.name === undefined && params.automationId === undefined)
				throw new Error("Provide 'name' or 'automationId' of the element to invoke.");
			const r = await backend.call("invokeElement", {
				hwnd: encodeWindowRef(params),
				name: params.name ?? "",
				automationId: params.automationId ?? "",
			}, 90_000);
			return {
				content: [{ type: "text", text: `${r.action}: ${r.controlType} "${r.name}" at (${r.centerX},${r.centerY})` }],
				details: r,
			};
		},
	};

	// ------------------------------------------------------------------
	// v0.2: progressive disclosure help
	// ------------------------------------------------------------------
	const helpTool = {
		name: "computer_help",
		label: "Computer Help",
		description:
			"Detailed usage guide for the computer-control tool family: recommended workflows (see-act-verify loop, " +
			"window-scoped background control, UIA-first strategy), coordinate systems, background-input compatibility " +
			"notes, and troubleshooting. Load this when a computer_* tool call fails or behaves unexpectedly.",
		promptSnippet: "Detailed computer-control usage guide (load on demand).",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: HELP_TEXT }] };
		},
	};

	pi.registerTool(makeScreenshotTool() as any);
	pi.registerTool(makeActionTool() as any);
	pi.registerTool(infoTool as any);
	pi.registerTool(windowTool as any);
	pi.registerTool(windowScreenshotTool as any);
	pi.registerTool(bgActionTool as any);
	pi.registerTool(findTool as any);
	pi.registerTool(invokeTool as any);
	pi.registerTool(helpTool as any);

	pi.registerCommand("computer-control", {
		description: "Show backend status; toggle the session switch with on|off|status",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "off") {
				enabled = false;
				ctx.ui.notify("computer-control: DISABLED for this session (tools will refuse to run).", "info");
				return;
			}
			if (sub === "on") {
				enabled = true;
				ctx.ui.notify("computer-control: ENABLED for this session.", "info");
				return;
			}
			try {
				const info = await backend.call("screenInfo");
				const state = enabled ? "enabled" : "DISABLED";
				ctx.ui.notify(
					`computer-control v${info.backendVersion ?? "?"} (${state}) — screen ${info.virtualWidth}x${info.virtualHeight} @(${info.virtualLeft},${info.virtualTop}), ` +
						`cursor (${info.cursorX},${info.cursorY}), dpi ${info.dpi}, active: "${info.activeWindowTitle}"` +
						(sub === "status" ? "" : " — use /computer-control on|off to toggle"),
					info.backendVersion === "0.2.0" ? "info" : "info",
				);
			} catch (err) {
				ctx.ui.notify(`computer-control backend error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await backend.shutdown();
	});
}

const HELP_TEXT = `computer-control usage guide
============================

TOOLS OVERVIEW
- computer_screenshot: full-screen or region screenshot (physical px coordinates)
- computer_window_screenshot: screenshot ONE window (works when covered, not minimized)
- computer_action: batched FOREGROUND mouse/keyboard (move/click/drag/scroll/type/key/wait) + optional screenshot
- computer_bg_action: batched BACKGROUND input to one window (no focus stealing)
- computer_window: list/info/activate/minimize/maximize/restore/hide/show/move/close windows
- computer_find: UIA element search by name/automationId/controlType -> exact coordinates
- computer_invoke: press/toggle/select a UIA element without coordinates
- computer_info: screen metrics, cursor, active window, backend health/version

RECOMMENDED WORKFLOWS
1. Foreground automation: screenshot -> computer_action (batch!) with screenshot:true -> verify.
2. Background automation: computer_window list -> computer_window_screenshot to see it ->
   computer_bg_action batches (client-area coordinates!) -> verify with computer_window_screenshot.
3. UIA-first: computer_window list -> computer_find (name filter) -> computer_invoke.
   Fall back to coordinate clicks only when UIA finds nothing.

COORDINATE SYSTEMS
- computer_action / computer_find / computer_window: PHYSICAL screen pixels of the virtual
  screen (multi-monitor origins can be negative). Screenshot results state the scale factor
  when the image was downscaled.
- computer_bg_action: CLIENT-AREA coordinates relative to the target window's top-left corner.
  Use windowInfo's clientWidth/clientHeight or the window position to convert.

BACKGROUND INPUT COMPATIBILITY
- Works: classic Win32 controls (EDIT, buttons), most WinForms/WPF apps, many others.
- Often ignored: Chromium/Electron (browsers, VS Code, Slack...), WinUI3/UWP apps.
  If a bg action has no visible effect, switch to foreground computer_action.
- bg type targets the window's currently focused child control; bg key works for shortcuts
  handled by the app. The user's mouse/keyboard are never grabbed.

TROUBLESHOOTING
- Backend spawns lazily on first call; it restarts automatically after a crash.
- If clicks land in the wrong place, re-take a screenshot and check the scale factor note.
- UIA scans can be slow on huge windows; narrow filters or raise the tool timeout.
- Disable all desktop control for this session with /computer-control off (re-enable with on).`;
