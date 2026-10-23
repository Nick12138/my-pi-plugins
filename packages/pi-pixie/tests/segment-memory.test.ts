/**
 * 新段首轮注入交接卡片（src/segment-memory.ts）的 vitest 用例。
 *
 * 覆盖：注入内容与自定义条目类型（运行契约 + 段索引 + 上一段收尾）、
 * 无历史段仍注入契约、已知工作区来源（context.json 优先 / sessions 扫描兜底
 * top-5 / 全失败时省略该行）、段索引行仍匹配前端正则、非小精灵会话不注入、
 * 已有历史或已注入过不重复、取不到会话目录时静默跳过、判定抛错时绝不让 agent
 * 启动失败、默认角色判定走真实 cwd（工作区匹配）而不是 env。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPixieSegmentMemoryExtension } from "../src/segment-memory.js";
import { PIXIE_SEGMENT_CUSTOM_TYPE } from "../src/segments.js";
import { PIXIE_WORKSPACE_ENV } from "../src/activation.js";
import { buildPixieContextPreamble, decodeSessionDirName, knownWorkspaces } from "../src/pixie-context.js";

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
    async emit(ctx: unknown, prompt?: string) {
      let result: { message?: { customType: string; content: string; display: boolean } } | undefined;
      for (const handler of handlers) {
        result = (await handler({ type: "before_agent_start", prompt }, ctx)) as typeof result;
      }
      return result;
    },
  };
}

const createdDirs: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** 空的 agentDir（没有 piabyss/context.json，也没有 sessions 目录）。 */
const makeAgentDir = (): string => makeTmp("pixie-agentdir-");

function makeSessionDirWithPrevious(): { dir: string; current: string } {
  const dir = makeTmp("pixie-memory-");
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
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(mock.pi);

    const result = await mock.emit(pixieCtx(dir, current));
    expect(result?.message?.customType).toBe(PIXIE_SEGMENT_CUSTOM_TYPE);
    expect(result?.message?.display).toBe(true);
    expect(result?.message?.content).toContain("0. 门店对账");
    expect(result?.message?.content).toContain("B 店差 12 元，已改好");
    expect(result?.message?.content).toContain("pixie_recall");
    // 契约也在同一张卡片里（单个 custom_message，不额外发条目）。
    expect(result?.message?.content).toContain("<pixie-context>");
    expect(result?.message?.content).toContain("</pixie-context>");
  });

  it("无历史段仍注入：契约照发，段索引渲染成「没有找到历史会话段」", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    rmSync(join(dir, "2026-10-14T09-00-00-000Z_prev.jsonl"));
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(mock.pi);

    const result = await mock.emit(pixieCtx(dir, current));
    expect(result?.message?.customType).toBe(PIXIE_SEGMENT_CUSTOM_TYPE);
    const content = result?.message?.content ?? "";
    expect(content).toContain("<pixie-context>");
    expect(content).toContain("本段开始时间：");
    expect(content).toContain("委派 cwd：必须来自下方已知工作区列表");
    expect(content).toContain("```automation-plan");
    expect(content).toContain("（没有找到历史会话段）");
  });

  it("旧 Host 已包上契约时，卡片只补回顾、不重复契约", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(mock.pi);

    const hosted = `<pixie-context>
本段开始时间：2026-10-21（周三）09:00，UTC+8。
</pixie-context>
嗨`;
    const result = await mock.emit(pixieCtx(dir, current), hosted);
    expect(result?.message?.customType).toBe(PIXIE_SEGMENT_CUSTOM_TYPE);
    const content = result?.message?.content ?? "";
    // 不重复：整张卡片只允许出现一次开标签——这里是零次。
    expect(content).not.toContain("<pixie-context>");
    expect(content).not.toContain("本段开始时间");
    // 但回顾部分不能丢。
    expect(content).toContain("0. 门店对账");
    expect(content).toContain("B 店差 12 元，已改好");
  });

  it("prompt 里没有契约（裸 CLI / 新 Host）时照常内嵌", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(mock.pi);

    const result = await mock.emit(pixieCtx(dir, current), "嗨");
    expect(result?.message?.content).toContain("<pixie-context>");
  });

  it("段索引行仍匹配前端正则（intro 之后的固定格式）", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(mock.pi);
    const content = (await mock.emit(pixieCtx(dir, current)))?.message?.content ?? "";

    const INDEX = /^\s*(\d+)\.\s+(.+?)\s+·\s+(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s+·\s+(\d+)\s*条\s*$/;
    const body = content.slice("<pixie-segments>".length, -"</pixie-segments>".length);
    const lines = body.split("\n");
    const indexLines = lines.filter((line) => INDEX.test(line));
    expect(indexLines).toHaveLength(1);
    expect(INDEX.exec(indexLines[0])?.[2]).toBe("门店对账");
    expect(lines.some((line) => /的收尾[：:]\s*$/.test(line))).toBe(true);
  });

  it("已知工作区优先取 context.json", async () => {
    const agentDir = makeAgentDir();
    mkdirSync(join(agentDir, "piabyss", "pixie"), { recursive: true });
    writeFileSync(
      join(agentDir, "piabyss", "pixie", "context.json"),
      JSON.stringify({ version: 1, workspaces: ["D:\\我的项目\\PiAbyss", "D:\\我的项目\\my-pi-plugins"], updatedAt: 1 }),
      "utf8",
    );
    const preamble = buildPixieContextPreamble(agentDir);
    expect(preamble).toContain("已知的 PiAbyss 工作区：");
    expect(preamble).toContain("- D:\\我的项目\\PiAbyss");
    expect(preamble).toContain("- D:\\我的项目\\my-pi-plugins");
    expect(knownWorkspaces(agentDir)).toEqual(["D:\\我的项目\\PiAbyss", "D:\\我的项目\\my-pi-plugins"]);
  });

  it("没有 context.json 时扫 sessions 目录兜底，按最新会话倒序取前 5 个", () => {
    const agentDir = makeAgentDir();
    const sessions = join(agentDir, "sessions");
    const seed = (name: string, stamp: string): void => {
      mkdirSync(join(sessions, name), { recursive: true });
      // 目录里最新会话的时间从文件名读（与 Pi 的落盘命名一致）。
      writeFileSync(join(sessions, name, `${stamp}_id.jsonl`), `${JSON.stringify({ type: "session" })}\n`, "utf8");
    };
    seed("--C--Users-example--", "2026-10-01T09-00-00-000Z");
    seed("--D--我的项目--", "2026-10-02T09-00-00-000Z");
    seed("--D--我的项目-PiAbyss--", "2026-10-03T09-00-00-000Z");
    seed("--D--我的项目-PiAbyss-packages--", "2026-10-04T09-00-00-000Z");
    seed("--D--我的项目-SnipTranslate--", "2026-10-05T09-00-00-000Z");
    seed("--D--我的项目-kuai3--", "2026-10-06T09-00-00-000Z");
    // 最新但是脏形态（嵌套编码）：必须被丢弃，不能挤掉正常工作区。
    seed("--C--Users-liu-.pi-agent-sessions---C--Users-liu-.pi-agent-pideck-DefaultProject----", "2026-10-31T09-00-00-000Z");
    // 没有任何会话文件的空壳目录：反推不出「最近用过」，同样丢弃。
    mkdirSync(join(sessions, "--D--我的项目-agents-anywhere-pi--"), { recursive: true });

    const workspaces = knownWorkspaces(agentDir);
    expect(workspaces).toHaveLength(5);
    expect(workspaces).toEqual([
      "D:\\我的项目\\kuai3",
      "D:\\我的项目\\SnipTranslate",
      "D:\\我的项目\\PiAbyss\\packages",
      "D:\\我的项目\\PiAbyss",
      "D:\\我的项目",
    ]);
    expect(buildPixieContextPreamble(agentDir)).toContain("- D:\\我的项目\\kuai3");
  });

  it("兜底扫目录时优先信会话 header 里的 cwd（目录名编码有损，连字符还原不回来）", () => {
    const agentDir = makeAgentDir();
    const sessDir = join(agentDir, "sessions", "--D--我的项目-my-pi-plugins--");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, "2026-10-05T09-00-00-000Z_id.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-10-05T09:00:00.000Z", cwd: "D:\\我的项目\\my-pi-plugins" })}\n`,
      "utf8",
    );
    expect(knownWorkspaces(agentDir)).toEqual(["D:\\我的项目\\my-pi-plugins"]);

    // header 里的 cwd 不是绝对路径（旧文件/被改过）时退回目录名反解。
    writeFileSync(
      join(sessDir, "2026-10-05T09-00-00-000Z_id.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-10-05T09:00:00.000Z", cwd: "relative/dir" })}\n`,
      "utf8",
    );
    expect(knownWorkspaces(agentDir)).toEqual(["D:\\我的项目\\my\\pi\\plugins"]);
  });

  it("context.json 坏掉 / 数组为空时退回 sessions 扫描，全失败则省略工作区行", () => {
    const agentDir = makeAgentDir();
    mkdirSync(join(agentDir, "piabyss", "pixie"), { recursive: true });
    const contextPath = join(agentDir, "piabyss", "pixie", "context.json");
    mkdirSync(join(agentDir, "sessions", "--D--我的项目-PiAbyss--"), { recursive: true });
    writeFileSync(join(agentDir, "sessions", "--D--我的项目-PiAbyss--", "2026-10-03T09-00-00-000Z_id.jsonl"), "{}\n", "utf8");

    writeFileSync(contextPath, "not json", "utf8");
    expect(knownWorkspaces(agentDir)).toEqual(["D:\\我的项目\\PiAbyss"]);

    writeFileSync(contextPath, JSON.stringify({ version: 1, workspaces: [] }), "utf8");
    expect(knownWorkspaces(agentDir)).toEqual(["D:\\我的项目\\PiAbyss"]);

    // 空 agentDir：既无 context.json 也无 sessions → 契约里干脆不写这一行。
    const empty = makeAgentDir();
    const preamble = buildPixieContextPreamble(empty);
    expect(preamble).toContain("</pixie-context>");
    expect(preamble).not.toContain("已知的 PiAbyss 工作区");
  });

  it("会话目录名反解：正常形态还原、脏形态丢弃", () => {
    expect(decodeSessionDirName("--C--Users-example--")).toBe("C:\\Users\\example");
    expect(decodeSessionDirName("--D--我的项目-PiAbyss--")).toBe("D:\\我的项目\\PiAbyss");
    expect(decodeSessionDirName("--C--Users-liu-.pi-agent-sessions---C--Users-liu-.pi-agent-pideck-DefaultProject----")).toBeNull();
    expect(decodeSessionDirName("--D--我的项目-OKXBot--")).toBe("D:\\我的项目\\OKXBot");
    // 已知局限：真实路径里的连字符与分隔符编码后无法区分，只能按分隔符还原。
    expect(decodeSessionDirName("--D--我的项目-my-pi-plugins--")).toBe("D:\\我的项目\\my\\pi\\plugins");
    expect(decodeSessionDirName("random")).toBeNull();
  });

  it("非小精灵会话完全不注入", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => false, agentDir: makeAgentDir() })(mock.pi);
    expect(await mock.emit(pixieCtx(dir, current))).toBeUndefined();
  });

  it("已经有用户消息时不再注入", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(mock.pi);
    const ctx = pixieCtx(dir, current, [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-10-15T09:01:00.000Z", message: { role: "user", content: "你好" } },
    ]);
    expect(await mock.emit(ctx)).toBeUndefined();
  });

  it("本插件的卡片已注入过时不重复灌", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(mock.pi);
    const ctx = pixieCtx(dir, current, [
      { type: "custom_message", id: "c1", parentId: null, timestamp: "2026-10-15T09:01:00.000Z", customType: PIXIE_SEGMENT_CUSTOM_TYPE, content: "旧卡片", display: true },
    ]);
    expect(await mock.emit(ctx)).toBeUndefined();
  });

  it("取不到会话目录时静默跳过", async () => {
    const { dir } = makeSessionDirWithPrevious();
    const noDir = createMockPi();
    createPixieSegmentMemoryExtension({ isResident: () => true, agentDir: makeAgentDir() })(noDir.pi);
    expect(await noDir.emit({ cwd: dir, sessionManager: {} })).toBeUndefined();
  });

  it("判定或读盘抛错时不抛出，只当没注入", async () => {
    const mock = createMockPi();
    createPixieSegmentMemoryExtension({
      isResident: () => true,
      agentDir: makeAgentDir(),
      needsCard: () => {
        throw new Error("boom");
      },
    })(mock.pi);
    expect(await mock.emit({ cwd: "C:/x", sessionManager: { getSessionDir: () => "C:/x" } })).toBeUndefined();
  });

  it("默认角色判定按 cwd 命中小精灵工作区（不依赖 env 标记）", async () => {
    const { dir, current } = makeSessionDirWithPrevious();
    process.env[PIXIE_WORKSPACE_ENV] = dir;
    // 默认 agentDir 也指到临时目录，避免读到本机真实的 context.json/sessions。
    process.env.PI_CODING_AGENT_DIR = makeAgentDir();
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
