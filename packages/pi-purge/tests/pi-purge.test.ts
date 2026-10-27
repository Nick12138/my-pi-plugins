/**
 * pi-purge standalone test（node --experimental-strip-types 直接执行）:
 *   node --experimental-strip-types packages/pi-purge/tests/pi-purge.test.ts
 * 本文件不在 vitest include 内，遵循本仓库老插件的独立断言脚本惯例。
 *
 * 重点验证“启用可覆盖、禁用必还原”：
 *   - 覆盖发生在渲染后的 systemPrompt 上，不改用户 customPrompt / appendSystemPrompt；
 *   - 禁用时删除本扩展写入的 forceSystemPrompt，原生提示词逐字恢复；
 *   - 用户已有 customPrompt / appendSystemPrompt 原样保留。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import purgify, {
  __getPurgeConfigForTests,
  __internals,
  __resetPurgeForTests,
  __setPurgeConfigForTests,
} from "../extensions/pi-purge.ts";

interface Registered {
  name: string;
  execute?: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

interface PromptOptions {
  customPrompt?: string;
  appendSystemPrompt?: string;
  forceSystemPrompt?: string;
}

interface HandlerResult {
  systemPrompt?: string;
}

const TEST_PREAMBLE = "You are pi in operator mode (test preamble).";
const ADDENDUM_V1 = "<operator_mode>\nTEST ADDENDUM V1\n</operator_mode>";
const ADDENDUM_V2 = "<operator_mode>\nTEST ADDENDUM V2\n</operator_mode>";

function makeMockPi() {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
  const tools: Registered[] = [];
  const commands: string[] = [];
  return {
    handlers,
    tools,
    commands,
    on(type: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
      handlers.set(type, handler);
    },
    registerTool(tool: Registered) {
      tools.push(tool);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  };
}

function mockCtx(hasUI: boolean, opts?: PromptOptions) {
  const notifications: string[] = [];
  return {
    hasUI,
    notifications,
    getSystemPromptOptions: opts ? () => opts : undefined,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };
}

function makeOptions(customPrompt?: string, appendSystemPrompt = ""): PromptOptions & Record<string, unknown> {
  return {
    customPrompt,
    appendSystemPrompt,
    selectedTools: ["read", "bash", "edit", "write"],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    sections: {},
    contextFiles: [],
    skills: [],
    cwd: "C:\\work",
  };
}

const NATIVE_PROMPT = [
  "USER SYSTEM PROMPT",
  "",
  "<tools>",
  "- read: Read files",
  "- bash: Run commands",
  "</tools>",
  "",
  "<rules>",
  "- Be concise",
  "</rules>",
  "",
  "<addendum>",
  "USER APPEND",
  "</addendum>",
  "",
  "<project_context>",
  "project rules",
  "</project_context>",
].join("\n");

async function main() {
  const testDir = mkdtempSync(join(tmpdir(), "pi-purge-test-"));
  const statePath = join(testDir, "state", "config.json");
  const promptDir = join(testDir, "prompts");
  const addendumPath = join(promptDir, "purge-addendum.md");
  const agentDir = join(testDir, "agent");
  const projectDir = join(testDir, "project");

  mkdirSync(promptDir, { recursive: true });
  mkdirSync(join(testDir, "state"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        enabled: true,
        autoTrustProjects: true,
        rememberTrust: false,
        overridePreamble: true,
        appendAddendum: true,
        dropProjectContext: false,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(promptDir, "operator-preamble.md"), `${TEST_PREAMBLE}\n`);
  writeFileSync(addendumPath, `${ADDENDUM_V1}\n`);
  process.env.PI_PURGE_CONFIG_PATH = statePath;
  process.env.PI_PURGE_PROMPTS_DIR = promptDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const pi = makeMockPi();
    purgify(pi as never);

    // 注册面
    assert.ok(pi.handlers.has("session_start"), "session_start handler registered");
    assert.ok(pi.handlers.has("session_shutdown"), "session_shutdown handler registered");
    assert.ok(pi.handlers.has("project_trust"), "project_trust handler registered");
    assert.ok(pi.handlers.has("before_agent_start"), "before_agent_start handler registered");
    const toolNames = pi.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, ["purge_status", "purge_toggle"], "both tools registered");
    assert.deepEqual(pi.commands, ["purge"], "/purge command registered");
    assert.equal(__internals.configPath(), statePath, "state lives outside the package");
    assert.ok(!__internals.configPath().startsWith(__internals.packageRoot()), "state is not in package root");

    const toggle = pi.tools.find((t) => t.name === "purge_toggle")!;
    const status = pi.tools.find((t) => t.name === "purge_status")!;
    const trustHandler = pi.handlers.get("project_trust")!;
    const beforeAgentStart = pi.handlers.get("before_agent_start")!;

    // 模拟 pi runner：handler 返回 systemPrompt 后，runner 会写进 systemPromptOptions.forceSystemPrompt。
    const apply = async (opts: PromptOptions, prompt = "hi"): Promise<string | undefined> => {
      const result = (await beforeAgentStart({
        type: "before_agent_start",
        prompt,
        systemPrompt: NATIVE_PROMPT,
        systemPromptOptions: opts,
      })) as HandlerResult | undefined;
      if (result?.systemPrompt) opts.forceSystemPrompt = result.systemPrompt;
      return result?.systemPrompt;
    };

    // project_trust：默认只放行当前进程，不写 trust.json
    const trustYes = (await trustHandler({ type: "project_trust", cwd: "C:\\x" }, mockCtx(true))) as {
      trusted: string;
      remember?: boolean;
    };
    assert.equal(trustYes.trusted, "yes");
    assert.equal(trustYes.remember, undefined, "default trust is process-local");

    // 显式 rememberTrust=true 才持久化；model 侧工具不允许改这个安全开关
    const rejected = (await toggle.execute!(
      "t0-reject",
      { autoTrustProjects: false },
      undefined,
      undefined,
      undefined,
    )) as { content: { text: string }[] };
    assert.ok(rejected.content[0]!.text.includes("拒绝"), "model tool rejects trust switches");
    assert.equal(__getPurgeConfigForTests().autoTrustProjects, true, "trust switch unchanged by tool");
    __setPurgeConfigForTests({ rememberTrust: true });
    const trustFile = join(agentDir, "trust.json");
    const trustRestoreFile = join(agentDir, "pi-purge", "trust-restore.json");
    await toggle.execute!("t0", { rememberTrust: true }, undefined, undefined, undefined);
    const trustRemember = (await trustHandler({ type: "project_trust", cwd: projectDir }, mockCtx(true))) as {
      trusted: string;
      remember?: boolean;
    };
    assert.equal(trustRemember.remember, true, "rememberTrust=true persists");
    assert.ok(existsSync(trustRestoreFile), "trust restore snapshot written before remember");

    // 模拟 pi 写入 trust.json 后，禁用应删除本扩展写入的 true
    const projectKey = realpathSync(projectDir);
    writeFileSync(trustFile, JSON.stringify({ [projectKey]: true }, null, 2));
    await toggle.execute!("t0b", { enabled: false }, undefined, undefined, undefined);
    const restoredTrust = JSON.parse(readFileSync(trustFile, "utf8")) as Record<string, unknown>;
    assert.equal(restoredTrust[projectKey], undefined, "plugin-added trust entry removed on disable");
    assert.ok(!existsSync(trustRestoreFile), "trust restore snapshot cleared after cleanup");
    await toggle.execute!("t0c", { enabled: true }, undefined, undefined, undefined);

    // 禁用：trust 回到 undecided
    await toggle.execute!("t1", { enabled: false }, undefined, undefined, undefined);
    const trustNo = (await trustHandler({ type: "project_trust", cwd: "C:\\x" }, mockCtx(true))) as {
      trusted: string;
    };
    assert.equal(trustNo.trusted, "undecided");

    // 重新启用，验证“覆盖渲染后的提示词，但不碰用户配置”
    await toggle.execute!("t2", { enabled: true }, undefined, undefined, undefined);
    const opts = makeOptions("USER SYSTEM PROMPT", "USER APPEND");
    const enabledPrompt = await apply(opts);
    assert.ok(enabledPrompt, "enabled returns a forced systemPrompt");
    assert.ok(enabledPrompt!.startsWith(TEST_PREAMBLE), "preamble replaced at the rendered layer");
    assert.ok(!enabledPrompt!.includes("USER SYSTEM PROMPT"), "user custom prompt overridden while enabled");
    assert.ok(enabledPrompt!.includes("<tools>"), "tools section preserved");
    assert.ok(enabledPrompt!.includes("<rules>"), "rules section preserved");
    assert.ok(enabledPrompt!.includes("project rules"), "project context preserved");
    assert.ok(enabledPrompt!.includes("USER APPEND"), "user append text preserved");
    assert.ok(enabledPrompt!.includes("TEST ADDENDUM V1"), "addendum applied");
    const markerCount = () => (enabledPrompt ?? "").split("<operator_mode>").length - 1;
    assert.equal(markerCount(), 1, "addendum appended once");

    // 关键：启用时也不修改用户的 customPrompt / appendSystemPrompt
    assert.equal(opts.customPrompt, "USER SYSTEM PROMPT", "user customPrompt untouched");
    assert.equal(opts.appendSystemPrompt, "USER APPEND", "user appendSystemPrompt untouched");
    assert.equal(opts.forceSystemPrompt, enabledPrompt, "forced prompt tracked");

    // 幂等：再次触发不重复追加
    const enabledAgain = await apply(opts);
    assert.equal(enabledAgain, enabledPrompt, "same forced prompt on repeated turn");
    assert.equal(
      (enabledAgain ?? "").split("<operator_mode>").length - 1,
      1,
      "addendum not duplicated",
    );

    // 技能提醒：只加一行任务提示，不把整份 skill 正文塞进系统提示词
    const normalTask = await apply(opts, "帮我整理这个项目的 README");
    assert.ok(!normalTask?.includes("[pi-purge] This request matches reverse-engineering"), "normal task has no reverse hint");
    const reverseTask = await apply(opts, "帮我逆向这个 macOS 应用的授权校验");
    assert.ok(reverseTask?.includes("[pi-purge] This request matches reverse-engineering"), "reverse task gets the skill hint");
    assert.ok(reverseTask?.includes("`reverse-engineering` skill"), "hint names the skill");
    assert.ok(reverseTask?.includes(TEST_PREAMBLE), "reverse task still carries operator preamble");

    // 逆向/破解 playbook 现在是包内 skill，不再按关键词自动注入整份长提示词。
    const skillPath = join(__internals.packageRoot(), "skills", "reverse-engineering", "SKILL.md");
    const skillText = readFileSync(skillPath, "utf8");
    assert.ok(skillText.startsWith("---\nname: reverse-engineering\n"), "skill frontmatter present");
    assert.ok(skillText.includes("## 1. 任务路由"), "skill contains task routing");
    const pkg = JSON.parse(readFileSync(join(__internals.packageRoot(), "package.json"), "utf8")) as {
      pi?: { skills?: string[] };
    };
    assert.deepEqual(pkg.pi?.skills, ["./skills"], "package declares skills directory");
    const realAddendum = readFileSync(join(__internals.packageRoot(), "prompts", "purge-addendum.md"), "utf8");
    assert.ok(realAddendum.includes("`reverse-engineering` skill"), "addendum reminds model to load the skill");

    // addendum 热编辑：下一回合应使用新内容，而不是被旧 marker 挡住
    writeFileSync(addendumPath, `${ADDENDUM_V2}\n`);
    const hot = await apply(opts);
    assert.ok(hot?.includes("TEST ADDENDUM V2"), "addendum hot-reloaded");
    assert.ok(!hot?.includes("TEST ADDENDUM V1"), "old addendum removed");
    assert.equal((hot ?? "").split("<operator_mode>").length - 1, 1, "still exactly one addendum");

    // dropProjectContext：启用时可连 AGENTS.md 一起压掉，禁用后原生恢复
    __setPurgeConfigForTests({ dropProjectContext: true });
    const dropped = await apply(opts);
    assert.ok(dropped, "forced prompt still returned");
    assert.ok(!dropped!.includes("project rules"), "project context dropped while enabled");
    assert.ok(dropped!.includes("<tools>"), "tools still preserved when dropping project context");
    __setPurgeConfigForTests({ dropProjectContext: false });
    const kept = await apply(opts);
    assert.ok(kept!.includes("project rules"), "project context back when option off");

    // 禁用：必须逐项还原到启用前的基线
    await toggle.execute!("t3", { enabled: false }, undefined, undefined, mockCtx(false, opts));
    assert.equal(opts.customPrompt, "USER SYSTEM PROMPT", "user customPrompt untouched on disable");
    assert.equal(opts.appendSystemPrompt, "USER APPEND", "user appendSystemPrompt untouched on disable");
    assert.equal(opts.forceSystemPrompt, undefined, "forced prompt removed immediately");

    // 再触发一次 before_agent_start，仍然保持原生基线
    const disabledResult = await apply(opts);
    assert.equal(disabledResult, undefined, "disabled handler returns no forced prompt");
    assert.equal(opts.forceSystemPrompt, undefined, "forced prompt stays removed");

    // 禁用状态写入用户目录，而不是包根目录
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { enabled: boolean };
    assert.equal(persisted.enabled, false, "disabled state persisted outside package");

    // 重新启用：再次覆盖，仍然只有一个 addendum
    await toggle.execute!("t4", { enabled: true }, undefined, undefined, undefined);
    const reEnabled = await apply(opts);
    assert.ok(reEnabled?.startsWith(TEST_PREAMBLE), "re-enabled override applied");
    assert.ok(reEnabled?.includes("TEST ADDENDUM V2"), "latest addendum applied after re-enable");
    assert.equal((reEnabled ?? "").split("<operator_mode>").length - 1, 1, "no duplicate after re-enable");

    // 模拟桌面端「设置 → 扩展」禁用：旧 runner 先收到 session_shutdown，再移除扩展。
    // 这是扩展最后一次还原机会。
    assert.equal(typeof opts.forceSystemPrompt, "string", "force set before shutdown");
    await pi.handlers.get("session_shutdown")!(
      { type: "session_shutdown", reason: "reload" },
      mockCtx(false, opts),
    );
    assert.equal(opts.forceSystemPrompt, undefined, "session_shutdown removes forced prompt");

    // status 文案与禁用状态
    const res = (await status.execute!("t5", {}, undefined, undefined, undefined)) as {
      content: { text: string }[];
    };
    assert.ok(res.content[0]!.text.includes("ACTIVE"), "status reports active mode");
    assert.ok(res.content[0]!.text.includes(statePath), "status reports state path");

    await toggle.execute!("t6", { enabled: false }, undefined, undefined, undefined);
    const bypass = (await status.execute!("t7", {}, undefined, undefined, undefined)) as {
      content: { text: string }[];
    };
    assert.ok(bypass.content[0]!.text.includes("BYPASSED"), "status reports bypassed mode");

    // 外部改状态文件禁用：下一回合按 mtime 重读并还原
    await toggle.execute!("t8", { enabled: true }, undefined, undefined, undefined);
    const beforeExternal = await apply(opts);
    assert.ok(beforeExternal, "enabled again before external disable");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const externalConfig = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    externalConfig.enabled = false;
    writeFileSync(statePath, JSON.stringify(externalConfig, null, 2));
    const afterExternal = await apply(opts);
    assert.equal(afterExternal, undefined, "external config disable stops forcing next turn");
    assert.equal(opts.forceSystemPrompt, undefined, "external config disable restores baseline");

    // 配置解析失败时 fail-closed，而不是静默全开
    const badPath = join(testDir, "bad-config.json");
    writeFileSync(badPath, "{ this is not json", "utf8");
    process.env.PI_PURGE_CONFIG_PATH = badPath;
    __internals.loadConfig(true);
    const failed = __getPurgeConfigForTests();
    assert.equal(failed.enabled, false, "malformed config fails closed");
    assert.equal(failed.autoTrustProjects, false, "malformed config disables auto trust");

    // 兜底文案存在
    assert.ok(__internals.FALLBACK_PREAMBLE.length > 0);
    assert.ok(__internals.FALLBACK_ADDENDUM.includes("<operator_mode>"));
  } finally {
    delete process.env.PI_PURGE_CONFIG_PATH;
    delete process.env.PI_PURGE_PROMPTS_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    __resetPurgeForTests();
    rmSync(testDir, { recursive: true, force: true });
  }

  console.log("pi-purge: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
