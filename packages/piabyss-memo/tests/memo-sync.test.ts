/**
 * 备忘录云同步引擎单测（从 PiAbyss Host 的 memo-sync.test.ts 移植，改为
 * env 配置 + 旧配置文件回退的解析语义）：
 * 配置解析（env 优先 / legacy 回退）、固定前缀上传、指纹跳过、失败状态、
 * 双向合并、墓碑传播与复活、autoSync 防抖。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoNote, MemoStore } from "../src/memo-store.js";
import {
  ENV_ACCOUNT_ID,
  ENV_ACCESS_KEY_ID,
  ENV_AUTO_SYNC,
  ENV_BUCKET,
  ENV_SECRET_ACCESS_KEY,
  getMemoSync,
  MemoSync,
  scheduleMemoAutoSync,
} from "../src/memo-sync.js";

const tempDirs: string[] = [];
vi.useFakeTimers();

afterEach(async () => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  for (const name of [
    ENV_ACCOUNT_ID,
    ENV_ACCESS_KEY_ID,
    ENV_SECRET_ACCESS_KEY,
    ENV_BUCKET,
    ENV_AUTO_SYNC,
  ]) {
    delete process.env[name];
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempLayout(): Promise<{ agentDir: string; store: MemoStore; sync: MemoSync }> {
  const root = await mkdtemp(join(tmpdir(), "piabyss-memo-sync-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  return { agentDir, store: new MemoStore(agentDir), sync: getMemoSync(agentDir) };
}

function setEnvConfig(autoSync = false): void {
  process.env[ENV_ACCOUNT_ID] = "abc123";
  process.env[ENV_ACCESS_KEY_ID] = "AKID";
  process.env[ENV_SECRET_ACCESS_KEY] = "secret";
  process.env[ENV_BUCKET] = "memos";
  process.env[ENV_AUTO_SYNC] = autoSync ? "true" : "false";
}

/** 直接写旧版（Host 内置时代）的配置文件。 */
function writeLegacyConfig(agentDir: string, data: Record<string, unknown>): void {
  const path = join(agentDir, "piabyss", "memo", "sync-config.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 造一条带本地图片文件的记录（插件 store 的 create 不收图片，走 replaceAll）。 */
function createNoteWithImage(store: MemoStore, title: string): MemoNote {
  const note = store.create({ type: "memo", title, contentMd: "正文" });
  const withImage: MemoNote = {
    ...note,
    images: [{ id: "img-1", fileName: "a.png", mediaType: "image/png", bytes: PNG.byteLength }],
  };
  store.replaceAll([withImage]);
  store.writeImageFile(note.id, "a.png", PNG);
  return withImage;
}

/** 收集 R2 请求并返回键 → 体的映射的 mock fetch。 */
function mockR2() {
  const objects = new Map<string, Buffer>();
  const fetchImpl = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = input as URL;
    const key = url.pathname.replace(/^\/memos\//, "");
    if ((init?.method ?? "GET") === "PUT") {
      objects.set(key, Buffer.from(init?.body as ArrayBuffer));
      return new Response(null, { status: 200 });
    }
    const found = objects.get(key);
    return found
      ? new Response(new Uint8Array(found), { status: 200 })
      : new Response("nope", { status: 404 });
  });
  return { objects, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("MemoSync 配置解析", () => {
  it("env 优先，缺失回退旧配置文件，并报告来源", async () => {
    const { agentDir, sync } = await tempLayout();
    expect(sync.getSettings().configured).toBe(false);

    // 旧版 Host 内置同步留下的配置文件：env 未设置时整体回退。
    writeLegacyConfig(agentDir, {
      accountId: "legacy-acc",
      accessKeyId: "legacy-akid",
      secretAccessKey: "legacy-secret",
      bucket: "legacy-bucket",
      autoSync: true,
    });
    const legacy = sync.getSettings();
    expect(legacy.configured).toBe(true);
    expect(legacy.accountId).toBe("legacy-acc");
    expect(legacy.autoSync).toBe(true);
    expect(legacy.configSource.accountId).toBe(false);

    // env 设置后逐项覆盖。
    process.env[ENV_ACCOUNT_ID] = "env-acc";
    const mixed = sync.getSettings();
    expect(mixed.accountId).toBe("env-acc");
    expect(mixed.bucket).toBe("legacy-bucket");
    expect(mixed.configSource.accountId).toBe(true);
    expect(mixed.configSource.bucket).toBe(false);

    // autoSync 的 env 值：truthy 集合之外一律视为关。
    process.env[ENV_AUTO_SYNC] = "yes";
    expect(sync.getSettings().autoSync).toBe(true);
    process.env[ENV_AUTO_SYNC] = "off";
    expect(sync.getSettings().autoSync).toBe(false);
  });

  it("同步状态写回 sync-config.json（保留旧版配置字段）", async () => {
    const { agentDir, store, sync } = await tempLayout();
    setEnvConfig();
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    store.create({ type: "memo", title: "a", contentMd: "x" });

    await sync.syncNow();
    const settings = sync.getSettings();
    expect(settings.lastSyncOk).toBe(true);
    expect(settings.lastSyncError).toBeNull();
    expect(settings.lastSyncAt).not.toBeNull();
    expect(existsSync(join(agentDir, "piabyss", "memo", "sync-config.json"))).toBe(true);

    // 重开实例读到同一份状态。
    expect(getMemoSync(agentDir).getSettings().lastSyncAt).toBe(settings.lastSyncAt);
  });
});

describe("MemoSync 同步", () => {
  it("uploads notes.json and images under the fixed prefix", async () => {
    const { store, sync } = await tempLayout();
    createNoteWithImage(store, "带图");
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    setEnvConfig();

    const stats = await sync.syncNow();
    expect(stats.uploadedNotes).toBe(1);
    expect(stats.uploadedImages).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);

    const notes = JSON.parse(objects.get("piabyss/memo/notes.json")!.toString("utf8")) as {
      notes: { title: string }[];
    };
    expect(notes.notes.map((entry) => entry.title)).toEqual(["带图"]);
    const imageKey = [...objects.keys()].find(
      (key) => key.includes("/images/") && key.endsWith(".png"),
    );
    expect(imageKey).toBeDefined();
    expect([...objects.get(imageKey!)!]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it("skips re-uploading unchanged notes and images on repeat sync", async () => {
    const { store, sync } = await tempLayout();
    createNoteWithImage(store, "带图");
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    setEnvConfig();

    await sync.syncNow();
    const calls = vi.mocked(fetchImpl).mock.calls.length;

    // 第二次同步：内容无变化 → 仅 GET 云端 notes.json，不再 PUT 任何对象。
    const stats = await sync.syncNow();
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(calls + 1);
    expect(stats.uploadedImages).toBe(0);
    expect(stats.bytes).toBe(0);

    // 编辑记录后再次同步：只 PUT notes.json，图片不重传。
    const note = store.list()[0]!;
    store.update(note.id, { title: "改标题" });
    const stats2 = await sync.syncNow();
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(calls + 3);
    expect(stats2.uploadedImages).toBe(0);
    expect(stats2.bytes).toBeGreaterThan(0);
  });

  it("records failures in lastSync state", async () => {
    const { sync } = await tempLayout();
    setEnvConfig();
    const failing = vi.fn(async () => new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", failing as unknown as typeof fetch);
    try {
      await expect(sync.syncNow()).rejects.toMatchObject({ status: 403 });
      const settings = sync.getSettings();
      expect(settings.lastSyncOk).toBe(false);
      expect(settings.lastSyncError).toContain("403");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("syncNow refuses to run without configuration", async () => {
    const { sync } = await tempLayout();
    await expect(sync.syncNow()).rejects.toThrow("尚未配置");
  });

  it("scheduleAutoSync debounces mutations and skips when disabled", async () => {
    const { agentDir, store } = await tempLayout();
    setEnvConfig(true);
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      store.create({ type: "memo", title: "a", contentMd: "x" });
      scheduleMemoAutoSync(agentDir);
      scheduleMemoAutoSync(agentDir); // 防抖窗口内重复触发只算一次。
      await vi.advanceTimersByTimeAsync(6_000);
      // 防抖后一次同步 = GET 云端 notes.json + PUT 合并结果（无图片）。
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // autoSync 关闭时不触发。
      process.env[ENV_AUTO_SYNC] = "false";
      store.create({ type: "memo", title: "b", contentMd: "x" });
      scheduleMemoAutoSync(agentDir);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("startupSync runs once when autoSync is on and configured", async () => {
    const { store, sync } = await tempLayout();
    setEnvConfig(true);
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      store.create({ type: "memo", title: "a", contentMd: "x" });
      sync.startupSync();
      sync.startupSync(); // 每进程只做一次。
      await vi.advanceTimersByTimeAsync(11_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // GET + PUT
      // 再等一个窗口也不会有第二次。
      await vi.advanceTimersByTimeAsync(11_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adopts cloud-only notes and downloads their images (two-way sync)", async () => {
    const { store, sync } = await tempLayout();
    // 本地已有自己的记录。
    store.create({ type: "memo", title: "本地", contentMd: "x" });
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    setEnvConfig();

    // 模拟另一台设备先把一条记录 + 图片放到云端。
    const cloudNote: MemoNote = {
      id: "cloud-note-1",
      type: "idea",
      title: "来自云端",
      contentMd: "c",
      status: "open",
      tags: [],
      workspaceHint: null,
      images: [{ id: "img-1", fileName: "b.png", mediaType: "image/png", bytes: 8 }],
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      completedAt: null,
      result: null,
      deletedAt: null,
    };
    objects.set(
      "piabyss/memo/notes.json",
      Buffer.from(JSON.stringify({ schemaVersion: 1, notes: [cloudNote] }), "utf8"),
    );
    objects.set("piabyss/memo/images/cloud-note-1/b.png", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

    const stats = await sync.syncNow();
    expect(stats.downloadedNotes).toBe(1);
    expect(stats.downloadedImages).toBe(1);

    // 云端记录进入本地，图片文件已补齐。
    const adopted = store.list().find((entry) => entry.id === "cloud-note-1");
    expect(adopted?.title).toBe("来自云端");
    expect(store.readImageFile("cloud-note-1", "b.png").byteLength).toBe(8);
  });

  it("adopts legacy cloud notes missing deletedAt/result (not treated as deleted)", async () => {
    const { store, sync } = await tempLayout();
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    setEnvConfig();
    // 模拟旧版本写入的云端 notes.json：记录没有 deletedAt / result 字段。
    objects.set(
      "piabyss/memo/notes.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          notes: [
            {
              id: "legacy-note-1",
              type: "memo",
              title: "旧格式记录",
              contentMd: "c",
              status: "open",
              tags: [],
              workspaceHint: null,
              images: [],
              createdAt: 1,
              updatedAt: 1,
              completedAt: null,
            },
          ],
        }),
        "utf8",
      ),
    );
    await sync.syncNow();
    const adopted = store.list().find((entry) => entry.id === "legacy-note-1");
    expect(adopted?.title).toBe("旧格式记录");
    expect(adopted?.deletedAt).toBeNull();
    expect(adopted?.result).toBeNull();
  });

  it("local deletion propagates to cloud and is not resurrected", async () => {
    const { store, sync } = await tempLayout();
    const note = store.create({ type: "memo", title: "要删的", contentMd: "x" });
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    setEnvConfig();
    // 第一次同步把记录推上云端。
    await sync.syncNow();
    // 本地删除（墓碑），再同步：云端被覆盖为带墓碑的记录。
    store.remove(note.id);
    const stats = await sync.syncNow();
    expect(store.list()).toEqual([]);
    // 合并结果里仍含墓碑（供其他设备学习删除）。
    expect(store.listAll()).toHaveLength(1);
    expect(stats.uploadedNotes).toBe(0);
  });

  it("an edit newer than a tombstone resurrects the note", async () => {
    const { store, sync } = await tempLayout();
    const note = store.create({ type: "memo", title: "v1", contentMd: "x" });
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    setEnvConfig();
    await sync.syncNow(); // 推 v1 上云
    const tombstoneAt = store.remove(note.id).deletedAt as number;
    const cloudEdited: MemoNote = {
      ...store.listAll()[0],
      deletedAt: null,
      title: "v2 复活版",
      updatedAt: tombstoneAt + 1000,
    };
    objects.set(
      "piabyss/memo/notes.json",
      Buffer.from(JSON.stringify({ schemaVersion: 1, notes: [cloudEdited] }), "utf8"),
    );
    await sync.syncNow();
    const revived = store.list().find((entry) => entry.id === note.id);
    expect(revived?.title).toBe("v2 复活版");
    expect(revived?.deletedAt).toBeNull();
  });
});
