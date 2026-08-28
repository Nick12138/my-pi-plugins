// Smoke test for pi-anytomd: loads the extension with a fake pi and runs
// the anytomd / anytomd_setup tools against real files.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.join(__dirname, "packages", "pi-anytomd", "extensions", "pi-anytomd.ts");

const tools = {};
const fakePi = {
	registerTool(def) {
		tools[def.name] = def;
	},
	on() {},
};

const { default: factory } = await import(pathToFileURL(extPath).href);
await factory(fakePi);

console.log("Registered tools:", Object.keys(tools));

async function run(name, tool, params) {
	console.log(`\n${"=".repeat(64)}\n>>> ${name}\n${"=".repeat(64)}`);
	try {
		const res = await tool.execute("test-call", params, undefined);
		const text = res.content?.[0]?.text ?? "";
		// print first 3000 chars of the returned text
		console.log(text.length > 3000 ? text.slice(0, 3000) + `\n… [truncated, total ${text.length} chars]` : text);
		console.log("\n--- details ---");
		console.log(JSON.stringify(res.details, null, 2));
		return res;
	} catch (err) {
		console.error("THREW:", err);
	}
}

const DESKTOP = "C:/Users/liu/Desktop";

// 1. setup report (read-only)
await run("setup report", tools.anytomd_setup, {});

// 2. docx on Desktop
const docx = await import("node:fs").then((fs) =>
	fs.readdirSync(DESKTOP).find((f) => f.toLowerCase().endsWith(".docx")),
);
if (docx) {
	await run("anytomd docx", tools.anytomd, { paths: [path.join(DESKTOP, docx)] });
} else {
	console.log("\n(no docx on Desktop to test)");
}

// 3. two images → WPS merge path
const img1 = path.join(DESKTOP, "营业执照副本.jpg");
const img2 = path.join(DESKTOP, "徐兆峰_01.png");
const haveImages = [img1, img2].every((p) => import("node:fs").then((fs) => fs.existsSync(p)).catch(() => false));
if (haveImages) {
	await run("anytomd images x2 (WPS)", tools.anytomd, { paths: [img1, img2] });
} else {
	console.log("\n(desktop images missing, skipping image test)");
}

// 4. scanned PDF: regenerate merged pdf from the images
import { execFileSync } from "node:child_process";
const mergedPdf = path.join(DESKTOP, "anytomd-test-merged.pdf");
try {
	execFileSync("wpscli", ["photo2pdf", img1, img2, "-o", mergedPdf], { encoding: "utf-8", windowsHide: true });
	console.log("\n[recreated merged pdf]", mergedPdf);
	await run("anytomd scanned PDF", tools.anytomd, { paths: [mergedPdf] });
	// 5. with outputPath
	const outMd = path.join(DESKTOP, "anytomd-test-output.md");
	await run("anytomd scanned PDF + outputPath", tools.anytomd, { paths: [mergedPdf], outputPath: outMd });
} catch (err) {
	console.error("\n(photo2pdf failed)", err.message);
}
