import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import memoExtension from "../extensions/piabyss-memo.js";
import { getMemoStore, type MemoNote } from "../src/memo-store.js";

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

type CapturedTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  delete process.env.PI_CODING_AGENT_DIR;
});

/** 用临时 agentDir 加载插件并抓取注册的工具。 */
async function loadTool(): Promise<CapturedTool> {
  const root = await mkdtemp(join(tmpdir(), "piabyss-memo-tool-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool: (tool: CapturedTool) => {
      captured = tool;
    },
  };
  memoExtension(pi as unknown as ExtensionAPI);
  if (!captured) throw new Error("扩展没有注册工具");
  return captured;
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("piabyss_memo create 动作", () => {
  it("写入新记录并回显 id（不需要 id 入参）", async () => {
    const tool = await loadTool();
    const created = await tool.execute("t1", {
      action: "create",
      title: "  买咖啡豆  ",
      contentMd: "顺路看看有没有拼配",
      tags: ["#生活", "生活", ""],
    });
    expect(created.isError).toBeUndefined();
    expect(textOf(created)).toContain("Memo note created");
    const id = /id: (\S+)/.exec(textOf(created))?.[1];
    expect(id).toBeTruthy();

    const note = getMemoStore(process.env.PI_CODING_AGENT_DIR ?? "").list()[0] as MemoNote;
    expect(note.id).toBe(id);
    expect(note.title).toBe("买咖啡豆");
    expect(note.contentMd).toBe("顺路看看有没有拼配");
    expect(note.status).toBe("open");
    expect(note.tags).toEqual(["生活"]);
    expect(note.result).toBeNull();
    expect(note.dueAt).toBeNull();
    expect(note.recurrence).toBeNull();
    expect(note.nextDueAt).toBeNull();
  });

  it("创建时带一次性截止与周期规则", async () => {
    const tool = await loadTool();
    const local = new Date(2026, 9, 12, 13, 0, 0).getTime();
    const created = await tool.execute("t1", {
      action: "create",
      title: "周报",
      dueAt: "2026-10-12 13:00",
    });
    expect(textOf(created)).toContain(`due: ${new Date(local).toISOString()}`);

    const recursed = await tool.execute("t2", {
      action: "create",
      title: "周一站会",
      recurrence: { frequency: "weekly", weekdays: [1], time: "09:30" },
    });
    expect(textOf(recursed)).toContain("recurs: weekly on Mon at 09:30");
    const note = getMemoStore(process.env.PI_CODING_AGENT_DIR ?? "")
      .list()
      .find((entry) => entry.title === "周一站会");
    expect(note?.nextDueAt).not.toBeNull();
  });

  it("标题为空时报错，不落盘", async () => {
    const tool = await loadTool();
    const failed = await tool.execute("t1", { action: "create", title: "   " });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("标题不能为空");

    const listed = await tool.execute("t2", { action: "list" });
    expect(textOf(listed)).toBe("The memo board is empty.");
  });

  it("周期规则的 until 终点按本地时间解析后写入", async () => {
    const tool = await loadTool();
    const created = await tool.execute("t1", {
      action: "create",
      title: "打卡",
      recurrence: {
        frequency: "daily",
        time: "08:00",
        until: "2026-10-20",
      },
    });
    const until = new Date(2026, 9, 20, 0, 0, 0).getTime();
    expect(textOf(created)).toContain(`until ${new Date(until).toISOString()}`);
  });
});
