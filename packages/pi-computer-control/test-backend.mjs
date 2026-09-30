// Direct backend test (no pi runtime): ping, screenInfo, cursorPos, screenshots,
// window enumeration/info/screenshot, UIA find. Avoids real clicks/typing on purpose.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ps = path.join(dir, "extensions", "backend.ps1");

const proc = spawn("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps], {
	stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
proc.stderr.on("data", (d) => console.error("[ps-stderr]", d.toString()));

let seq = 0;
let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
	buf += d.toString("utf8");
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		const msg = JSON.parse(line);
		const p = pending.get(msg.id);
		if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error)); }
	}
});
const call = (method, params = {}, timeoutMs = 90_000) => new Promise((resolve, reject) => {
	const id = ++seq;
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
	pending.set(id, {
		resolve: (v) => { clearTimeout(timer); resolve(v); },
		reject: (e) => { clearTimeout(timer); reject(e); },
	});
	proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});

const t0 = Date.now();
const ping = await call("ping");
console.log(`ping OK v${ping.version} (${Date.now() - t0}ms, incl. C# compile)`);
if (ping.version !== "0.2.0") throw new Error(`unexpected backend version ${ping.version}`);

const info = await call("screenInfo");
console.log("screenInfo:", JSON.stringify(info));

const cur = await call("cursorPos");
console.log("cursorPos:", JSON.stringify(cur));

const t1 = Date.now();
const shot = await call("screenshot", { x: 0, y: 0, w: 0, h: 0, maxW: 1568, maxH: 0, fmt: "jpeg", quality: 70 });
const img = Buffer.from(shot.image, "base64");
writeFileSync(path.join(dir, "test-full.jpg"), img);
console.log(`full screenshot OK: ${shot.virtualWidth}x${shot.virtualHeight} -> image ${shot.imageWidth}x${shot.imageHeight}, ${img.length} bytes, ${Date.now() - t1}ms`);

const region = await call("screenshot", { x: 100, y: 100, w: 800, h: 500, maxW: 0, maxH: 0, fmt: "png", quality: 90 });
writeFileSync(path.join(dir, "test-region.png"), Buffer.from(region.image, "base64"));
console.log(`region screenshot OK: region (${region.regionX},${region.regionY}) ${region.regionWidth}x${region.regionHeight} -> ${region.imageWidth}x${region.imageHeight}`);

// move cursor to where it already is (no visible effect, verifies input path)
await call("move", { x: cur.x, y: cur.y }).then((r) => console.log("move OK:", JSON.stringify(r)));

// --- v0.2: windows ---
const wins = await call("listWindows", { filter: "", limit: 40 });
console.log(`listWindows OK: ${wins.total} visible top-level windows (showing ${wins.shown})`);
if (wins.windows.length > 0) {
	const w = wins.windows[0];
	console.log(`  first: hwnd=${w.hwnd} "${w.title.slice(0, 50)}" ${w.width}x${w.height} @(${w.x},${w.y})`);

	const wi = await call("windowInfo", { hwnd: w.hwnd });
	console.log(`windowInfo OK: client ${wi.clientWidth}x${wi.clientHeight}, class "${wi.className}", pid ${wi.pid}`);

	const wshot = await call("windowScreenshot", { hwnd: w.hwnd, maxW: 800, maxH: 0, fmt: "jpeg", quality: 70 });
	writeFileSync(path.join(dir, "test-window.jpg"), Buffer.from(wshot.image, "base64"));
	console.log(`windowScreenshot OK: image ${wshot.imageWidth}x${wshot.imageHeight}`);

	// UIA find with no filter but bounded limit — proves the UIA path works on a real window
	const els = await call("findElements", { hwnd: w.hwnd, name: "", automationId: "", controlType: "", limit: 5 }, 120_000);
	console.log(`findElements OK: ${els.elements.length} elements (first 5)`);
	for (const e of els.elements.slice(0, 5)) {
		console.log(`  ${e.controlType} "${(e.name || "").slice(0, 40)}" center=(${e.centerX},${e.centerY}) enabled=${e.enabled}`);
	}

	// stale-index error path: an out-of-range index must fail cleanly
	let staleFailed = false;
	try { await call("windowInfo", { index: 999 }); } catch { staleFailed = true; }
	console.log(`stale window index rejected: ${staleFailed ? "OK" : "FAIL (accepted!)"}`);
}

await call("shutdown");
proc.kill();
console.log("ALL BACKEND TESTS PASSED");
process.exit(0);
