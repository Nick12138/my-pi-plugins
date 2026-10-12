import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoStore, type MemoNote } from "../src/memo-store.js";

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

    const note = store.create({ title: "第一条", contentMd: "内容" });
    expect(store.list()).toHaveLength(1);

    // 新实例读同一份数据（磁盘权威，无内存缓存）。
    const reopened = new MemoStore(agentDir);
    expect(reopened.list().map((entry) => entry.id)).toEqual([note.id]);
  });

  it("creates notes with normalized tags and defaults", async () => {
    const { store } = await tempLayout();
    const note = store.create({
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

  it("rejects invalid create input (title)", async () => {
    const { store } = await tempLayout();
    expect(() => store.create({ title: "   ", contentMd: "c" }))
      .toThrow("标题不能为空");
    expect(store.list()).toEqual([]);
  });

  it("writes the exact on-disk shape (schemaVersion + full note fields)", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ title: "t", contentMd: "c", tags: ["x"] });
    const raw = JSON.parse(readFileSync(notesPath(store), "utf8")) as {
      schemaVersion: number;
      notes: Record<string, unknown>[];
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.notes).toHaveLength(1);
    expect(Object.keys(raw.notes[0] as object).sort()).toEqual(
      [
        "id",
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
        "dueAt",
        "recurrence",
        "nextDueAt",
        "lastDoneAt",
      ].sort(),
    );

    // 字段读回一致（跨实例，模拟 PiAbyss 桌面页/同步引擎读取同一文件）。
    const reopened = new MemoStore(agentDir);
    const loaded = reopened.list().find((entry) => entry.id === note.id);
    expect(loaded).toEqual(note);
  });

  it("uses atomic write: no leftover temp files, content correct after each op", async () => {
    const { store } = await tempLayout();
    const note = store.create({ title: "a", contentMd: "x" });
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
    const note = store.create({ title: "t", contentMd: "c" });

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

  it("rejects the removed 'archived' status", async () => {
    const { store } = await tempLayout();
    const note = store.create({ title: "t", contentMd: "c" });
    expect(() => store.update(note.id, { status: "archived" as never })).toThrow(
      /无效的记录状态/,
    );
  });

  it("creates notes with a one-shot dueAt and computes nextDueAt for recurrence", async () => {
    const { store } = await tempLayout();
    const dueAt = Date.now() + 86_400_000;
    const oneShot = store.create({ title: "一次性", contentMd: "c", dueAt });
    expect(oneShot.dueAt).toBe(dueAt);
    expect(oneShot.recurrence).toBeNull();
    expect(oneShot.nextDueAt).toBeNull();
    expect(oneShot.lastDoneAt).toBeNull();

    const recurring = store.create({
      title: "每周一处理",
      contentMd: "c",
      recurrence: { frequency: "weekly", weekdays: [1], time: "13:00" },
    });
    expect(recurring.recurrence).toEqual({
      frequency: "weekly",
      interval: 1,
      weekdays: [1],
      monthDay: null,
      time: "13:00",
      tz: "Asia/Shanghai",
      until: null,
      startDate: null,
    });
    expect(recurring.nextDueAt).not.toBeNull();
    expect(recurring.nextDueAt).toBeGreaterThan(Date.now());

    // 非法输入直接拒绝，不产生半截记录。
    expect(() => store.create({ title: "坏截止", contentMd: "c", dueAt: -1 }))
      .toThrow(/dueAt/);
    expect(() =>
      store.create({
        title: "坏规则",
        contentMd: "c",
        recurrence: { frequency: "weekly", time: "13:00" },
      }),
    ).toThrow(/weekdays/);
  });

  it("update sets and clears plan fields; invalid recurrence rejected", async () => {
    const { store } = await tempLayout();
    const note = store.create({ title: "t", contentMd: "c" });

    const dueAt = Date.now() + 3_600_000;
    store.update(note.id, { dueAt });
    expect(store.get(note.id)?.dueAt).toBe(dueAt);
    store.update(note.id, { dueAt: null });
    expect(store.get(note.id)?.dueAt).toBeNull();

    const updated = store.update(note.id, {
      recurrence: { frequency: "daily", time: "09:00" },
    });
    expect(updated.recurrence?.frequency).toBe("daily");
    expect(updated.nextDueAt).not.toBeNull();

    const cleared = store.update(note.id, { recurrence: null });
    expect(cleared.recurrence).toBeNull();
    expect(cleared.nextDueAt).toBeNull();

    expect(() =>
      store.update(note.id, { recurrence: { frequency: "nope", time: "09:00" } }),
    ).toThrow(/frequency/);
  });

  it("rejects marking a recurring note done via update; allowed after clearing recurrence", async () => {
    const { store } = await tempLayout();
    const note = store.create({
      title: "t",
      contentMd: "c",
      recurrence: { frequency: "daily", time: "09:00" },
    });
    expect(() => store.update(note.id, { status: "done" })).toThrow(
      /周期记录不能直接标记完成/,
    );
    // 失败不落盘。
    expect(store.get(note.id)?.status).toBe("open");
    // 同一次 patch 里先清周期再置 done：允许（明确表达「停用并完结」）。
    const done = store.update(note.id, { recurrence: null, status: "done" });
    expect(done.status).toBe("done");
    expect(done.recurrence).toBeNull();
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
    const note = store.create({ title: "t", contentMd: "c" });
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
    const note = store.create({ title: "a", contentMd: "x" });
    store.replaceAll([note]);
    expect(store.list().map((entry) => entry.id)).toEqual([note.id]);
    store.replaceAll([]);
    expect(store.list()).toEqual([]);
    expect(existsSync(store.rootDir)).toBe(true);
  });

  describe("completeWithResult", () => {
    it("marks done and records the summary with session info", async () => {
      const { store } = await tempLayout();
      const note = store.create({ title: "t", contentMd: "c" });

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
      const note = store.create({ title: "t", contentMd: "c" });
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
      const note = store.create({ title: "t", contentMd: "c" });
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

    it("finishes only the current cycle for a recurring note and rolls nextDueAt", async () => {
      const { store } = await tempLayout();
      const note = store.create({ title: "周报", contentMd: "c" });
      // 构造逾期中的周期记录（模拟云端同步下来的 nextDueAt 已过）：
      const overdue: MemoNote = {
        ...note,
        recurrence: {
          frequency: "weekly",
          interval: 1,
          weekdays: [1],
          monthDay: null,
          time: "13:00",
          tz: "Asia/Shanghai",
          until: null,
          startDate: null,
        },
        nextDueAt: Date.now() - 7 * 86_400_000,
      };
      store.replaceAll([overdue]);

      const cycle1 = store.completeWithResult(note.id, {
        resultMd: "本轮完成",
        sessionId: "s1",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      });
      // 周期记录不置 done：状态回到 open，总结与 lastDoneAt 已记，
      // 逾期轮次跳过，直接滚到未来的下一轮。
      expect(cycle1.status).toBe("open");
      expect(cycle1.completedAt).toBeNull();
      expect(cycle1.lastDoneAt).not.toBeNull();
      expect(cycle1.result?.resultMd).toBe("本轮完成");
      expect(cycle1.recurrence).not.toBeNull();
      expect(cycle1.nextDueAt).not.toBeNull();
      expect(cycle1.nextDueAt).toBeGreaterThan(Date.now());

      // 再完成一轮：仍 open，nextDueAt 保持未来（未到时间不会重复滚动），
      // 总结覆盖式更新。
      const cycle2 = store.completeWithResult(note.id, {
        resultMd: "第二轮完成",
        sessionId: "s2",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      });
      expect(cycle2.status).toBe("open");
      expect(cycle2.nextDueAt).toBe(cycle1.nextDueAt);
      expect(cycle2.result?.resultMd).toBe("第二轮完成");
      expect(cycle2.lastDoneAt).toBeGreaterThanOrEqual(cycle1.lastDoneAt!);
    });

    it("ends a recurring note naturally when until has passed (→ done)", async () => {
      const { store } = await tempLayout();
      const note = store.create({
        title: "过期周期",
        contentMd: "c",
        // until 已过：创建时就没有未来发生时刻。
        recurrence: { frequency: "daily", time: "09:00", until: Date.now() - 1_000 },
      });
      expect(note.nextDueAt).toBeNull();

      const done = store.completeWithResult(note.id, {
        resultMd: "最后一轮",
        sessionId: "s1",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      });
      expect(done.status).toBe("done");
      expect(done.completedAt).not.toBeNull();
      expect(done.nextDueAt).toBeNull();
      // 规则保留供追溯（桌面端仍能看到「曾是周期任务」）。
      expect(done.recurrence).not.toBeNull();
    });

    it("reopen recomputes nextDueAt for a recurring note adopted from cloud", async () => {
      const { store } = await tempLayout();
      const note = store.create({ title: "t", contentMd: "c" });
      // 模拟云端同步下来的状态：周期记录、已完结、nextDueAt 缺失。
      const cloudLike: MemoNote = {
        ...note,
        status: "done",
        completedAt: Date.now(),
        recurrence: {
          frequency: "weekly",
          interval: 1,
          weekdays: [1],
          monthDay: null,
          time: "13:00",
          tz: "Asia/Shanghai",
          until: null,
          startDate: null,
        },
        nextDueAt: null,
        lastDoneAt: Date.now(),
      };
      store.replaceAll([cloudLike]);

      const reopened = store.update(note.id, { status: "open", sessionId: null });
      expect(reopened.status).toBe("open");
      expect(reopened.nextDueAt).not.toBeNull();
      expect(reopened.nextDueAt).toBeGreaterThan(Date.now());
    });
  });

  it("reads legacy notes without a result field as result: null", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ title: "t", contentMd: "c" });

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

  it("migrates legacy 'archived' status to done and backfills plan fields on read", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ title: "老归档", contentMd: "c" });

    // 模拟 v2 旧数据：status=archived 且没有计划字段。
    const filePath = notesPath(store);
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      notes: Record<string, unknown>[];
    };
    raw.notes[0]!.status = "archived";
    for (const field of ["dueAt", "recurrence", "nextDueAt", "lastDoneAt"]) {
      delete raw.notes[0]![field];
    }
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const reopened = new MemoStore(agentDir);
    const loaded = reopened.list().find((entry) => entry.id === note.id);
    expect(loaded?.status).toBe("done");
    expect(loaded?.dueAt).toBeNull();
    expect(loaded?.recurrence).toBeNull();
    expect(loaded?.nextDueAt).toBeNull();
    expect(loaded?.lastDoneAt).toBeNull();
  });

  it("sanitizes a corrupted recurrence rule to null on read (board stays healthy)", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ title: "脏数据", contentMd: "c" });

    const filePath = notesPath(store);
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      notes: Record<string, unknown>[];
    };
    raw.notes[0]!.recurrence = { frequency: "bogus" };
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const reopened = new MemoStore(agentDir);
    const loaded = reopened.list().find((entry) => entry.id === note.id);
    expect(loaded?.recurrence).toBeNull();
    expect(loaded?.nextDueAt).toBeNull();
  });

  it("treats corrupt JSON as an empty board and backs up the broken file", async () => {
    const { store } = await tempLayout();
    store.create({ title: "t", contentMd: "c" });
    writeFileSync(notesPath(store), "{not json", "utf8");
    expect(store.list()).toEqual([]);
    const dir = readdirSync(store.rootDir);
    expect(dir.some((name) => name.includes(".corrupt-"))).toBe(true);
  });
});
