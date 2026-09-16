/**
 * pi-schedule 端到端冒烟（不打 HTTP，直接调服务层）。
 *
 * 覆盖：建任务 → 执行一次（真模型）→ 校验 run 记录 + 会话文件 → fork 续聊 → 权限白名单生效。
 * 运行：node Agent临时工作/schedule-spike/smoke.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "pi-schedule-smoke-"));
process.env.PI_SCHEDULE_DIR = ROOT;
process.env.PI_SCHEDULE_TZ = process.env.PI_SCHEDULE_TZ ?? "Asia/Shanghai";

const PKG_DIR = join(import.meta.dirname, "..");
const PKG = join(PKG_DIR, "src");
const { createJob } = await import(pathToFileURL(join(PKG, "jobs.ts")).href);
const { Scheduler } = await import(pathToFileURL(join(PKG, "scheduler.ts")).href);
const store = await import(pathToFileURL(join(PKG, "store.ts")).href);

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`数据目录：${ROOT}`);

// 冒烟用显式模型（环境默认 provider 可能被区域限制，属环境问题）
const SMOKE_MODEL = process.env.PI_SCHEDULE_SMOKE_MODEL ?? "5/deepseek-v4.1-flash";
const [smokeProvider, smokeModelId] = SMOKE_MODEL.split("/");
const smokeModel = { provider: smokeProvider, id: smokeModelId };
console.log(`冒烟模型：${SMOKE_MODEL}`);

// 1) 建任务（只读档 + 仅手动）
const job = createJob(
	{
		name: "冒烟-只读",
		prompt: "Reply with exactly: SMOKE_OK — nothing else. Do not call any tool.",
		cwd: PKG_DIR,
		trigger: { type: "manual" },
		permission: "read_only",
		model: smokeModel,
		timeoutMs: 180_000,
	},
	{ by: "smoke" },
);
check("createJob", Boolean(job.id) && job.permission === "read_only", `id=${job.id}`);
check("jobs.json 落盘", existsSync(store.paths().jobsFile));

// 2) 执行一次
const scheduler = new Scheduler({ tickMs: 3_600_000, maxConcurrent: 1 });
const record = await scheduler.trigger(job, { trigger: "manual" });
check("执行完成", record.status === "ok", `status=${record.status} error=${record.error ?? "-"}`);
check("工具白名单=只读", JSON.stringify(record.tools) === JSON.stringify(["read", "grep", "find", "ls"]), JSON.stringify(record.tools));
check("会话文件落盘", Boolean(record.sessionPath && existsSync(record.sessionPath)), record.sessionPath ?? "-");
check(
	"会话文件在 schedule 目录内",
	Boolean(record.sessionPath && record.sessionPath.startsWith(store.paths().sessionsRoot)),
	record.sessionPath ?? "-",
);
check("输出含 SMOKE_OK", record.outputText.includes("SMOKE_OK"), record.outputText.slice(0, 80));
check("usage 有记录", Boolean(record.usage && record.usage.total > 0), JSON.stringify(record.usage));
check("run 记录落盘", existsSync(store.runFile(job.id, record.runId)));
check("台账非空", store.readLedger(10).length > 0, `rows=${store.readLedger(10).length}`);

// 3) fork 续聊（源会话只读不改）
const beforeSrc = readFileSync(record.sessionPath, "utf8");
const reply = await scheduler.trigger(job, {
	trigger: "reply",
	forkFromSessionPath: record.sessionPath,
	forkOfRunId: record.runId,
	replyText: "Reply with exactly: REPLY_OK",
});
const afterSrc = readFileSync(record.sessionPath, "utf8");
check("续聊执行完成", reply.status === "ok", `status=${reply.status} error=${reply.error ?? "-"}`);
check("续聊是新会话", reply.sessionPath !== record.sessionPath, `${reply.runId}`);
check("续聊 forkOf 正确", reply.forkOf === record.runId, reply.forkOf ?? "-");
check("源会话未被修改", beforeSrc === afterSrc);
check("续聊输出含 REPLY_OK", reply.outputText.includes("REPLY_OK"), reply.outputText.slice(0, 80));

// 4) full 档不传白名单
const fullJob = createJob(
	{
		name: "冒烟-全权",
		prompt: "Reply with exactly: FULL_OK",
		cwd: PKG_DIR,
		trigger: { type: "manual" },
		permission: "full",
		model: smokeModel,
		timeoutMs: 180_000,
	},
	{ by: "smoke" },
);
check("full 档审计记为 [*]", JSON.stringify(fullJob.permission) === '"full"' && fullJob.permission === "full");

// 5) 历史/汇总
const runs = store.listRuns(job.id, 10);
check("listRuns 有 2 条", runs.length === 2, `rows=${runs.length}`);
const summaries = runs.map(store.toRunSummary);
check("toRunSummary 正常", summaries.every((s) => s.runId && s.status), JSON.stringify(summaries.map((s) => s.status)));

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length > 0) {
	console.log("失败项：", failed.map((f) => f.name).join(", "));
	console.log(`（数据目录保留以便排查：${ROOT}）`);
	process.exitCode = 1;
} else {
	rmSync(ROOT, { recursive: true, force: true });
	console.log("（已清理临时数据目录）");
}
