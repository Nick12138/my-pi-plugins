import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoStore } from "../src/memo-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempLayout(): Promise<{ agentDir: string; store: MemoStore }> {
  const root = await mkdtemp(join(tmpdir(), "piabyss-memo-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  return { agentDir, store: new MemoStore(agentDir) };
}

function notesPath(store: MemoStore): string {
  return join(store.rootDir, "notes.json");
}

/** 列出 notes.json 所在目录里的临时文件残留（原子写检查用）。 */
function leftoverTempFiles(store: MemoStore): string[] {
  const dir = store.rootDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

describe("MemoStore（磁盘格式与原子写）", () => {
  it("starts empty and persists across instances", async () => {
    const { agentDir, store } = await tempLayout();
    expect(store.list()).toEqual([]);

    const note = store.create({ type: "memo", title: "第一条", contentMd: "内容" });
    expect(store.list()).toHaveLength(1);

    // 新实例读同一份数据（磁盘权威，无内存缓存）。
    const reopened = new MemoStore(agentDir);
    expect(reopened.list().map((entry) => entry.id)).toEqual([note.id]);
  });

  it("creates notes with normalized tags and defaults", async () => {
    const { store } = await tempLayout();
    const note = store.create({
      type: "task",
      title: "  带标签  ",
      contentMd: "正文",
      tags: ["#A", "a", "b ", ""],
      workspaceHint: " PiAbyss ",
    });
    expect(note.title).toBe("带标签");
    expect(note.status).toBe("open");
    expect(note.sessionId).toBeNull();
    // 大小写去重 + 去空白 + 丢弃空串，保留首个书写形式。
    expect(note.tags).toEqual(["A", "b"]);
    expect(note.workspaceHint).toBe("PiAbyss");
    expect(note.completedAt).toBeNull();
    expect(note.deletedAt).toBeNull();
    expect(note.result).toBeNull();
    expect(note.images).toEqual([]);
  });

  it("rejects invalid create input (type / title)", async () => {
    const { store } = await tempLayout();
    expect(() => store.create({ type: "nope" as never, title: "t", contentMd: "c" }))
      .toThrow("无效的记录类型");
    expect(() => store.create({ type: "memo", title: "   ", contentMd: "c" }))
      .toThrow("标题不能为空");
    expect(store.list()).toEqual([]);
  });

  it("writes the exact on-disk shape (schemaVersion + full note fields)", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ type: "idea", title: "t", contentMd: "c", tags: ["x"] });
    const raw = JSON.parse(readFileSync(notesPath(store), "utf8")) as {
      schemaVersion: number;
      notes: Record<string, unknown>[];
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.notes).toHaveLength(1);
    expect(Object.keys(raw.notes[0] as object).sort()).toEqual(
      [
        "id",
        "type",
        "title",
        "contentMd",
        "status",
        "tags",
        "workspaceHint",
        "images",
        "createdAt",
        "updatedAt",
        "sessionId",
        "completedAt",
        "result",
        "deletedAt",
      ].sort(),
    );

    // 字段读回一致（跨实例，模拟 PiAbyss 桌面页/同步引擎读取同一文件）。
    const reopened = new MemoStore(agentDir);
    const loaded = reopened.list().find((entry) => entry.id === note.id);
    expect(loaded).toEqual(note);
  });

  it("uses atomic write: no leftover temp files, content correct after each op", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "memo", title: "a", contentMd: "x" });
    store.update(note.id, { status: "done" });
    store.completeWithResult(note.id, { resultMd: "r", sessionId: "s1", sessionPath: null, sessionTitle: null, sessionCwd: null });
    store.remove(note.id);
    store.purgeDeleted(Number.MAX_SAFE_INTEGER);

    expect(leftoverTempFiles(store)).toEqual([]);
    const raw = JSON.parse(readFileSync(notesPath(store), "utf8")) as { schemaVersion: 1; notes: unknown[] };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.notes).toEqual([]);
  });

  it("updates fields and manages completion timestamps", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "idea", title: "t", contentMd: "c" });

    const running = store.update(note.id, { status: "in_progress", sessionId: "session-1" });
    expect(running.status).toBe("in_progress");
    expect(running.sessionId).toBe("session-1");

    const done = store.update(note.id, { status: "done" });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();

    const reopened = store.update(note.id, { status: "open", sessionId: null });
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();

    const retitled = store.update(note.id, { title: "新标题", tags: ["x"] });
    expect(retitled.title).toBe("新标题");
    expect(retitled.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);
  });

  it("throws on unknown note ids", async () => {
    const { store } = await tempLayout();
    expect(() =>
      store.update("00000000-0000-4000-8000-00000000000f", { status: "done" }),
    ).toThrow();
    expect(() => store.remove("00000000-0000-4000-8000-00000000000f")).toThrow();
    expect(() =>
      store.completeWithResult("00000000-0000-4000-8000-00000000000f", {
        resultMd: "x",
        sessionId: "s1",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      }),
    ).toThrow();
  });

  it("remove marks a tombstone (kept for sync), purge physically deletes", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ type: "memo", title: "t", contentMd: "c" });
    const removed = store.remove(note.id);
    expect(removed.deletedAt).not.toBeNull();
    // list 过滤墓碑；listAll / 记录体保留。
    expect(store.list()).toEqual([]);
    expect(store.listAll()).toHaveLength(1);
    expect(store.get(note.id)).toBeNull();

    // 未过期的墓碑不会被清理（生产调用传 now - 30 天）。
    expect(store.purgeDeleted(Date.now() - 30 * 24 * 3600 * 1000)).toHaveLength(0);
    expect(store.listAll()).toHaveLength(1);
    // 过期后物理删除。
    const purged = store.purgeDeleted(Number.MAX_SAFE_INTEGER);
    expect(purged.map((entry) => entry.id)).toEqual([note.id]);
    expect(store.listAll()).toEqual([]);

    // 重开实例后墓碑数据兼容（listAll 含 deletedAt 字段）。
    const reopened = new MemoStore(agentDir);
    expect(reopened.list()).toEqual([]);
  });

  it("replaceAll replaces the whole note set", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "memo", title: "a", contentMd: "x" });
    store.replaceAll([note]);
    expect(store.list().map((entry) => entry.id)).toEqual([note.id]);
    store.replaceAll([]);
    expect(store.list()).toEqual([]);
    expect(existsSync(store.rootDir)).toBe(true);
  });

  describe("completeWithResult", () => {
    it("marks done and records the summary with session info", async () => {
      const { store } = await tempLayout();
      const note = store.create({ type: "task", title: "t", contentMd: "c" });

      const done = store.completeWithResult(note.id, {
        resultMd: "  已修复，测试通过。  ",
        sessionId: " session-1 ",
        sessionPath: "D:/sessions/session-1.jsonl",
        sessionTitle: " 处理备忘录 ",
        sessionCwd: "D:/work/PiAbyss",
      });
      expect(done.status).toBe("done");
      expect(done.completedAt).not.toBeNull();
      expect(done.result).not.toBeNull();
      expect(done.result?.resultMd).toBe("已修复，测试通过。");
      expect(done.result?.sessionId).toBe("session-1");
      expect(done.sessionId).toBe("session-1");
      expect(done.result?.sessionTitle).toBe("处理备忘录");
      expect(done.result?.sessionCwd).toBe("D:/work/PiAbyss");
      expect(typeof done.result?.at).toBe("number");

      // 覆盖式更新：再次 complete 替换旧总结。
      const again = store.completeWithResult(note.id, {
        resultMd: "第二轮处理完成。",
        sessionId: "session-2",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      });
      expect(again.result?.resultMd).toBe("第二轮处理完成。");
      expect(again.result?.sessionId).toBe("session-2");
      expect(again.result?.sessionPath).toBeNull();
    });

    it("rejects empty summaries and missing session info", async () => {
      const { store } = await tempLayout();
      const note = store.create({ type: "memo", title: "t", contentMd: "c" });
      expect(() =>
        store.completeWithResult(note.id, {
          resultMd: "   ",
          sessionId: "s1",
          sessionPath: null,
          sessionTitle: null,
          sessionCwd: null,
        }),
      ).toThrow();
      expect(() =>
        store.completeWithResult(note.id, {
          resultMd: "x",
          sessionId: "  ",
          sessionPath: null,
          sessionTitle: null,
          sessionCwd: null,
        }),
      ).toThrow();
    });

    it("rejects missing result field (tool-level contract)", async () => {
      const { store } = await tempLayout();
      const note = store.create({ type: "memo", title: "t", contentMd: "c" });
      // result 缺省（模拟工具未传 result）→ 报错而非写入空总结。
      expect(() =>
        store.completeWithResult(note.id, {
          resultMd: "",
          sessionId: "s1",
          sessionPath: null,
          sessionTitle: null,
          sessionCwd: null,
        }),
      ).toThrow(/结果总结不能为空/);
      // 失败不落盘：记录仍为 open、result 为 null。
      const after = store.get(note.id);
      expect(after?.status).toBe("open");
      expect(after?.result).toBeNull();
      expect(leftoverTempFiles(store)).toEqual([]);
    });
  });

  it("reads legacy notes without a result field as result: null", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ type: "memo", title: "t", contentMd: "c" });

    // 模拟 v1 旧数据：手工抹去 result 字段后重新读取。
    const filePath = notesPath(store);
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      notes: Record<string, unknown>[];
    };
    for (const entry of raw.notes) delete entry.result;
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const reopened = new MemoStore(agentDir);
    const loaded = reopened.list().find((entry) => entry.id === note.id);
    expect(loaded?.result).toBeNull();
  });

  it("treats corrupt JSON as an empty board and backs up the broken file", async () => {
    const { store } = await tempLayout();
    store.create({ type: "memo", title: "t", contentMd: "c" });
    writeFileSync(notesPath(store), "{not json", "utf8");
    expect(store.list()).toEqual([]);
    const dir = readdirSync(store.rootDir);
    expect(dir.some((name) => name.includes(".corrupt-"))).toBe(true);
  });
});
