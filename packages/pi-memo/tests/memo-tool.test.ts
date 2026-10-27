import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import memoExtension from "../extensions/pi-memo.js";
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
  delete process.env.PI_MEMO_ALLOW_TEMP;
});

/** 用临时 agentDir 加载插件并抓取注册的工具。 */
async function loadTool(): Promise<CapturedTool> {
  const root = await mkdtemp(join(tmpdir(), "pi-memo-tool-"));
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

describe("memo create 动作", () => {
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

describe("memo delete 动作", () => {
  /** 新建一条便签并返回 id。 */
  async function createNote(tool: CapturedTool, title: string): Promise<string> {
    const created = await tool.execute("c1", { action: "create", title, contentMd: "作废测试" });
    const id = /id: (\S+)/.exec(textOf(created))?.[1];
    if (!id) throw new Error("create 没有返回 id");
    return id;
  }

  it("软删除：打墓碑、记录体保留、list 不再返回", async () => {
    const tool = await loadTool();
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
    const id = await createNote(tool, "过期活动报名");

    const deleted = await tool.execute("t1", { action: "delete", id });
    expect(deleted.isError).toBeUndefined();
    expect(textOf(deleted)).toContain("过期活动报名");
    expect(textOf(deleted)).toContain("soft delete");

    // 墓碑落盘：listAll 仍能读到记录体，deletedAt 非空。
    const stored = getMemoStore(agentDir).getAny(id) as MemoNote | null;
    expect(stored).not.toBeNull();
    expect(stored?.deletedAt).not.toBeNull();
    expect(stored?.title).toBe("过期活动报名");
    // 可见列表不再返回。
    expect(getMemoStore(agentDir).list()).toHaveLength(0);
    const listed = await tool.execute("t2", { action: "list" });
    expect(textOf(listed)).toBe("The memo board is empty.");
  });

  it("重复 delete 报错（已是墓碑）", async () => {
    const tool = await loadTool();
    const id = await createNote(tool, "重复删除");
    const first = await tool.execute("t1", { action: "delete", id });
    expect(first.isError).toBeUndefined();

    const again = await tool.execute("t2", { action: "delete", id });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain(`备忘录记录不存在或已删除：${id}`);
  });

  it("不存在的 id 报错", async () => {
    const tool = await loadTool();
    const missing = "00000000-0000-4000-8000-00000000000f";
    const failed = await tool.execute("t1", { action: "delete", id: missing });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain(`备忘录记录不存在或已删除：${missing}`);
  });

  it("缺 id 报错", async () => {
    const tool = await loadTool();
    const failed = await tool.execute("t1", { action: "delete" });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("a note id is required");
  });
});

/** 造一个最小 ctx（护栏只看 cwd，其余字段按需）。 */
function ctxAt(cwd: string): unknown {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => "01a178d8-test",
      getSessionFile: () => null,
      getSessionName: () => null,
      getCwd: () => cwd,
    },
  };
}

describe("一次性临时会话护栏", () => {
  it("cwd 在系统临时目录下：写动作被拒，且不落盘", async () => {
    const tool = await loadTool();
    const scratch = await mkdtemp(join(tmpdir(), "pi-memo-scratch-"));
    tempDirs.push(scratch);

    const refused = await tool.execute(
      "t1",
      { action: "create", title: "暗号：蓝鲸七号", contentMd: "测试用" },
      undefined,
      undefined,
      ctxAt(scratch) as never,
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("临时目录里的一次性会话");
    expect(textOf(refused)).toContain("PI_MEMO_ALLOW_TEMP=1");

    // 拒绝是因为真的没写：换一个正常 cwd 去读，看板仍是空的。
    const listed = await tool.execute("t2", { action: "list" }, undefined, undefined, ctxAt(process.cwd()) as never);
    expect(textOf(listed)).toBe("The memo board is empty.");
  });

  it("临时会话里 list 仍然放行（只读不拦）", async () => {
    const tool = await loadTool();
    const scratch = await mkdtemp(join(tmpdir(), "pi-memo-scratch-"));
    tempDirs.push(scratch);
    const listed = await tool.execute("t1", { action: "list" }, undefined, undefined, ctxAt(scratch) as never);
    expect(listed.isError).toBeUndefined();
    expect(textOf(listed)).toBe("The memo board is empty.");
  });

  it("真实工作区 cwd 不受影响", async () => {
    const tool = await loadTool();
    const created = await tool.execute(
      "t1",
      { action: "create", title: "买咖啡豆" },
      undefined,
      undefined,
      ctxAt(process.cwd()) as never,
    );
    expect(created.isError).toBeUndefined();
    expect(textOf(created)).toContain("Memo note created");
  });

  it("PI_MEMO_ALLOW_TEMP=1 可放开", async () => {
    const tool = await loadTool();
    const scratch = await mkdtemp(join(tmpdir(), "pi-memo-scratch-"));
    tempDirs.push(scratch);
    process.env.PI_MEMO_ALLOW_TEMP = "1";
    const created = await tool.execute(
      "t1",
      { action: "create", title: "临时目录里真要记一条" },
      undefined,
      undefined,
      ctxAt(scratch) as never,
    );
    expect(created.isError).toBeUndefined();
    expect(textOf(created)).toContain("Memo note created");
  });

  it("没有 ctx（老宿主 / prewarm）时不拦，避免误伤", async () => {
    const tool = await loadTool();
    const created = await tool.execute("t1", { action: "create", title: "无 ctx" });
    expect(created.isError).toBeUndefined();
    expect(textOf(created)).toContain("Memo note created");
  });
});
