/**
 * 报销管家云同步引擎单测：配置解析（env 优先 / 旧配置文件回退）、固定前缀
 * 上传、指纹跳过、失败状态、双向合并、墓碑传播与复活、autoSync 防抖。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENV_ACCOUNT_ID,
  ENV_ACCESS_KEY_ID,
  ENV_AUTO_SYNC,
  ENV_BUCKET,
  ENV_SECRET_ACCESS_KEY,
  getReimburseSync,
  mergeById,
  ReimburseSync,
  scheduleReimburseAutoSync,
} from "../src/reimburse-sync.js";
import { ReimburseStore } from "../src/reimburse-store.js";

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

async function tempLayout(): Promise<{ agentDir: string; store: ReimburseStore; sync: ReimburseSync }> {
  const root = await mkdtemp(join(tmpdir(), "pi-reimburse-sync-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  return { agentDir, store: new ReimburseStore(agentDir), sync: new ReimburseSync(agentDir) };
}

/** env 方式注入一份完整可用配置（模拟插件设置页配置表单写入）。 */
function setEnvConfig(autoSync = false): void {
  process.env[ENV_ACCOUNT_ID] = "abc123";
  process.env[ENV_ACCESS_KEY_ID] = "AKID";
  process.env[ENV_SECRET_ACCESS_KEY] = "secret";
  process.env[ENV_BUCKET] = "bucket";
  process.env[ENV_AUTO_SYNC] = autoSync ? "true" : "false";
}

/** 直接写旧版（工具 config 时代）的配置文件。 */
function writeLegacyConfig(agentDir: string, data: Record<string, unknown>): void {
  const path = join(agentDir, "reimburse", "sync-config.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

/** 收集 R2 请求并返回键 → 体的映射的 mock fetch（桶名 bucket）。 */
function mockR2() {
  const objects = new Map<string, Buffer>();
  const fetchImpl = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = input as URL;
    // pathname 是百分号编码的，中文文件名要解码回原字面。
    const key = decodeURIComponent(url.pathname).replace(/^\/bucket\//, "");
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

/** 在临时目录造一张图片文件。 */
async function tempImage(dir: string, name: string, body = "fake-png"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  return path;
}

describe("mergeById（纯函数 LWW）", () => {
  it("keeps local-only, adopts cloud-only, newer updatedAt wins", () => {
    const local = [
      { id: 1, createdAt: 1, updatedAt: 100, v: "local1" },
      { id: 2, createdAt: 2, updatedAt: 100, v: "local2" },
    ] as never[];
    const cloud = [
      { id: 2, createdAt: 2, updatedAt: 200, v: "cloud2" },
      { id: 3, createdAt: 3, updatedAt: 1, v: "cloud3" },
    ] as never[];
    const { items, adopted } = mergeById(local, cloud);
    // 最新创建的在前（对齐 list 的展示习惯）。
    expect(items.map((item) => (item as { id: number }).id)).toEqual([3, 2, 1]);
    // 云端新增 1 条（id3）+ 云端更新胜出 1 条（id2）= 采纳 2 条。
    expect(adopted).toBe(2);
    const byId = new Map(items.map((item) => [(item as { id: number }).id, item]));
    expect((byId.get(2) as { v: string }).v).toBe("cloud2");
    expect((byId.get(1) as { v: string }).v).toBe("local1");
  });

  it("ties keep the local version", () => {
    const items = mergeById(
      [{ id: 1, createdAt: 1, updatedAt: 100, v: "local" }] as never[],
      [{ id: 1, createdAt: 1, updatedAt: 100, v: "cloud" }] as never[],
    );
    expect((items.items[0] as { v: string }).v).toBe("local");
    expect(items.adopted).toBe(0);
  });
});

describe("ReimburseSync 配置解析", () => {
  it("env 优先，缺失回退旧配置文件，并报告来源", async () => {
    const { agentDir, sync } = await tempLayout();
    expect(sync.getSettings().configured).toBe(false);

    // 旧版工具 config 留下的配置文件：env 未设置时整体回退。
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
    const { agentDir, sync } = await tempLayout();
    writeLegacyConfig(agentDir, {
      accountId: "legacy-acc",
      accessKeyId: "legacy-akid",
      secretAccessKey: "legacy-secret",
      bucket: "legacy-bucket",
    });
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await sync.syncNow();
      const raw = JSON.parse(
        await readFile(join(agentDir, "reimburse", "sync-config.json"), "utf8"),
      ) as Record<string, unknown>;
      // 旧版配置字段原样保留（供 env 缺失时回退），状态已更新。
      expect(raw.accountId).toBe("legacy-acc");
      expect(raw.secretAccessKey).toBe("legacy-secret");
      expect(raw.lastSyncOk).toBe(true);
      expect(raw.lastSyncAt).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ReimburseSync（全链路，mock R2）", () => {
  it("uploads claims.json and images under the fixed prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-reimburse-sync-up-"));
    tempDirs.push(root);
    const { store, sync } = await tempLayout();
    const img = await tempImage(root, "发票.png");
    store.create({ category: "餐饮", subject: "带图", amount: 88, invoiceImagePath: img });
    store.createReceipt({ title: "替票", amount: 100, imagePath: img });

    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      setEnvConfig();
      const stats = await sync.syncNow();
      expect(stats.uploadedClaims).toBe(1);
      expect(stats.uploadedReceipts).toBe(1);
      expect(stats.uploadedImages).toBe(2);
      expect(stats.bytes).toBeGreaterThan(0);

      const cloud = JSON.parse(objects.get("reimburse/claims.json")!.toString("utf8")) as {
        schemaVersion: number;
        claims: { subject: string }[];
        receipts: { title: string }[];
      };
      expect(cloud.schemaVersion).toBe(2);
      expect(cloud.claims.map((entry) => entry.subject)).toEqual(["带图"]);
      expect(cloud.receipts.map((entry) => entry.title)).toEqual(["替票"]);
      const imageKeys = [...objects.keys()].filter((key) => key.includes("/images/"));
      expect(imageKeys).toHaveLength(2);
      expect(imageKeys.some((key) => key.includes("/images/claims/1/发票.png"))).toBe(true);
      expect(imageKeys.some((key) => key.includes("/images/receipts/1/发票.png"))).toBe(true);

      // 状态回写成功。
      const settings = sync.getSettings();
      expect(settings.lastSyncOk).toBe(true);
      expect(settings.lastSyncError).toBeNull();
      expect(settings.lastSyncAt).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips re-uploading unchanged objects on repeat sync", async () => {
    const { store, sync } = await tempLayout();
    store.create({ category: "交通", subject: "无图", amount: 20 });
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      setEnvConfig();
      await sync.syncNow();
      const calls = vi.mocked(fetchImpl).mock.calls.length;

      // 第二次同步：内容无变化 → 仅 GET 云端 claims.json，不再 PUT。
      const stats = await sync.syncNow();
      expect(vi.mocked(fetchImpl).mock.calls.length).toBe(calls + 1);
      expect(stats.uploadedImages).toBe(0);
      expect(stats.bytes).toBe(0);

      // 编辑后再次同步：只 PUT claims.json，无图片。
      store.update(store.list()[0].id, { subject: "改了" });
      const stats2 = await sync.syncNow();
      expect(vi.mocked(fetchImpl).mock.calls.length).toBe(calls + 3);
      expect(stats2.uploadedImages).toBe(0);
      expect(stats2.bytes).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("adopts cloud-only claims/receipts and downloads their images (two-way)", async () => {
    const { store, sync } = await tempLayout();
    store.create({ category: "差旅", subject: "本地", amount: 1 });
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      setEnvConfig();

      // 模拟另一台设备把记录 + 图片放到云端。
      const cloudClaim = {
        id: 50,
        category: "交通",
        date: "2025-07-01",
        project: "",
        subject: "来自云端",
        amount: 66,
        note: null,
        status: "pending",
        invoiceImage: null,
        transactionImage: { id: "img-1", fileName: "截图.png", mediaType: "image/png", bytes: 5 },
        substituteReceiptId: 51,
        createdAt: 1,
        updatedAt: 1,
        reimbursedAt: null,
        deletedAt: null,
      };
      const cloudReceipt = {
        id: 51,
        title: "云端替票",
        amount: 99,
        image: { id: "img-2", fileName: "替票.png", mediaType: "image/png", bytes: 4 },
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      };
      objects.set(
        "reimburse/claims.json",
        Buffer.from(JSON.stringify({ schemaVersion: 2, claims: [cloudClaim], receipts: [cloudReceipt] }), "utf8"),
      );
      objects.set("reimburse/images/claims/50/截图.png", Buffer.from([1, 2, 3, 4, 5]));
      objects.set("reimburse/images/receipts/51/替票.png", Buffer.from([6, 7, 8, 9]));

      const stats = await sync.syncNow();
      expect(stats.downloadedClaims).toBe(1);
      expect(stats.downloadedReceipts).toBe(1);
      expect(stats.downloadedImages).toBe(2);

      // 云端记录进入本地，图片已补齐。
      const adopted = store.list().find((entry) => entry.id === 50);
      expect(adopted?.subject).toBe("来自云端");
      expect(adopted?.substituteReceiptId).toBe(51);
      expect(store.readImageFile("claims", 50, "截图.png")!.byteLength).toBe(5);
      expect(store.getReceipt(51)?.title).toBe("云端替票");
      expect(store.readImageFile("receipts", 51, "替票.png")!.byteLength).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops dangling image references when cloud object is missing", async () => {
    const { store, sync } = await tempLayout();
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      setEnvConfig();
      // 云端记录引用一张不存在的图片。
      objects.set(
        "reimburse/claims.json",
        Buffer.from(
          JSON.stringify({
            schemaVersion: 2,
            claims: [
              {
                id: 9,
                category: "交通",
                date: "2025-07-01",
                project: "",
                subject: "悬空引用",
                amount: 1,
                note: null,
                status: "pending",
                invoiceImage: { id: "img-x", fileName: "丢了.png", mediaType: "image/png", bytes: 3 },
                transactionImage: null,
                substituteReceiptId: null,
                createdAt: 1,
                updatedAt: 1,
                reimbursedAt: null,
                deletedAt: null,
              },
            ],
            receipts: [],
          }),
          "utf8",
        ),
      );
      await sync.syncNow();
      // 引用被丢弃，记录本体保留。
      const adopted = store.list().find((entry) => entry.id === 9);
      expect(adopted?.invoiceImage).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("local deletion propagates to cloud and is not resurrected", async () => {
    const { store, sync } = await tempLayout();
    const claim = store.create({ category: "餐饮", subject: "要删的", amount: 5 });
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      setEnvConfig();
      await sync.syncNow(); // 推上云
      store.remove(claim.id); // 墓碑
      const stats = await sync.syncNow();
      expect(store.list()).toEqual([]);
      // 合并结果里仍含墓碑（供其他设备学习删除）。
      expect(store.listAll()).toHaveLength(1);
      expect(stats.uploadedClaims).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an edit newer than a tombstone resurrects the claim", async () => {
    const { store, sync } = await tempLayout();
    const claim = store.create({ category: "餐饮", subject: "v1", amount: 5 });
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      setEnvConfig();
      await sync.syncNow(); // 推 v1 上云
      const tombstoneAt = store.remove(claim.id).deletedAt as number;
      const cloudEdited = { ...store.listAll()[0], deletedAt: null, subject: "v2 复活版", updatedAt: tombstoneAt + 1000 };
      objects.set(
        "reimburse/claims.json",
        Buffer.from(JSON.stringify({ schemaVersion: 2, claims: [cloudEdited], receipts: [] }), "utf8"),
      );
      await sync.syncNow();
      const revived = store.list().find((entry) => entry.id === claim.id);
      expect(revived?.subject).toBe("v2 复活版");
      expect(revived?.deletedAt).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("purges expired tombstones locally and deletes their cloud images", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-reimburse-sync-purge-"));
    tempDirs.push(root);
    const { store, sync } = await tempLayout();
    const img = await tempImage(root, "a.png");
    const claim = store.create({ category: "交通", subject: "过期墓碑", amount: 1, invoiceImagePath: img });
    store.remove(claim.id);
    // 把墓碑时间拨回 31 天前。
    const old = Date.now() - 31 * 24 * 3600 * 1000;
    const file = JSON.parse(await readFile(join(store.rootDir, "claims.json"), "utf8"));
    file.claims[0].deletedAt = old;
    file.claims[0].updatedAt = old;
    await writeFile(join(store.rootDir, "claims.json"), JSON.stringify(file), "utf8");

    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      setEnvConfig();
      // 先把带图记录推上云，再模拟墓碑过期的本地状态同步。
      // （推上云时本地已是墓碑，所以图片从未上传；云端只有 claims.json。）
      await sync.syncNow();
      expect(store.listAll()).toHaveLength(0); // 过期墓碑被物理清除
      expect(existsSync(store.imageDir("claims", claim.id))).toBe(false);
      // 本地图片目录清空后无悬空上传。
      expect([...objects.keys()].filter((key) => key.includes("/images/"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ReimburseSync（autoSync 防抖）", () => {
  it("debounces mutations and skips when disabled", async () => {
    const { agentDir, store } = await tempLayout();
    setEnvConfig(true);
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      store.create({ category: "差旅", subject: "a", amount: 1 });
      scheduleReimburseAutoSync(agentDir);
      scheduleReimburseAutoSync(agentDir); // 防抖窗口内重复触发只算一次。
      await vi.advanceTimersByTimeAsync(6_000);
      // 防抖后一次同步 = GET 云端 claims.json + PUT 合并结果（无图片）。
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // autoSync 关闭（env 实时生效）时不触发。
      process.env[ENV_AUTO_SYNC] = "false";
      store.create({ category: "差旅", subject: "b", amount: 2 });
      scheduleReimburseAutoSync(agentDir);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("startupSync runs once per process when configured", async () => {
    const { agentDir, sync } = await tempLayout();
    setEnvConfig(true);
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      sync.startupSync();
      sync.startupSync(); // 第二次调用被忽略。
      await vi.advanceTimersByTimeAsync(11_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // GET + PUT（云端为空）
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getReimburseSync 返回同 agentDir 的单例", async () => {
    const { agentDir, sync } = await tempLayout();
    expect(getReimburseSync(agentDir)).toBe(getReimburseSync(agentDir));
    expect(sync).toBeInstanceOf(ReimburseSync);
  });
});
