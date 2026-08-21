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
	x: Type.Optional(Type.Number({ description: "Region left (physical px). Omit for full virtual screen." })),
	y: Type.Optional(Type.Number({ description: "Region top (physical px)." })),
	width: Type.Optional(Type.Number({ description: "Region width (physical px)." })),
	height: Type.Optional(Type.Number({ description: "Region height (physical px)." })),
	maxWidth: Type.Optional(Type.Number({ description: "Downscale so the delivered image is at most this wide. Default 1568; use 0 for full resolution." })),
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
	x?: number; y?: number; width?: number; height?: number; maxWidth?: number; format?: string; quality?: number;
}) {
	const maxW = clampInt(params.maxWidth, 0, 8192, 1568);
	const r: ShotResult = await backend.call("screenshot", {
		x: Math.round(params.x ?? 0),
		y: Math.round(params.y ?? 0),
		w: Math.round(params.width ?? 0),
		h: Math.round(params.height ?? 0),
		maxW,
		maxH: 0,
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
	pi.registerTool({
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
		parameters: Type.Object(ScreenshotParams),
		async execute(_id, params) {
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
	});

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

	pi.registerTool({
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
			format: ScreenshotParams.format,
			quality: ScreenshotParams.quality,
		}),
		async execute(_id, params) {
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
	});

	pi.registerTool({
		name: "computer_info",
		label: "Computer Info",
		description:
			"Get screen metrics (virtual screen size, which may start at negative coordinates with multiple monitors), " +
			"current cursor position, and the active window title. Also serves as a health check for the control backend.",
		promptSnippet: "Screen size, cursor position, active window; backend health check.",
		parameters: Type.Object({}),
		async execute() {
			const info = await backend.call("screenInfo");
			return {
				content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
				details: info,
			};
		},
	});

	pi.registerCommand("computer-control", {
		description: "Show computer-control backend status (screen size, cursor, active window)",
		handler: async (_args, ctx) => {
			try {
				const info = await backend.call("screenInfo");
				ctx.ui.notify(
					`computer-control OK — screen ${info.virtualWidth}x${info.virtualHeight} @(${info.virtualLeft},${info.virtualTop}), ` +
						`cursor (${info.cursorX},${info.cursorY}), dpi ${info.dpi}, active: "${info.activeWindowTitle}"`,
					"info",
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
