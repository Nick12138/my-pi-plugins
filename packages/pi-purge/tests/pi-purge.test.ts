/**
 * pi-purge standalone test（node --experimental-strip-types 直接执行）:
 *   node --experimental-strip-types packages/pi-purge/tests/pi-purge.test.ts
 * 本文件不在 vitest include 内，遵循本仓库老插件的独立断言脚本惯例。
 */

import assert from "node:assert/strict";
import purgify, { __internals, __resetPurgeForTests } from "../extensions/pi-purge.ts";

interface Registered {
  name: string;
  execute?: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

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

function mockCtx(hasUI: boolean) {
  const notifications: string[] = [];
  return {
    hasUI,
    notifications,
    ui: {
      notify(msg: string) {
        notifications.push(msg);
      },
    },
  };
}

async function main() {
  const pi = makeMockPi();
  purgify(pi as never);

  // 注册面
  assert.ok(pi.handlers.has("session_start"), "session_start handler registered");
  assert.ok(pi.handlers.has("project_trust"), "project_trust handler registered");
  assert.ok(pi.handlers.has("before_agent_start"), "before_agent_start handler registered");
  const toolNames = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ["purge_status", "purge_toggle"], "both tools registered");
  assert.deepEqual(pi.commands, ["purge"], "/purge command registered");

  // project_trust：enabled 时自动 yes + remember
  const trustYes = (await pi.handlers.get("project_trust")!({ type: "project_trust", cwd: "C:\\x" }, mockCtx(true))) as {
    trusted: string;
    remember?: boolean;
  };
  assert.equal(trustYes.trusted, "yes");
  assert.equal(trustYes.remember, true);

  // project_trust：disabled 时 undecided
  const toggle = pi.tools.find((t) => t.name === "purge_toggle")!;
  await toggle.execute!("t1", { enabled: false }, undefined, undefined, undefined);
  const trustNo = (await pi.handlers.get("project_trust")!({ type: "project_trust" }, mockCtx(true))) as {
    trusted: string;
  };
  assert.equal(trustNo.trusted, "undecided");

  // 恢复 enabled，验证 before_agent_start 改写系统提示词选项
  await toggle.execute!("t2", { enabled: true }, undefined, undefined, undefined);
  const opts = {
    customPrompt: undefined as string | undefined,
    appendSystemPrompt: "" as string,
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
  await pi.handlers.get("before_agent_start")!({
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt: "base",
    systemPromptOptions: opts,
  });
  assert.ok(opts.customPrompt && opts.customPrompt.includes("operator mode"), "customPrompt replaced");
  assert.ok(opts.appendSystemPrompt.includes("<operator_mode>"), "addendum carries operator_mode marker");
  const markerCount = () => opts.appendSystemPrompt.split("<operator_mode>").length - 1;
  assert.equal(markerCount(), 1, "addendum appended once");

  // 幂等：再次触发不会重复追加
  await pi.handlers.get("before_agent_start")!({
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt: "base",
    systemPromptOptions: opts,
  });
  assert.equal(markerCount(), 1, "addendum not duplicated");

  // purge_status 只读输出
  const status = pi.tools.find((t) => t.name === "purge_status")!;
  const res = (await status.execute!("t3", {}, undefined, undefined, undefined)) as {
    content: { text: string }[];
  };
  assert.ok(res.content[0]!.text.includes("ACTIVE"), "status reports active mode");

  // config.json 被写回且 enabled=true
  const { readFileSync } = await import("node:fs");
  const persisted = JSON.parse(readFileSync(__internals.packageRoot() + "\\config.json", "utf8")) as {
    enabled: boolean;
  };
  assert.equal(persisted.enabled, true, "config persisted");

  // 兜底文案存在
  assert.ok(__internals.FALLBACK_PREAMBLE.length > 0);
  assert.ok(__internals.FALLBACK_ADDENDUM.includes("<operator_mode>"));

  __resetPurgeForTests();
  console.log("pi-purge: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
