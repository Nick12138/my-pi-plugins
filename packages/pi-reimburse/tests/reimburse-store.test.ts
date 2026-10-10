import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReimburseStore, ReimburseStoreError, today } from "../src/reimburse-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempLayout(): Promise<{ agentDir: string; store: ReimburseStore }> {
  const root = await mkdtemp(join(tmpdir(), "pi-reimburse-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  return { agentDir, store: new ReimburseStore(agentDir) };
}

/** 建一张测试用图片文件，返回路径。 */
async function tempImage(dir: string, name: string, body = "fake-png"): Promise<string> {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

function claimsPath(store: ReimburseStore): string {
  return join(store.rootDir, "claims.json");
}

/** 列出临时文件残留（原子写检查用）。 */
function leftoverTempFiles(store: ReimburseStore): string[] {
  const dir = store.rootDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

describe("ReimburseStore v2（报销单基础 CRUD）", () => {
  it("starts empty and persists across instances", async () => {
    const { agentDir, store } = await tempLayout();
    expect(store.list()).toEqual([]);

    const claim = store.create({ category: "差旅", subject: "出差高铁票", amount: 553.5 });
    expect(claim.id).toBe(1);

    const reopened = new ReimburseStore(agentDir);
    expect(reopened.list().map((entry) => entry.id)).toEqual([1]);
  });

  it("creates claims with defaults (today date, pending, empty project)", async () => {
    const { store } = await tempLayout();
    const claim = store.create({ category: "办公用品", subject: "  打印纸  ", amount: 128, project: "  " });
    expect(claim.subject).toBe("打印纸");
    expect(claim.project).toBe("");
    expect(claim.date).toBe(today());
    expect(claim.note).toBeNull();
    expect(claim.status).toBe("pending");
    expect(claim.reimbursedAt).toBeNull();
    expect(claim.deletedAt).toBeNull();
    expect(claim.invoiceImage).toBeNull();
    expect(claim.transactionImage).toBeNull();
    expect(claim.substituteReceiptId).toBeNull();
  });

  it("rounds amounts to 2 decimals and rejects invalid ones", async () => {
    const { store } = await tempLayout();
    const claim = store.create({ category: "交通", subject: "打车", amount: 33.333 });
    expect(claim.amount).toBe(33.33);

    expect(() => store.create({ category: "交通", subject: "x", amount: 0 })).toThrowError(ReimburseStoreError);
    expect(() => store.create({ category: "交通", subject: "x", amount: -5 })).toThrowError(ReimburseStoreError);
    expect(() => store.create({ category: "交通", subject: "x", amount: Number.NaN })).toThrowError(ReimburseStoreError);
    expect(() => store.create({ category: "交通", subject: "x", amount: 1e9 })).toThrowError(ReimburseStoreError);
  });

  it("rejects invalid category, empty subject, and malformed date", async () => {
    const { store } = await tempLayout();
    expect(() => store.create({ category: "奢侈品" as never, subject: "x", amount: 10 })).toThrowError(/类别/);
    expect(() => store.create({ category: "交通", subject: "  ", amount: 10 })).toThrowError(ReimburseStoreError);
    expect(() => store.create({ category: "交通", subject: "x", amount: 10, date: "2025/01/01" })).toThrowError(
      /YYYY-MM-DD/,
    );
  });

  it("assigns sequential ids and prepends newest first", async () => {
    const { store } = await tempLayout();
    store.create({ category: "差旅", subject: "一", amount: 1 });
    store.create({ category: "差旅", subject: "二", amount: 2 });
    store.create({ category: "差旅", subject: "三", amount: 3 });
    expect(store.list().map((claim) => claim.subject)).toEqual(["三", "二", "一"]);
    expect(store.list().map((claim) => claim.id)).toEqual([3, 2, 1]);
  });

  it("update modifies fields and flips status with timestamps", async () => {
    const { store } = await tempLayout();
    const claim = store.create({
      category: "招待",
      subject: "客户餐",
      amount: 400,
      date: "2025-06-01",
      project: "机场项目",
      note: "发票在抽屉",
    });

    const updated = store.update(claim.id, { subject: "业务招待", amount: 405.5, status: "reimbursed" });
    expect(updated.subject).toBe("业务招待");
    expect(updated.amount).toBe(405.5);
    expect(updated.project).toBe("机场项目");
    expect(updated.status).toBe("reimbursed");
    expect(updated.reimbursedAt).not.toBeNull();

    // 改回 pending 清空到账时间；再次到账重新记录。
    const back = store.update(claim.id, { status: "pending" });
    expect(back.reimbursedAt).toBeNull();
    const again = store.update(claim.id, { status: "reimbursed" });
    expect(again.reimbursedAt).not.toBeNull();

    // note 传空字符串清空；project 传 null 清空。
    const cleared = store.update(claim.id, { note: "  ", project: null });
    expect(cleared.note).toBeNull();
    expect(cleared.project).toBe("");
  });

  it("delete tombstones (soft) instead of physically removing", async () => {
    const { agentDir, store } = await tempLayout();
    const claim = store.create({ category: "餐饮", subject: "误录", amount: 1 });
    store.remove(claim.id);

    expect(store.list()).toEqual([]);
    expect(store.get(claim.id)).toBeNull();
    // 墓碑记录保留（供云同步传播删除）。
    expect(store.listAll()).toHaveLength(1);
    expect(store.listAll()[0].deletedAt).not.toBeNull();

    // id 不复用。
    const next = store.create({ category: "餐饮", subject: "新", amount: 2 });
    expect(next.id).toBe(2);

    // 新实例同样读到墓碑。
    expect(new ReimburseStore(agentDir).listAll()).toHaveLength(2);
  });

  it("update/get/delete on missing id throws RESOURCE_NOT_FOUND", async () => {
    const { store } = await tempLayout();
    expect(() => store.update(99, { subject: "x" })).toThrowError(ReimburseStoreError);
    expect(store.get(99)).toBeNull();
    expect(() => store.remove(99)).toThrowError(ReimburseStoreError);
  });
});

describe("ReimburseStore v2（过滤）", () => {
  it("filters by status / month / category / project", async () => {
    const { store } = await tempLayout();
    const a = store.create({ category: "差旅", subject: "六月A", amount: 100, date: "2025-06-01", project: "机场" });
    store.create({ category: "餐饮", subject: "七月B", amount: 200, date: "2025-07-15", project: "高铁站" });
    store.create({ category: "差旅", subject: "七月C", amount: 300, date: "2025-07-20" });
    store.update(a.id, { status: "reimbursed" });

    expect(store.list({ status: "pending" }).map((c) => c.subject)).toEqual(["七月C", "七月B"]);
    expect(store.list({ status: "reimbursed" }).map((c) => c.subject)).toEqual(["六月A"]);
    expect(store.list({ month: "2025-07" }).map((c) => c.subject)).toEqual(["七月C", "七月B"]);
    expect(store.list({ month: "2025-07", status: "pending" })).toHaveLength(2);
    expect(store.list({ category: "差旅" }).map((c) => c.subject)).toEqual(["七月C", "六月A"]);
    expect(store.list({ project: "机场" }).map((c) => c.subject)).toEqual(["六月A"]);
    expect(store.list({ project: "机" }).map((c) => c.subject)).toEqual(["六月A"]);
  });

  it("rejects malformed month filter", async () => {
    const { store } = await tempLayout();
    expect(() => store.list({ month: "2025-7" })).toThrowError(/YYYY-MM/);
  });
});

describe("ReimburseStore v2（替票共享实体）", () => {
  it("creates / updates / lists receipts", async () => {
    const { store } = await tempLayout();
    const receipt = store.createReceipt({ title: "出租车发票", amount: 300 });
    expect(receipt.id).toBe(1);
    expect(receipt.amount).toBe(300);
    expect(receipt.image).toBeNull();
    expect(receipt.deletedAt).toBeNull();

    const updated = store.updateReceipt(receipt.id, { title: "出租车发票（6月）", amount: 320 });
    expect(updated.title).toBe("出租车发票（6月）");
    expect(updated.amount).toBe(320);

    const noAmount = store.createReceipt({ title: "手写票" });
    expect(noAmount.amount).toBeNull();
    expect(store.listReceipts()).toHaveLength(2);
  });

  it("receipt amount validation", async () => {
    const { store } = await tempLayout();
    expect(() => store.createReceipt({ title: "x", amount: 0 })).toThrowError(ReimburseStoreError);
    expect(() => store.createReceipt({ title: "x", amount: -3 })).toThrowError(ReimburseStoreError);
    expect(() => store.createReceipt({ title: "" })).toThrowError(ReimburseStoreError);
  });

  it("multiple claims can share one receipt (different transaction screenshots)", async () => {
    const { store } = await tempLayout();
    const receipt = store.createReceipt({ title: "同一张替票", amount: 500 });
    const c1 = store.create({
      category: "交通",
      subject: "周一打车",
      amount: 120,
      substituteReceiptId: receipt.id,
    });
    const c2 = store.create({
      category: "交通",
      subject: "周三打车",
      amount: 150,
      substituteReceiptId: receipt.id,
    });
    expect(c1.substituteReceiptId).toBe(receipt.id);
    expect(c2.substituteReceiptId).toBe(receipt.id);
    expect(store.receiptUsageCount(receipt.id)).toBe(2);
  });

  it("rejects linking to a nonexistent or deleted receipt", async () => {
    const { store } = await tempLayout();
    expect(() =>
      store.create({ category: "交通", subject: "x", amount: 1, substituteReceiptId: 99 }),
    ).toThrowError(/替票不存在/);

    const receipt = store.createReceipt({ title: "会删的" });
    store.removeReceipt(receipt.id);
    expect(() =>
      store.create({ category: "交通", subject: "x", amount: 1, substituteReceiptId: receipt.id }),
    ).toThrowError(/替票不存在/);
    // 引用校验在先、单据存在性在后：先建一条有效报销单再试。
    const claim = store.create({ category: "交通", subject: "y", amount: 2 });
    expect(() => store.update(claim.id, { substituteReceiptId: receipt.id })).toThrowError(/替票不存在/);
  });

  it("blocks deleting a receipt still referenced by live claims", async () => {
    const { store } = await tempLayout();
    const receipt = store.createReceipt({ title: "被引用的" });
    const claim = store.create({
      category: "交通",
      subject: "打车",
      amount: 100,
      substituteReceiptId: receipt.id,
    });

    expect(() => store.removeReceipt(receipt.id)).toThrowError(/仍被 1 条报销单引用/);
    // 解除引用后可删。
    store.update(claim.id, { substituteReceiptId: null });
    const removed = store.removeReceipt(receipt.id);
    expect(removed.deletedAt).not.toBeNull();
    expect(store.listReceipts()).toEqual([]);
  });

  it("receipt delete is a tombstone too", async () => {
    const { store } = await tempLayout();
    const receipt = store.createReceipt({ title: "待删" });
    store.removeReceipt(receipt.id);
    expect(store.listAllReceipts()).toHaveLength(1);
    expect(store.listAllReceipts()[0].deletedAt).not.toBeNull();
  });
});

describe("ReimburseStore v2（图片托管）", () => {
  it("adopts images by copying them into managed dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-reimburse-img-"));
    tempDirs.push(root);
    const { store } = await tempLayout();
    const imgPath = await tempImage(root, "发票.png");

    const claim = store.create({
      category: "餐饮",
      subject: "工作餐",
      amount: 88,
      invoiceImagePath: imgPath,
    });
    expect(claim.invoiceImage).not.toBeNull();
    expect(claim.invoiceImage?.fileName).toBe("发票.png");
    expect(claim.invoiceImage?.mediaType).toBe("image/png");
    // 原图删除后托管副本仍在。
    const managed = join(store.imageDir("claims", claim.id), "发票.png");
    expect(existsSync(managed)).toBe(true);

    // 替票图片。
    const receipt = store.createReceipt({ title: "替票", imagePath: imgPath });
    expect(receipt.image?.fileName).toBe("发票.png");
    expect(store.hasImageFile("receipts", receipt.id, "发票.png")).toBe(true);
    expect(store.readImageFile("receipts", receipt.id, "发票.png")!.toString("utf8")).toBe("fake-png");
  });

  it("replaces and clears images via update", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-reimburse-img-"));
    tempDirs.push(root);
    const { store } = await tempLayout();
    const img1 = await tempImage(root, "a.png", "aaa");
    const img2 = await tempImage(root, "b.png", "bbb");

    const claim = store.create({ category: "交通", subject: "打车", amount: 20, invoiceImagePath: img1 });
    expect(claim.invoiceImage?.fileName).toBe("a.png");

    const replaced = store.update(claim.id, { invoiceImagePath: img2 });
    expect(replaced.invoiceImage?.fileName).toBe("b.png");
    expect(store.readImageFile("claims", claim.id, "b.png")!.toString("utf8")).toBe("bbb");

    const cleared = store.update(claim.id, { invoiceImagePath: null });
    expect(cleared.invoiceImage).toBeNull();

    // 替票替换/清除。
    const receipt = store.createReceipt({ title: "票", imagePath: img1 });
    const rReplaced = store.updateReceipt(receipt.id, { imagePath: img2 });
    expect(rReplaced.image?.fileName).toBe("b.png");
    expect(store.updateReceipt(receipt.id, { imagePath: null }).image).toBeNull();
  });

  it("rejects missing files and non-image extensions", async () => {
    const { store } = await tempLayout();
    expect(() =>
      store.create({ category: "交通", subject: "x", amount: 1, invoiceImagePath: "Z:/不存在.png" }),
    ).toThrowError(/图片文件不存在/);

    const root = await mkdtemp(join(tmpdir(), "pi-reimburse-img-"));
    tempDirs.push(root);
    const doc = await tempImage(root, "合同.pdf");
    expect(() => store.create({ category: "交通", subject: "x", amount: 1, invoiceImagePath: doc })).toThrowError(
      /不支持的图片类型/,
    );
  });

  it("hardRemove wipes the claim and its managed image dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-reimburse-img-"));
    tempDirs.push(root);
    const { store } = await tempLayout();
    const img = await tempImage(root, "a.png");
    const claim = store.create({ category: "交通", subject: "x", amount: 1, invoiceImagePath: img });

    store.hardRemove(claim.id);
    expect(store.listAll()).toHaveLength(0);
    expect(existsSync(store.imageDir("claims", claim.id))).toBe(false);
  });
});

describe("ReimburseStore（磁盘健壮性）", () => {
  it("recovers from corrupt JSON by starting empty and keeping a .corrupt backup", async () => {
    const { agentDir, store } = await tempLayout();
    store.create({ category: "差旅", subject: "旧数据", amount: 10 });

    writeFileSync(claimsPath(store), "{ not json", "utf8");
    const reopened = new ReimburseStore(agentDir);
    expect(reopened.list()).toEqual([]);
    const leftovers = readdirSync(store.rootDir).filter((name) => name.includes(".corrupt-"));
    expect(leftovers).toHaveLength(1);

    const claim = reopened.create({ category: "差旅", subject: "新数据", amount: 20 });
    expect(claim.id).toBe(1);
  });

  it("heals nextIds when they lag behind the max existing ids", async () => {
    const { agentDir, store } = await tempLayout();
    store.create({ category: "差旅", subject: "一", amount: 1 });
    store.create({ category: "差旅", subject: "二", amount: 2 });
    store.createReceipt({ title: "替票一" });

    // 人为把 nextId 改小，模拟手工编辑事故。
    const fs = await import("node:fs/promises");
    const raw = JSON.parse(await fs.readFile(claimsPath(store), "utf8"));
    raw.nextClaimId = 1;
    raw.nextReceiptId = 1;
    await fs.writeFile(claimsPath(store), JSON.stringify(raw), "utf8");

    const reopened = new ReimburseStore(agentDir);
    const claim = reopened.create({ category: "差旅", subject: "三", amount: 3 });
    expect(claim.id).toBe(3);
    const receipt = reopened.createReceipt({ title: "替票二" });
    expect(receipt.id).toBe(2);
  });

  it("atomic write leaves no temp files behind", async () => {
    const { store } = await tempLayout();
    for (let i = 0; i < 5; i += 1) {
      store.create({ category: "其他", subject: `批量${i}`, amount: i + 1 });
    }
    expect(leftoverTempFiles(store)).toEqual([]);
  });
});

describe("ReimburseStore（v1 → v2 迁移）", () => {
  it("migrates a v1 file on read: title→subject, category=其他, receipts empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-reimburse-v1-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");

    // 写一份 v1 格式文件（含已到账和待报销各一条）。
    const v1File = {
      schemaVersion: 1,
      nextId: 3,
      claims: [
        {
          id: 1,
          title: "v1 报销一",
          amount: 100,
          date: "2025-06-01",
          note: "老备注",
          status: "pending",
          createdAt: 1750000000000,
          updatedAt: 1750000000000,
          reimbursedAt: null,
        },
        {
          id: 2,
          title: "v1 报销二",
          amount: 200,
          date: "2025-06-02",
          note: null,
          status: "reimbursed",
          createdAt: 1750000000001,
          updatedAt: 1750000000001,
          reimbursedAt: 1750000001000,
        },
      ],
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(agentDir, "reimburse"), { recursive: true });
    writeFileSync(join(agentDir, "reimburse", "claims.json"), JSON.stringify(v1File), "utf8");

    const store = new ReimburseStore(agentDir);
    const claims = store.list();
    expect(claims).toHaveLength(2);
    const byId = new Map(claims.map((entry) => [entry.id, entry]));
    expect(byId.get(2)).toMatchObject({
      subject: "v1 报销二",
      category: "其他",
      project: "",
      amount: 200,
      status: "reimbursed",
      reimbursedAt: 1750000001000,
    });
    expect(byId.get(1)).toMatchObject({ subject: "v1 报销一", note: "老备注", status: "pending" });

    // 迁移后可正常追加，id 接 v1 的 nextId。
    const next = store.create({ category: "差旅", subject: "迁移后新增", amount: 1 });
    expect(next.id).toBe(3);
    // 替票簿从空开始。
    expect(store.listReceipts()).toEqual([]);

    // 下次写盘落定为 v2 格式。
    store.update(1, { note: "触发写盘" });
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(
      join(agentDir, "reimburse", "claims.json"),
      "utf8",
    ));
    expect(raw.schemaVersion).toBe(2);
    expect(raw.nextClaimId).toBe(4);
    expect(Array.isArray(raw.receipts)).toBe(true);
  });
});
