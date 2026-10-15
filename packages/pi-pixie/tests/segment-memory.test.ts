/**
 * 新段首轮注入交接卡片（src/segment-memory.ts）的 vitest 用例。
 *
 * 覆盖：注入内容与自定义条目类型、非小精灵会话不注入、已有历史或已注入过不重复、
 * 取不到会话目录时静默跳过、判定抛错时绝不让 agent 启动失败、默认角色判定走
 * 真实 cwd（工作区匹配）而不是 env。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPixieSegmentMemoryExtension } from "../src/segment-memory.js";
import { PIXIE_SEGMENT_CUSTOM_TYPE } from "../src/segments.js";
import { PIXIE_WORKSPACE_ENV } from "../src/activation.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function createMockPi(): { pi: never; emit: (ctx: unknown) => Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined> } {
  const handlers: Handler[] = [];
  const pi = {
    on(_event: string, handler: Handler): void {
      handlers.push(handler);
    },
  };
  return {
    pi: pi as never,
    async emit(ctx: unknown) {
      let result: { message?: { customType: string; content: string; display: boolean } } | undefined;
      for (const handler of handlers) {
        result = (await handler({ type: "before_agent_start" }, ctx)) as typeof result;
      }
      return result;
    },
  };
}

const createdDirs: string[] = [];

function makeSessionDirWithPrevious(): { dir: string; current: string } {
  const dir = mkdtempSync(join(tmpdir(), "pixie-memory-"));
  createdDirs.push(dir);
  const previous = join(dir, "2026-10-14T09-00-00-000Z_prev.jsonl");
  writeFileSync(
    previous,
    [
      JSON.stringify({ type: "session", version: 3, id: "prev", timestamp: "2026-10-14T09:00:00.000Z", cwd: dir }),
      JSON.stringify({ type: "session_info", id: "prev-n", parentId: null, timestamp: "2026-10-14T09:00:00.000Z", name: "门店对账" }),
      JSON.stringify({
        type: "message",
        id: "prev-m0",
        parentId: null,
        timestamp: "2026-10-14T09:01:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "B 店差 12 元，已改好" }], stopReason: "stop" },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  const current = join(dir, "2026-10-15T09-00-00-000Z_cur.jsonl");
  writeFileSync(
    current,
    `${JSON.stringify({ type: "session", version: 3, id: "cur", timestamp: "2026-10-15T09:00:00.000Z", cwd: dir })}\n`,
    "utf8",
  );
  return { dir, current };
}

const pixieCtx = (dir: string, current: string, entries: unknown[] = []): unknown => ({
  cwd: dir,
  sessionManager: {
    getSessionDir: () => dir,
    getSessionFile: () => current,
    getEntries: () => entries,
  },
});

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedWorkspace = process.env[PIXIE_WORKSPACE_ENV];

afterEach(() => {
  if (savedWorkspace === undefined) delete process.env[PIXIE_WORKSPACE_ENV];
  else process.env[PIXIE_WORKSPACE_ENV] = savedWorkspace;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  delete process.env.PIABYSS_PIXIE_RESIDENT;
});

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

describe("pixie segment memory injection", () => {
  it("注入段索引与上一段收尾，并标记为本插件的自定义条目", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true })(mock.pi);

    const result = await mock.emit(pixieCtx(dir, current));
    expect(result?.message?.customType).toBe(PIXIE_SEGMENT_CUSTOM_TYPE);
    expect(result?.message?.display).toBe(true);
    expect(result?.message?.content).toContain("0. 门店对账");
    expect(result?.message?.content).toContain("B 店差 12 元，已改好");
    expect(result?.message?.content).toContain("pixie_recall");
  });

  it("非小精灵会话完全不注入", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => false })(mock.pi);
    expect(await mock.emit(pixieCtx(dir, current))).toBeUndefined();
  });

  it("已经有用户消息时不再注入", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true })(mock.pi);
    const ctx = pixieCtx(dir, current, [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-10-15T09:01:00.000Z", message: { role: "user", content: "你好" } },
    ]);
    expect(await mock.emit(ctx)).toBeUndefined();
  });

  it("本插件的卡片已注入过时不重复灌", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true })(mock.pi);
    const ctx = pixieCtx(dir, current, [
      { type: "custom_message", id: "c1", parentId: null, timestamp: "2026-10-15T09:01:00.000Z", customType: PIXIE_SEGMENT_CUSTOM_TYPE, content: "旧卡片", display: true },
    ]);
    expect(await mock.emit(ctx)).toBeUndefined();
  });

  it("没有历史段 / 取不到会话目录时静默跳过", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    rmSync(join(dir, "2026-10-14T09-00-00-000Z_prev.jsonl"));
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true })(mock.pi);
    expect(await mock.emit(pixieCtx(dir, current))).toBeUndefined();

    const noDir = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true })(noDir.pi);
    expect(await noDir.emit({ cwd: dir, sessionManager: {} })).toBeUndefined();
  });

  it("判定或读盘抛错时不抛出，只当没注入", async () => {
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({
      isResident: () => true,
      needsCard: () => {
        throw new Error("boom");
      },
    })(mock.pi);
    expect(await mock.emit({ cwd: "C:/x", sessionManager: { getSessionDir: () => "C:/x" } })).toBeUndefined();
  });

  it("默认角色判定按 cwd 命中小精灵工作区（不依赖 env 标记）", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    process.env[PIXIE_WORKSPACE_ENV] = dir;
    const mock = createMockPi();
    createPixieSegmentMemoryExtension()(mock.pi);
    const result = await mock.emit(pixieCtx(dir, current));
    expect(result?.message?.customType).toBe(PIXIE_SEGMENT_CUSTOM_TYPE);
    // 同一临时目录但工作区路径不匹配时，卡片不该出现。
    delete process.env[PIXIE_WORKSPACE_ENV];
    process.env.PI_CODING_AGENT_DIR = join(dir, "elsewhere");
    const other = createMockPi();
    createPixieSegmentMemoryExtension()(other.pi);
    expect(await other.emit(pixieCtx(dir, current))).toBeUndefined();
  });
});
