/**
 * 会话段读取与文本装配（src/segments.ts）+ pixie_recall 工具壳的 vitest 用例。
 *
 * 全部用临时目录里的合成 Pi 会话 jsonl（header + message + session_info 条目），
 * 不依赖 Host、不依赖网络。
 *
 * 覆盖：历史段排序与排除、坏文件/空段跳过、交接卡片内容与幂等过滤、
 * parentSession 与 recall 默认落点对齐、pixie_recall 三种模式与定位方式、
 * 错误与截断上限、工具壳的 ctx 降级。
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPixieRecallTool } from "../src/pixie-tools.js";
import {
	buildHandoffCard,
	listSegments,
	recallSegmentsText,
} from "../src/segments.js";

type RawMessage = { role: "user" | "assistant" | "toolResult"; text: string; at?: string };

type WriteInput = {
	id: string;
	created?: string;
	displayName?: string;
	cwd?: string;
	parentSession?: string;
	messages?: RawMessage[];
	/** 原样追加的 JSONL 行（用来塞 custom_message 等非常规条目）。 */
	raw?: string[];
	modifiedSec?: number;
};

const createdDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pixie-segments-"));
  createdDirs.push(dir);
  return dir;
}

function fileName(input: WriteInput): string {
  const stamp = (input.created ?? "2026-10-15T13:40:00.000Z").replace(/[:.]/g, "-");
  return `${stamp}_${input.id}.jsonl`;
}

function writeSession(dir: string, input: WriteInput): string {
  const created = input.created ?? "2026-10-15T13:40:00.000Z";
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: input.id,
      timestamp: created,
      cwd: input.cwd ?? dir,
      ...(input.parentSession ? { parentSession: input.parentSession } : {}),
    }),
  ];
  input.messages?.forEach((message, index) => {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `${input.id}-m${index}`,
        parentId: null,
        timestamp: message.at ?? created,
        message:
          message.role === "assistant"
            ? { role: "assistant", content: [{ type: "text", text: message.text }], timestamp: message.at ?? created }
            : message.role === "toolResult"
              ? { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: message.text }], isError: false, timestamp: message.at ?? created }
              : { role: "user", content: [{ type: "text", text: message.text }], timestamp: message.at ?? created },
      }),
    );
  });
  if (input.displayName !== undefined) {
    lines.push(
      JSON.stringify({ type: "session_info", id: `${input.id}-n`, parentId: null, timestamp: created, name: input.displayName }),
    );
  }
  lines.push(...(input.raw ?? []));
  const file = join(dir, fileName(input));
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  if (input.modifiedSec !== undefined) utimesSync(file, input.modifiedSec, input.modifiedSec);
  return file;
}

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

describe("listSegments", () => {
  it("按创建时间排序、排除当前会话文件、跳过空段与坏文件", () => {
    const dir = makeDir();
    writeSession(dir, { id: "old", created: "2026-10-14T09:00:00.000Z", modifiedSec: 1000, messages: [{ role: "user", text: "早上的事" }] });
    writeSession(dir, { id: "new", created: "2026-10-15T09:00:00.000Z", modifiedSec: 2000, messages: [{ role: "user", text: "中午的事" }] });
    const current = writeSession(dir, { id: "cur", created: "2026-10-15T12:00:00.000Z", modifiedSec: 3000, messages: [{ role: "user", text: "本段" }] });
    writeSession(dir, { id: "empty", created: "2026-10-15T14:00:00.000Z", modifiedSec: 4000 });
    writeFileSync(join(dir, "broken.jsonl"), "not json\n{oops\n", "utf8");
    writeFileSync(join(dir, "notes.txt"), "ignore me", "utf8");

    const listed = listSegments({ sessionDir: dir, currentFile: current });
    expect(listed.map((segment) => segment.id)).toEqual(["new", "old"]);
    expect(listed[0].preview).toBe("中午的事");
    expect(listed[0].messageCount).toBe(1);
    // 不传 currentFile 时本段也算历史。
    expect(listSegments({ sessionDir: dir }).map((segment) => segment.id)).toEqual(["cur", "new", "old"]);
  });

  it("修改时间不影响段序：创建更早但刚被写过的段仍排在创建更新的段之后", () => {
    const dir = makeDir();
    writeSession(dir, { id: "stale", created: "2026-10-12T09:00:00.000Z", modifiedSec: 9_999_999_999, messages: [{ role: "user", text: "旧段但刚被动过盘" }] });
    writeSession(dir, { id: "fresh", created: "2026-10-15T09:00:00.000Z", modifiedSec: 1_000, messages: [{ role: "user", text: "新创建没人碰" }] });
    const listed = listSegments({ sessionDir: dir });
    expect(listed.map((segment) => segment.id)).toEqual(["fresh", "stale"]);
  });

  it("文件名缺时间戳时退回 mtime，不会把老而相关的段挤掉", () => {
    const dir = makeDir();
    // 无文件名时间戳：按 mtime 兜底参与预切片排序。
    const legacy = join(dir, "legacy.jsonl");
    writeFileSync(
      legacy,
      [
        JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2026-10-13T09:00:00.000Z", cwd: dir }),
        JSON.stringify({ type: "message", id: "legacy-m0", parentId: null, timestamp: "2026-10-13T09:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "老规矩" }] } }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeSession(dir, { id: "recent", created: "2026-10-14T09:00:00.000Z", messages: [{ role: "user", text: "较新" }] });
    const listed = listSegments({ sessionDir: dir });
    expect(listed.map((segment) => segment.id)).toEqual(["recent", "legacy"]);
  });

  it("目录不存在或不可读时返回空数组", () => {
    const dir = makeDir();
    expect(listSegments({ sessionDir: join(dir, "nope") })).toEqual([]);
  });

  it("工具结果不进正文，assistant 的工具调用折叠成标记", () => {
    const dir = makeDir();
    const file = writeSession(dir, {
      id: "a",
      messages: [
        { role: "user", text: "看一下 README" },
        { role: "toolResult", text: "一大段文件正文" },
      ],
    });
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}${JSON.stringify({
        type: "message",
        id: "a-m2",
        parentId: null,
        timestamp: "2026-10-15T09:01:00.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse" },
      })}\n`,
      "utf8",
    );
    const [segment] = listSegments({ sessionDir: dir });
    expect(segment.messageCount).toBe(2);
    expect(segment.messages[1].text).toContain("〔调用 read〕");
  });

  it("连续的工具调用折叠成一行，不挤满交接卡片", () => {
    const dir = makeDir();
    const toolOnly = (tag: string, names: string[]) =>
      JSON.stringify({
        type: "message",
        id: `t-${tag}`,
        parentId: null,
        timestamp: "2026-10-14T09:05:00.000Z",
        message: {
          role: "assistant",
          content: names.map((name, index) => ({ type: "toolCall", id: `${tag}-${index}`, name, arguments: {} })),
          stopReason: "toolUse",
        },
      });
    writeSession(dir, {
      id: "a",
      created: "2026-10-14T09:00:00.000Z",
      messages: [{ role: "user", text: "先看看代码" }],
      raw: [
        toolOnly("x", ["read", "read"]),
        toolOnly("y", ["bash"]),
        toolOnly("z", ["grep"]),
        JSON.stringify({
          type: "message",
          id: "a-last",
          parentId: null,
          timestamp: "2026-10-14T09:06:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "结论：改两处就够" }], stopReason: "stop" },
        }),
      ],
    });
    const [segment] = listSegments({ sessionDir: dir });
    expect(segment.messages.map((message) => message.text)).toEqual([
      "先看看代码",
      "〔调用 read×2、bash、grep〕（共 4 次）",
      "结论：改两处就够",
    ]);
  });
});

describe("buildHandoffCard", () => {
  // 前端（PiAbyss）剥掉 <pixie-segments> 后按行解析：索引行与收尾标题的格式
  // 一个字符都不能改。这里把前端的两条正则抄一份当契约用。
  const SEGMENT_INDEX_LINE = /^\s*(\d+)\.\s+(.+?)\s+·\s+(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s+·\s+(\d+)\s*条\s*$/;
  const TAIL_TITLE = /的收尾[：:]\s*$/;

  it("没有历史段也出卡片：契约在、段索引渲染成「没有找到历史会话段」", () => {
    const dir = makeDir();
    const current = writeSession(dir, { id: "cur", messages: [{ role: "user", text: "第一条" }] });
    const card = buildHandoffCard({
      sessionDir: dir,
      currentFile: current,
      agentDir: makeDir(),
      now: new Date("2026-10-22T13:14:00Z"),
    });
    expect(card.startsWith("<pixie-segments>")).toBe(true);
    expect(card.endsWith("</pixie-segments>")).toBe(true);
    expect(card).toContain("<pixie-context>");
    expect(card).toContain("</pixie-context>");
    expect(card).toContain("（没有找到历史会话段）");
    expect(card).toContain("最近 0 段");
    // 没有上一段就没有收尾区。
    expect(card).not.toMatch(TAIL_TITLE);
  });

  it("契约块内嵌在开场两句之前，含时间锚点、落点、回调三分法与 automation 规范", () => {
    const dir = makeDir();
    writeSession(dir, {
      id: "prev",
      created: "2026-10-14T09:00:00.000Z",
      modifiedSec: 2000,
      displayName: "门店对账",
      messages: [{ role: "assistant", text: "差 12 元，已定位到 B 店" }],
    });
    const current = writeSession(dir, { id: "cur", created: "2026-10-15T09:00:00.000Z", modifiedSec: 3000 });
    const card = buildHandoffCard({
      sessionDir: dir,
      currentFile: current,
      agentDir: makeDir(),
      now: new Date("2026-10-22T13:14:00Z"),
    });

    // 顺序：整卡标签 → 契约块 → 开场两句 → 段索引 → 收尾。
    const contract = card.indexOf("<pixie-context>");
    const intro = card.indexOf("你在小精灵工作区开启了一个新的会话段");
    const recallHint = card.indexOf("要回看细节就调用 pixie_recall");
    const indexTitle = card.indexOf("最近 1 段");
    const tail = card.indexOf("的收尾：");
    expect(contract).toBeGreaterThan(0);
    expect(contract).toBeLessThan(intro);
    expect(intro).toBeLessThan(recallHint);
    expect(recallHint).toBeLessThan(indexTitle);
    expect(indexTitle).toBeLessThan(tail);

    // 时间锚点（格式与 Host 一致）+ 「以现跑 date 为准」这句必须在。
    expect(card).toMatch(/本段开始时间：\d{4}-\d{2}-\d{2}（周.）\d{2}:\d{2}，UTC[+−]\d+。/);
    expect(card).toContain("判断今天/周几/是否逾期，一律以现跑 date 为准，不要凭记忆推");
    // 委派契约的几个必备条款。
    expect(card).toContain("只复用【你自己创建的】会话");
    expect(card).toContain("排队");
    expect(card).toContain("完成：只转述、不代写总结");
    expect(card).toContain("连败 3 次");
    expect(card).toContain("询问：立刻转述给用户、不要代答");
    expect(card).toContain("默认不传 model / thinkingLevel");
    expect(card).toContain("委派 cwd：必须来自下方已知工作区列表");
    // automation 契约（pi-automation 没有自己的注入通道，必须搬进这里）。
    expect(card).toContain("只读不写");
    expect(card).toContain("```automation-plan");
    expect(card).toContain("missedWindow");
    expect(card).toContain("maxRuns");
    expect(card).toContain("jobId");
  });

  it("段索引行仍匹配前端正则，收尾标题仍以「的收尾：」结尾", () => {
    const dir = makeDir();
    writeSession(dir, {
      id: "older",
      created: "2026-10-13T09:00:00.000Z",
      modifiedSec: 1000,
      displayName: "报销整理",
      messages: [{ role: "user", text: "把上月的报销单整理一下" }],
    });
    writeSession(dir, {
      id: "prev",
      created: "2026-10-14T09:00:00.000Z",
      modifiedSec: 2000,
      displayName: "门店对账",
      messages: [{ role: "assistant", text: "差 12 元，已定位到 B 店" }],
    });
    const current = writeSession(dir, { id: "cur", created: "2026-10-15T09:00:00.000Z", modifiedSec: 3000 });
    const card = buildHandoffCard({ sessionDir: dir, currentFile: current, agentDir: makeDir() });
    expect(card).not.toBeNull();

    const body = card.slice("<pixie-segments>".length, -"</pixie-segments>".length);
    const indexLines = body.split("\n").filter((line) => SEGMENT_INDEX_LINE.test(line));
    expect(indexLines.map((line) => SEGMENT_INDEX_LINE.exec(line)?.[2])).toEqual(["门店对账", "报销整理"]);
    expect(body.split("\n").some((line) => TAIL_TITLE.test(line))).toBe(true);
    // 段索引与收尾的既有格式没变：序号. 段名 · MM-DD HH:MM · N 条。
    expect(card).toContain("0. 门店对账 · 10-14 09:00 · 1 条");
  });

  it("卡片含段索引与上一段收尾，并过滤本插件自己注入的条目", () => {
    const dir = makeDir();
    writeSession(dir, {
      id: "older",
      created: "2026-10-13T09:00:00.000Z",
      modifiedSec: 1000,
      displayName: "报销整理",
      messages: [{ role: "user", text: "把上月的报销单整理一下" }],
    });
    writeSession(dir, {
      id: "prev",
      created: "2026-10-14T09:00:00.000Z",
      modifiedSec: 2000,
      displayName: "门店对账",
      messages: [
        { role: "user", text: "对一下三店的数据" },
        { role: "assistant", text: "差 12 元，已定位到 B 店" },
      ],
      raw: [
        JSON.stringify({
          type: "custom_message",
          id: "prev-card",
          parentId: null,
          timestamp: "2026-10-14T09:30:00.000Z",
          customType: "pixie-segments",
          content: "<pixie-segments>卡片里的旧文字不该被复述</pixie-segments>",
          display: true,
        }),
      ],
    });
    const current = writeSession(dir, { id: "cur", created: "2026-10-15T09:00:00.000Z", modifiedSec: 3000 });

    const card = buildHandoffCard({ sessionDir: dir, currentFile: current, agentDir: makeDir() });
    expect(card).not.toBeNull();
    expect(card).toContain("<pixie-segments>");
    expect(card).toContain("pixie_recall");
    expect(card).toContain("0. 门店对账");
    expect(card).toContain("1. 报销整理");
    expect(card).toContain("差 12 元，已定位到 B 店");
    expect(card).not.toContain("卡片里的旧文字不该被复述");
  });

  it("header.parentSession 指向目录外的段时，它才算上一段", () => {
    const dir = makeDir();
    const outside = writeSession(dir, {
      id: "outside",
      created: "2026-10-10T09:00:00.000Z",
      modifiedSec: 500,
      displayName: "别处的段",
      messages: [{ role: "assistant", text: "从别处接手" }],
    });
    const other = writeSession(dir, {
      id: "other",
      created: "2026-10-12T09:00:00.000Z",
      modifiedSec: 9000,
      displayName: "同目录更近的段",
      messages: [{ role: "user", text: "不相干的话题" }],
    });
    void other;
    const current = join(dir, fileName({ id: "cur", created: "2026-10-15T09:00:00.000Z" }));
    writeSession(dir, { id: "cur", created: "2026-10-15T09:00:00.000Z", modifiedSec: 10000, parentSession: outside });

    const card = buildHandoffCard({ sessionDir: dir, currentFile: current, agentDir: makeDir() });
    expect(card).toContain("从别处接手");
    expect(card).toContain("0. 别处的段");
    expect(card).toContain("1. 同目录更近的段");
  });
});

describe("recallSegmentsText", () => {
  const seeded = (): { dir: string; current: string } => {
    const dir = makeDir();
    writeSession(dir, {
      id: "alpha",
      created: "2026-10-13T09:00:00.000Z",
      modifiedSec: 1000,
      displayName: "报销整理",
      messages: [
        { role: "user", text: "把三张单据录进去" },
        { role: "assistant", text: "已录入：差旅 1200、餐费 300" },
      ],
    });
    writeSession(dir, {
      id: "bravo",
      created: "2026-10-14T09:00:00.000Z",
      modifiedSec: 2000,
      displayName: "门店对账",
      messages: [
        { role: "user", text: "对一下三店的数据" },
        { role: "assistant", text: "B 店差 12 元" },
        { role: "user", text: "那就按 B 店修正" },
        { role: "assistant", text: "改好了" },
      ],
    });
    const current = writeSession(dir, { id: "cur", created: "2026-10-15T09:00:00.000Z", modifiedSec: 3000 });
    return { dir, current };
  };

  it("mode=index 列出历史段", () => {
    const { dir, current } = seeded();
    const result = recallSegmentsText({ sessionDir: dir, currentFile: current, mode: "index" });
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain("0. 门店对账");
    expect(textOf(result)).toContain("1. 报销整理");
  });

  it("默认读上一段收尾，limit 控制条数", () => {
    const { dir, current } = seeded();
    const two = recallSegmentsText({ sessionDir: dir, currentFile: current, limit: 2 });
    expect(textOf(two)).toContain("那就按 B 店修正");
    expect(textOf(two)).not.toContain("对一下三店的数据");
    const all = recallSegmentsText({ sessionDir: dir, currentFile: current });
    expect(textOf(all)).toContain("对一下三店的数据");
  });

  it("segment 支持序号、段名关键词与会话 id 前缀", () => {
    const { dir, current } = seeded();
    expect(textOf(recallSegmentsText({ sessionDir: dir, currentFile: current, segment: "1" }))).toContain("已录入：差旅 1200");
    expect(textOf(recallSegmentsText({ sessionDir: dir, currentFile: current, segment: "报销" }))).toContain("已录入：差旅 1200");
    expect(textOf(recallSegmentsText({ sessionDir: dir, currentFile: current, segment: "alph" }))).toContain("已录入：差旅 1200");
    const bad = recallSegmentsText({ sessionDir: dir, currentFile: current, segment: "不存在的话题" });
    expect(bad.ok).toBe(false);
    expect(textOf(bad)).toContain("mode=index");
  });

  it("parentSession 指向更早的段时，省略 segment 读到的就是卡片标为 0 的那一段", () => {
    const dir = makeDir();
    const parent = writeSession(dir, {
      id: "p",
      created: "2026-10-11T09:00:00.000Z",
      modifiedSec: 1000,
      displayName: "被接手的段",
      messages: [{ role: "assistant", text: "接手点：等用户拍板" }],
    });
    writeSession(dir, {
      id: "unrelated",
      created: "2026-10-13T09:00:00.000Z",
      modifiedSec: 9000,
      displayName: "更近但无关的段",
      messages: [{ role: "assistant", text: "无关话题" }],
    });
    const current = writeSession(dir, { id: "cur", created: "2026-10-15T09:00:00.000Z", modifiedSec: 10000, parentSession: parent });

    const card = buildHandoffCard({ sessionDir: dir, currentFile: current, agentDir: makeDir() });
    expect(card).toContain("0. 被接手的段");
    expect(card).toContain("接手点：等用户拍板");
    const tail = recallSegmentsText({ sessionDir: dir, currentFile: current });
    expect(textOf(tail)).toContain("接手点：等用户拍板");
    expect(textOf(tail)).not.toContain("无关话题");
  });

  it("mode=search 命中处带前后文；缺 query 报错；无命中给温和文案", () => {
    const { dir, current } = seeded();
    const hit = recallSegmentsText({ sessionDir: dir, currentFile: current, mode: "search", query: "差 12 元" });
    expect(hit.ok).toBe(true);
    expect(textOf(hit)).toContain("对一下三店的数据");
    expect(textOf(hit)).toContain("那就按 B 店修正");
    expect(textOf(hit)).toContain("→ [2]");

    const missing = recallSegmentsText({ sessionDir: dir, currentFile: current, mode: "search" });
    expect(missing.ok).toBe(false);

    const none = recallSegmentsText({ sessionDir: dir, currentFile: current, mode: "search", query: "火星文" });
    expect(none.ok).toBe(true);
    expect(textOf(none)).toContain("没有找到");
  });

  it("目录里没有其它段时报错，而不是返回空文本", () => {
    const dir = makeDir();
    const current = writeSession(dir, { id: "cur", messages: [{ role: "user", text: "第一条" }] });
    const result = recallSegmentsText({ sessionDir: dir, currentFile: current });
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("没有其它会话段");
  });

  it("输出超过上限时截断并提示收窄范围", () => {
    const dir = makeDir();
    const filler = "很长的一段话".repeat(400);
    writeSession(dir, {
      id: "big",
      modifiedSec: 2000,
      messages: Array.from({ length: 12 }, (_, index) => ({ role: "assistant" as const, text: `${index} ${filler}` })),
    });
    const current = writeSession(dir, { id: "cur", modifiedSec: 3000 });
    const result = recallSegmentsText({ sessionDir: dir, currentFile: current });
    expect(textOf(result)).toContain("输出已截断");
    expect(textOf(result).length).toBeLessThanOrEqual(6200);
  });
});

function textOf(result: { ok: true; text: string } | { ok: false; error: string }): string {
  return result.ok ? result.text : result.error;
}

describe("pixie_recall 工具壳", () => {
  type ToolResult = { content: Array<{ type: string; text: string }>; isError?: true };

  const call = async (params: unknown, ctx: unknown): Promise<ToolResult> => {
    const tool = buildPixieRecallTool() as unknown as {
      execute: (...args: unknown[]) => Promise<ToolResult>;
    };
    return tool.execute("tool-call-1", params, undefined, undefined, ctx);
  };

  it("读本地会话目录即出结果，不经环回控制面", async () => {
    const dir = makeDir();
    writeSession(dir, {
      id: "prev",
      modifiedSec: 1000,
      displayName: "门店对账",
      messages: [{ role: "assistant", text: "B 店差 12 元" }],
    });
    const current = writeSession(dir, { id: "cur", modifiedSec: 2000 });
    const result = await call({}, { sessionManager: { getSessionDir: () => dir, getSessionFile: () => current } });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("B 店差 12 元");
  });

  it("拿不到会话目录 / 非法 mode 时给可读错误", async () => {
    const noDir = await call({}, {});
    expect(noDir.isError).toBe(true);
    expect(noDir.content[0].text).toContain("拿不到当前会话目录");

    const dir = makeDir();
    writeSession(dir, { id: "prev", modifiedSec: 1000, messages: [{ role: "user", text: "x" }] });
    const bad = await call({ mode: "everything" }, { sessionManager: { getSessionDir: () => dir } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("mode 只能是 index、tail 或 search");
  });
});
