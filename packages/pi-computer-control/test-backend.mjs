// Direct backend test (no pi runtime): ping, screenInfo, cursorPos, screenshots.
// Avoids real clicks/typing on purpose.
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
const call = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++seq;
	pending.set(id, { resolve, reject });
	proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});

const t0 = Date.now();
await call("ping").then(() => console.log(`ping OK (${Date.now() - t0}ms, incl. C# compile)`));

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

await call("shutdown");
proc.kill();
console.log("ALL BACKEND TESTS PASSED");
process.exit(0);
