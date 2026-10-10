/**
 * 个人报销管家存储层 v2（pi-reimburse）。
 *
 * 数据落盘在 `<agentDir>/reimburse/` 下：
 *   - `claims.json`   全量报销单 + 替票（单文件，原子写入）
 *   - `images/claims/<claimId>/<fileName>`    报销单图片（发票/车票/交易截图）
 *   - `images/receipts/<receiptId>/<fileName>` 替票图片
 *   - `sync-config.json` / `upload-hashes.json`（同步引擎维护，见 reimburse-sync.ts）
 *
 * v2 设计要点：
 *   - 报销单字段：类别（固定枚举）、日期、项目名称、事宜、费用、票据、备注；
 *   - 票据两种模式（互斥使用，不强制）：
 *       直票模式：invoiceImage（发票/车票图片）；
 *       替票模式：transactionImage（交易截图）+ substituteReceiptId（关联替票）；
 *   - 替票（Receipt）是独立实体，可被多条报销单共享（同一张替票 + 各自
 *     不同的交易截图）；替票删除前必须先解除所有报销单引用；
 *   - 图片托管：登记/关联时从本地路径复制进 images/ 目录，原图可删；
 *   - 云同步（插件内置，见 reimburse-sync.ts）采用「逐条 LWW + 删除墓碑」，
 *     因此删除一律软删除（deletedAt 墓碑），记录体保留供其他设备学习删除，
 *     超过 30 天的墓碑由同步引擎物理清除（本地图片 + 云端对象）；
 *   - 磁盘权威、无内存缓存：每次操作都从磁盘读、写回磁盘；
 *   - 写入走「临时文件 + rename」原子替换，进程中断不会留半截 JSON；
 *   - 损坏的 JSON 视为空库（原文件改名 `.corrupt-<ts>` 留档排查）；
 *   - v1（title/amount/date/note/status）自动迁移：title→事宜、
 *     类别补“其他”、项目名称留空、票据字段补 null。
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

/** title/subject 长度上限。 */
const MAX_TITLE_LENGTH = 300;
/** project/note 长度上限。 */
const MAX_PROJECT_LENGTH = 300;
const MAX_NOTE_LENGTH = 2_000;
/** 金额上限（元），防误输入天价数字。 */
const MAX_AMOUNT = 100_000_000;

export type ClaimCategory = "差旅" | "交通" | "餐饮" | "办公用品" | "招待" | "其他";
export type ClaimStatus = "pending" | "reimbursed";

/** 图片引用（文件本体托管在 images/ 目录；ImageRef 只存元信息）。 */
export type ImageRef = {
  id: string;
  /** 托管后的文件名（保留原始文件名用于展示与扩展名推断）。 */
  fileName: string;
  mediaType: string;
  bytes: number;
};

/** 一条报销单。 */
export type Claim = {
  id: number;
  category: ClaimCategory;
  /** 发生日期 YYYY-MM-DD；登记时缺省为当天。 */
  date: string;
  /** 项目名称（可空字符串）。 */
  project: string;
  /** 事宜（如「出差高铁票」）。 */
  subject: string;
  /** 费用（元），恒为正数、保留 2 位小数。 */
  amount: number;
  /** 备注（可选）。 */
  note: string | null;
  status: ClaimStatus;
  /** 直票模式：发票/车票图片。 */
  invoiceImage: ImageRef | null;
  /** 替票模式：交易截图。 */
  transactionImage: ImageRef | null;
  /** 替票模式：关联的替票 id（共享实体，可为 null）。 */
  substituteReceiptId: number | null;
  createdAt: number;
  updatedAt: number;
  /** 到账时间；非 reimbursed 恒为 null。 */
  reimbursedAt: number | null;
  /** 删除墓碑（云同步传播删除用）；未删除恒为 null。 */
  deletedAt: number | null;
};

/** 替票：可被多条报销单共享的票据实体。 */
export type Receipt = {
  id: number;
  /** 替票说明（如「出租车发票 ¥300」）。 */
  title: string;
  /** 替票面额（元）；未知为 null。 */
  amount: number | null;
  image: ImageRef | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/** 持久化 JSON 的形状（带 schemaVersion，便于将来迁移）。 */
type ClaimFile = {
  schemaVersion: 2;
  nextClaimId: number;
  nextReceiptId: number;
  claims: Claim[];
  receipts: Receipt[];
};

/** 图片的归属目录种类。 */
export type ImageOwnerKind = "claims" | "receipts";

export type ClaimCreateInput = {
  category: ClaimCategory;
  subject: string;
  amount: number;
  date?: string;
  project?: string;
  note?: string | null;
  /** 发票/车票图片的本地路径（登记时直接关联；可选）。 */
  invoiceImagePath?: string;
  /** 交易截图的本地路径（可选）。 */
  transactionImagePath?: string;
  /** 关联的替票 id（可选；须为现存未删除的替票）。 */
  substituteReceiptId?: number;
};

export type ClaimUpdatePatch = {
  category?: ClaimCategory;
  date?: string;
  project?: string | null;
  subject?: string;
  amount?: number;
  note?: string | null;
  status?: ClaimStatus;
  /** 传图片路径 = 替换图片；传 null = 清除图片引用（本地文件保留到墓碑清理）。 */
  invoiceImagePath?: string | null;
  transactionImagePath?: string | null;
  substituteReceiptId?: number | null;
};

export type ClaimListFilter = {
  status?: ClaimStatus;
  /** 按发生月过滤，格式 YYYY-MM。 */
  month?: string;
  category?: ClaimCategory;
  /** 项目名称前缀过滤（不区分大小写）。 */
  project?: string;
};

export type ReceiptCreateInput = {
  title: string;
  amount?: number | null;
  imagePath?: string;
};

export type ReceiptUpdatePatch = {
  title?: string;
  amount?: number | null;
  /** 传图片路径 = 替换图片；传 null = 清除图片引用。 */
  imagePath?: string | null;
};

export class ReimburseStoreError extends Error {
  readonly code: "INVALID_REQUEST" | "RESOURCE_NOT_FOUND" | "CONFLICT";

  constructor(code: "INVALID_REQUEST" | "RESOURCE_NOT_FOUND" | "CONFLICT", message: string) {
    super(message);
    this.name = "ReimburseStoreError";
    this.code = code;
  }
}

function storeError(
  code: "INVALID_REQUEST" | "RESOURCE_NOT_FOUND" | "CONFLICT",
  message: string,
): ReimburseStoreError {
  return new ReimburseStoreError(code, message);
}

export const CATEGORIES: readonly ClaimCategory[] = ["差旅", "交通", "餐饮", "办公用品", "招待", "其他"];
const STATUSES: readonly ClaimStatus[] = ["pending", "reimbursed"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
/** 常见图片扩展名 → mediaType。 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
};

/** 当天日期 YYYY-MM-DD（本地时区）。 */
export function today(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function requireCategory(value: ClaimCategory): ClaimCategory {
  if (!CATEGORIES.includes(value)) {
    throw storeError("INVALID_REQUEST", `无效的类别：${String(value)}（可选：${CATEGORIES.join("、")}）`);
  }
  return value;
}

function requireStatus(value: ClaimStatus): ClaimStatus {
  if (!STATUSES.includes(value)) {
    throw storeError("INVALID_REQUEST", `无效的报销状态：${String(value)}`);
  }
  return value;
}

function requireSubject(value: string): string {
  const subject = value?.trim();
  if (!subject) throw storeError("INVALID_REQUEST", "事宜不能为空");
  if (subject.length > MAX_TITLE_LENGTH) {
    throw storeError("INVALID_REQUEST", `事宜过长（上限 ${MAX_TITLE_LENGTH} 字符）`);
  }
  return subject;
}

function requireAmount(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw storeError("INVALID_REQUEST", "费用必须是大于 0 的数字");
  }
  if (value > MAX_AMOUNT) {
    throw storeError("INVALID_REQUEST", `费用过大（上限 ${MAX_AMOUNT} 元）`);
  }
  return Math.round(value * 100) / 100;
}

function requireOptionalAmount(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw storeError("INVALID_REQUEST", "替票面额必须是大于 0 的数字");
  }
  if (value > MAX_AMOUNT) {
    throw storeError("INVALID_REQUEST", `替票面额过大（上限 ${MAX_AMOUNT} 元）`);
  }
  return Math.round(value * 100) / 100;
}

function requireDate(value: string): string {
  const date = value?.trim();
  if (!DATE_RE.test(date)) throw storeError("INVALID_REQUEST", `日期格式无效：${String(value)}（应为 YYYY-MM-DD）`);
  return date;
}

function normalizeProject(value: string | null | undefined): string {
  const project = value?.trim();
  return project ? project.slice(0, MAX_PROJECT_LENGTH) : "";
}

function normalizeNote(value: string | null | undefined): string | null {
  const note = value?.trim();
  return note ? note.slice(0, MAX_NOTE_LENGTH) : null;
}

function mediaTypeOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  return IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
}

/** 报销存储。目录懒创建；全部方法同步（数据量小，磁盘读取可忽略）。 */
export class ReimburseStore {
  private readonly root: string;
  private readonly filePath: string;
  private readonly imagesRoot: string;

  constructor(agentDir: string) {
    this.root = join(agentDir, "reimburse");
    this.filePath = join(this.root, "claims.json");
    this.imagesRoot = join(this.root, "images");
  }

  /** 存储根目录（诊断/展示用）。 */
  get rootDir(): string {
    return this.root;
  }

  // ------------------------------------------------------------------
  // 报销单
  // ------------------------------------------------------------------

  /** 可见报销单（不含墓碑）。 */
  list(filter?: ClaimListFilter): Claim[] {
    let claims = this.readFile().claims.filter((claim) => claim.deletedAt === null);
    if (filter?.status !== undefined) {
      claims = claims.filter((claim) => claim.status === filter.status);
    }
    if (filter?.category !== undefined) {
      claims = claims.filter((claim) => claim.category === filter.category);
    }
    if (filter?.month !== undefined) {
      const month = filter.month.trim();
      if (!MONTH_RE.test(month)) {
        throw storeError("INVALID_REQUEST", `月份格式无效：${filter.month}（应为 YYYY-MM）`);
      }
      claims = claims.filter((claim) => claim.date.startsWith(month));
    }
    if (filter?.project !== undefined) {
      const needle = filter.project.trim().toLowerCase();
      if (needle) claims = claims.filter((claim) => claim.project.toLowerCase().includes(needle));
    }
    return claims.map((claim) => ({ ...claim }));
  }

  /** 全量原始报销单（含墓碑；同步引擎专用）。 */
  listAll(): Claim[] {
    return this.readFile().claims.map((claim) => ({ ...claim }));
  }

  get(id: number): Claim | null {
    const claim = this.readFile().claims.find((entry) => entry.id === id);
    return claim && claim.deletedAt === null ? { ...claim } : null;
  }

  /** 登记报销单。图片从本地路径复制托管；substituteReceiptId 须指向现存替票。 */
  create(input: ClaimCreateInput): Claim {
    const file = this.readFile();
    const now = Date.now();
    const claim: Claim = {
      id: file.nextClaimId,
      category: requireCategory(input.category),
      date: input.date !== undefined && input.date !== null ? requireDate(input.date) : today(),
      project: normalizeProject(input.project),
      subject: requireSubject(input.subject),
      amount: requireAmount(input.amount),
      note: normalizeNote(input.note),
      status: "pending",
      invoiceImage: null,
      transactionImage: null,
      substituteReceiptId: null,
      createdAt: now,
      updatedAt: now,
      reimbursedAt: null,
      deletedAt: null,
    };
    if (input.substituteReceiptId !== undefined) {
      claim.substituteReceiptId = this.requireLiveReceiptId(file, input.substituteReceiptId);
    }
    // 先落记录再复制图片：图片复制失败时记录已在，agent 可用 update 重试补图。
    file.nextClaimId += 1;
    file.claims.unshift(claim);
    this.writeFile(file);
    if (input.invoiceImagePath) {
      claim.invoiceImage = this.adoptImage("claims", claim.id, input.invoiceImagePath);
      this.writeFile(file);
    }
    if (input.transactionImagePath) {
      claim.transactionImage = this.adoptImage("claims", claim.id, input.transactionImagePath);
      this.writeFile(file);
    }
    return { ...claim };
  }

  update(id: number, patch: ClaimUpdatePatch): Claim {
    const file = this.readFile();
    const claim = file.claims.find((entry) => entry.id === id && entry.deletedAt === null);
    if (!claim) throw storeError("RESOURCE_NOT_FOUND", `报销单不存在：id ${id}`);

    if (patch.category !== undefined) claim.category = requireCategory(patch.category);
    if (patch.date !== undefined) claim.date = requireDate(patch.date);
    if (patch.project !== undefined) claim.project = normalizeProject(patch.project);
    if (patch.subject !== undefined) claim.subject = requireSubject(patch.subject);
    if (patch.amount !== undefined) claim.amount = requireAmount(patch.amount);
    if (patch.note !== undefined) claim.note = normalizeNote(patch.note);
    if (patch.status !== undefined) {
      const status = requireStatus(patch.status);
      claim.status = status;
      claim.reimbursedAt = status === "reimbursed" ? (claim.reimbursedAt ?? Date.now()) : null;
    }
    if (patch.substituteReceiptId !== undefined) {
      claim.substituteReceiptId =
        patch.substituteReceiptId === null
          ? null
          : this.requireLiveReceiptId(file, patch.substituteReceiptId);
    }
    claim.updatedAt = Date.now();
    this.writeFile(file);

    if (patch.invoiceImagePath !== undefined) {
      claim.invoiceImage =
        patch.invoiceImagePath === null
          ? null
          : this.adoptImage("claims", claim.id, patch.invoiceImagePath);
      this.writeFile(file);
    }
    if (patch.transactionImagePath !== undefined) {
      claim.transactionImage =
        patch.transactionImagePath === null
          ? null
          : this.adoptImage("claims", claim.id, patch.transactionImagePath);
      this.writeFile(file);
    }
    return { ...claim };
  }

  /** 删除 = 打墓碑（记录体与图片保留，供云同步传播删除；见同步引擎 purge）。 */
  remove(id: number): Claim {
    const file = this.readFile();
    const claim = file.claims.find((entry) => entry.id === id && entry.deletedAt === null);
    if (!claim) throw storeError("RESOURCE_NOT_FOUND", `报销单不存在：id ${id}`);
    const now = Date.now();
    claim.deletedAt = now;
    claim.updatedAt = now;
    this.writeFile(file);
    return { ...claim };
  }

  // ------------------------------------------------------------------
  // 替票（共享实体）
  // ------------------------------------------------------------------

  /** 可见替票（不含墓碑）。 */
  listReceipts(): Receipt[] {
    return this.readFile().receipts
      .filter((receipt) => receipt.deletedAt === null)
      .map((receipt) => ({ ...receipt }));
  }

  /** 全量原始替票（含墓碑；同步引擎专用）。 */
  listAllReceipts(): Receipt[] {
    return this.readFile().receipts.map((receipt) => ({ ...receipt }));
  }

  getReceipt(id: number): Receipt | null {
    const receipt = this.readFile().receipts.find((entry) => entry.id === id);
    return receipt && receipt.deletedAt === null ? { ...receipt } : null;
  }

  /** 登记替票。图片从本地路径复制托管。 */
  createReceipt(input: ReceiptCreateInput): Receipt {
    const file = this.readFile();
    const now = Date.now();
    const receipt: Receipt = {
      id: file.nextReceiptId,
      title: requireSubject(input.title),
      amount: requireOptionalAmount(input.amount),
      image: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    file.nextReceiptId += 1;
    file.receipts.unshift(receipt);
    this.writeFile(file);
    if (input.imagePath) {
      receipt.image = this.adoptImage("receipts", receipt.id, input.imagePath);
      this.writeFile(file);
    }
    return { ...receipt };
  }

  updateReceipt(id: number, patch: ReceiptUpdatePatch): Receipt {
    const file = this.readFile();
    const receipt = file.receipts.find((entry) => entry.id === id && entry.deletedAt === null);
    if (!receipt) throw storeError("RESOURCE_NOT_FOUND", `替票不存在：id ${id}`);
    if (patch.title !== undefined) receipt.title = requireSubject(patch.title);
    if (patch.amount !== undefined) receipt.amount = requireOptionalAmount(patch.amount);
    receipt.updatedAt = Date.now();
    this.writeFile(file);
    if (patch.imagePath !== undefined) {
      receipt.image =
        patch.imagePath === null ? null : this.adoptImage("receipts", receipt.id, patch.imagePath);
      this.writeFile(file);
    }
    return { ...receipt };
  }

  /**
   * 删除替票（打墓碑）。仍被未删除报销单引用时拒绝（CONFLICT），
   * 需先解除引用（update 各报销单 substituteReceiptId=null）。
   */
  removeReceipt(id: number): Receipt {
    const file = this.readFile();
    const receipt = file.receipts.find((entry) => entry.id === id && entry.deletedAt === null);
    if (!receipt) throw storeError("RESOURCE_NOT_FOUND", `替票不存在：id ${id}`);
    const referencing = file.claims.filter(
      (claim) => claim.deletedAt === null && claim.substituteReceiptId === id,
    );
    if (referencing.length > 0) {
      throw storeError(
        "CONFLICT",
        `替票仍被 ${referencing.length} 条报销单引用（id：${referencing.map((c) => c.id).join("、")}），先解除引用再删除`,
      );
    }
    const now = Date.now();
    receipt.deletedAt = now;
    receipt.updatedAt = now;
    this.writeFile(file);
    return { ...receipt };
  }

  /** 统计引用某替票的可见报销单数（展示用）。 */
  receiptUsageCount(id: number): number {
    return this.readFile().claims.filter(
      (claim) => claim.deletedAt === null && claim.substituteReceiptId === id,
    ).length;
  }

  // ------------------------------------------------------------------
  // 图片托管
  // ------------------------------------------------------------------

  /** 图片归属目录：images/claims/<id>/ 或 images/receipts/<id>/。 */
  imageDir(kind: ImageOwnerKind, ownerId: number): string {
    return join(this.imagesRoot, kind, String(ownerId));
  }

  /**
   * 把本地图片复制进托管目录并返回 ImageRef。
   * 同名覆盖写（登记时补图/换图是常规操作）。
   */
  private adoptImage(kind: ImageOwnerKind, ownerId: number, sourcePath: string): ImageRef {
    const source = sourcePath?.trim();
    if (!source || !existsSync(source)) {
      throw storeError("INVALID_REQUEST", `图片文件不存在：${source}`);
    }
    const fileName = basename(source);
    if (!mediaTypeOf(fileName).startsWith("image/")) {
      throw storeError("INVALID_REQUEST", `不支持的图片类型：${fileName}`);
    }
    mkdirSync(this.imageDir(kind, ownerId), { recursive: true });
    const target = join(this.imageDir(kind, ownerId), fileName);
    copyFileSync(source, target);
    return {
      id: randomUUID(),
      fileName,
      mediaType: mediaTypeOf(fileName),
      bytes: (() => {
        try {
          return (readFileSync(target) as Buffer).byteLength;
        } catch {
          return 0;
        }
      })(),
    };
  }

  /** 本地是否已托管该图片文件（同步补图判断用）。 */
  hasImageFile(kind: ImageOwnerKind, ownerId: number, fileName: string): boolean {
    return existsSync(join(this.imageDir(kind, ownerId), fileName));
  }

  /** 读取托管图片内容（同步上传用）；缺失返回 null。 */
  readImageFile(kind: ImageOwnerKind, ownerId: number, fileName: string): Buffer | null {
    const path = join(this.imageDir(kind, ownerId), fileName);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  /** 写入托管图片内容（同步从云端补图用）。 */
  writeImageFile(kind: ImageOwnerKind, ownerId: number, fileName: string, body: Buffer): void {
    mkdirSync(this.imageDir(kind, ownerId), { recursive: true });
    writeFileSync(join(this.imageDir(kind, ownerId), fileName), body);
  }

  /** 物理删除某归属的全部本地图片（墓碑清理用）。 */
  hardRemoveImages(kind: ImageOwnerKind, ownerId: number): void {
    rmSync(this.imageDir(kind, ownerId), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------
  // 同步引擎协作接口
  // ------------------------------------------------------------------

  /** 物理删除报销单（墓碑过期清理用；含本地图片目录）。 */
  hardRemove(id: number): void {
    const file = this.readFile();
    file.claims = file.claims.filter((entry) => entry.id !== id);
    this.writeFile(file);
    this.hardRemoveImages("claims", id);
  }

  /** 物理删除替票（墓碑过期清理用；含本地图片目录）。 */
  hardRemoveReceipt(id: number): void {
    const file = this.readFile();
    file.receipts = file.receipts.filter((entry) => entry.id !== id);
    this.writeFile(file);
    this.hardRemoveImages("receipts", id);
  }

  /** 用合并结果整体替换 claims.json（同步引擎合并落盘用）。 */
  replaceAll(claims: Claim[], receipts: Receipt[]): void {
    const file = this.readFile();
    const maxClaimId = claims.reduce((max, claim) => Math.max(max, claim.id), 0);
    const maxReceiptId = receipts.reduce((max, receipt) => Math.max(max, receipt.id), 0);
    this.writeFile({
      schemaVersion: 2,
      nextClaimId: Math.max(file.nextClaimId, maxClaimId + 1),
      nextReceiptId: Math.max(file.nextReceiptId, maxReceiptId + 1),
      claims,
      receipts,
    });
  }

  // ------------------------------------------------------------------
  // 磁盘读写
  // ------------------------------------------------------------------

  private readFile(): ClaimFile {
    if (!existsSync(this.filePath)) return { schemaVersion: 2, nextClaimId: 1, nextReceiptId: 1, claims: [], receipts: [] };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as
        | (Partial<ClaimFile> & { schemaVersion?: number; nextId?: number })
        | null;
      if (raw && raw.schemaVersion === 1 && Array.isArray(raw.claims)) {
        // v1 → v2 迁移：title→事宜，其余补缺省；下次写盘落定为 v2 格式。
        const claims: Claim[] = (raw.claims as Array<Record<string, unknown>>).map((old) => {
          const now = Date.now();
          return {
            id: old.id as number,
            category: "其他",
            date: (old.date as string) ?? today(),
            project: "",
            subject: (old.title as string) ?? "（迁移自 v1）",
            amount: (old.amount as number) ?? 0,
            note: (old.note as string | null) ?? null,
            status: (old.status as ClaimStatus) ?? "pending",
            invoiceImage: null,
            transactionImage: null,
            substituteReceiptId: null,
            createdAt: (old.createdAt as number) ?? now,
            updatedAt: (old.updatedAt as number) ?? now,
            reimbursedAt: (old.reimbursedAt as number | null) ?? null,
            deletedAt: (old.deletedAt as number | null) ?? null,
          } satisfies Claim;
        });
        return {
          schemaVersion: 2,
          nextClaimId: Math.max((raw.nextId as number) ?? 1, claims.reduce((m, c) => Math.max(m, c.id), 0) + 1),
          nextReceiptId: 1,
          claims,
          receipts: [],
        };
      }
      if (raw && raw.schemaVersion === 2 && Array.isArray(raw.claims) && Array.isArray(raw.receipts)) {
        const maxClaimId = raw.claims.reduce((max, claim) => Math.max(max, claim.id), 0);
        const maxReceiptId = raw.receipts.reduce((max, receipt) => Math.max(max, receipt.id), 0);
        return {
          schemaVersion: 2,
          // 防御：nextId 必须大于现存最大 id，否则补齐（下次写盘时落定）。
          nextClaimId: Math.max(raw.nextClaimId ?? 1, maxClaimId + 1),
          nextReceiptId: Math.max(raw.nextReceiptId ?? 1, maxReceiptId + 1),
          claims: raw.claims,
          receipts: raw.receipts,
        };
      }
    } catch {
      // 损坏的 JSON 视为空库（备份损坏原文件，便于事后排查）。
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
    }
    return { schemaVersion: 2, nextClaimId: 1, nextReceiptId: 1, claims: [], receipts: [] };
  }

  private writeFile(file: ClaimFile): void {
    mkdirSync(this.root, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(file, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }

  private requireLiveReceiptId(file: ClaimFile, id: number): number {
    const receipt = file.receipts.find((entry) => entry.id === id && entry.deletedAt === null);
    if (!receipt) throw storeError("INVALID_REQUEST", `关联的替票不存在：id ${id}`);
    return id;
  }
}

/**
 * 模块级单例缓存（键为 agentDir）：磁盘权威无缓存，多实例本就安全，
 * 这里只是省掉重复构造。
 */
const storeCache = new Map<string, ReimburseStore>();

export function getReimburseStore(agentDir: string): ReimburseStore {
  let store = storeCache.get(agentDir);
  if (!store) {
    store = new ReimburseStore(agentDir);
    storeCache.set(agentDir, store);
  }
  return store;
}
