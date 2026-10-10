/**
 * 报销管家云同步引擎（插件内置，不依赖 PiAbyss Host）。
 *
 * 键布局（前缀固定，不开放配置）：
 *   reimburse/claims.json
 *   reimburse/images/claims/<claimId>/<fileName>
 *   reimburse/images/receipts/<receiptId>/<fileName>
 *
 * 同步策略 = 「逐条记录最后写入者胜（LWW）+ 删除墓碑」（与 PiAyss 备忘录
 * 同一套策略）：
 *   1. 拉取云端 claims.json（不存在视为空库）；
 *   2. 与本地全量（含墓碑）按 id 逐条合并，报销单与替票各自独立 LWW，
 *      updatedAt 新者胜；墓碑也是一种「更新」，删除后另一设备的编辑会复活记录；
 *   3. 合并结果整体回写本地，并从云端补齐缺失的图片（报销单图片与替票图片）；
 *   4. 上传合并后的 claims.json 与图片，供其他设备拉取；
 *   5. 超过 30 天的删除墓碑物理清除（本地图片目录 + 云端对象）。
 *
 * 配置来源（插件自持，密钥不进对话/工具）：
 *   - 环境变量优先——由插件设置页「报销管家」的配置表单写入
 *     （PI_REIMBURSE_R2_* / PI_REIMBURSE_AUTO_SYNC，扩展与其同进程因此实时生效）；
 *   - 兼容回退：环境变量缺失时读旧版 <agentDir>/reimburse/sync-config.json
 *     里的同名字段（工具 config action 时代的配置文件，老设备免重填）。
 *
 * 同步状态（lastSyncAt/Ok/Error）持久化在 sync-config.json（保留旧版配置字段）；
 * 上传指纹缓存在 upload-hashes.json（内容未变化的对象跳过上传；切换桶/账号时
 * 整体作废）。autoSync 开启时，报销数据每次变更后防抖触发后台同步。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Claim, ImageOwnerKind, Receipt } from "./reimburse-store.js";
import { getReimburseStore } from "./reimburse-store.js";
import {
  deleteObject,
  getObject,
  putObject,
  testConnection,
  type R2Credentials,
} from "./r2-client.js";

const CONFIG_FILE_NAME = "sync-config.json";
/** 上传指纹缓存文件：记录「已确认上传到云端」的对象内容哈希，避免重复上传。 */
const UPLOAD_HASHES_FILE = "upload-hashes.json";
/** 对象键前缀：固定值，不开放配置。 */
const OBJECT_KEY_PREFIX = "reimburse";
/** autoSync 防抖窗口：连续变更合并为一次同步。 */
const AUTO_SYNC_DEBOUNCE_MS = 5_000;
/** 每次进程只做一次启动同步；延迟执行错开启动高峰。 */
const STARTUP_SYNC_DELAY_MS = 10_000;
/** 删除墓碑保留时长：过期后物理清除（本地与云端）。 */
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

/* ----------------------------- 配置项（env） ------------------------------ */

export const ENV_ACCOUNT_ID = "PI_REIMBURSE_R2_ACCOUNT_ID";
export const ENV_ACCESS_KEY_ID = "PI_REIMBURSE_R2_ACCESS_KEY_ID";
export const ENV_SECRET_ACCESS_KEY = "PI_REIMBURSE_R2_SECRET_ACCESS_KEY";
export const ENV_BUCKET = "PI_REIMBURSE_R2_BUCKET";
export const ENV_AUTO_SYNC = "PI_REIMBURSE_AUTO_SYNC";

/** autoSync 的 env 值：真值集合（其余一律视为关）。 */
const AUTO_SYNC_TRUTHY = new Set(["true", "1", "on", "yes"]);

export type ReimburseSyncConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  autoSync: boolean;
};

export type ReimburseSyncSettings = ReimburseSyncConfig & {
  /** 四项连接信息是否齐备（决定「立即同步/测试」是否可用）。 */
  configured: boolean;
  /** 各配置项当前来源：true = 设置注入的环境变量；false = 旧配置文件回退。 */
  configSource: { accountId: boolean; accessKeyId: boolean; secretAccessKey: boolean; bucket: boolean };
  lastSyncAt: number | null;
  lastSyncOk: boolean | null;
  lastSyncError: string | null;
};

/** 磁盘状态文件（旧版 = 配置 + 状态；新版只依赖其中的状态与回退配置）。 */
type SyncStateFile = {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  autoSync?: boolean;
  lastSyncAt?: number | null;
  lastSyncOk?: boolean | null;
  lastSyncError?: string | null;
};

/** 上传指纹缓存（与 sync-config.json 同目录；切换目标桶/账号时整体作废）。 */
type UploadHashesFile = {
  version: 1;
  /** 缓存所属目标：`<accountId>/<bucket>`，不匹配则清空重建。 */
  target: string;
  /** 对象键 → 内容 sha256。 */
  hashes: Record<string, string>;
};

/** 一次双向同步的统计。 */
export type ReimburseSyncStats = {
  /** 合并后仍可见（未删除）的报销单数。 */
  uploadedClaims: number;
  /** 合并后仍可见的替票数。 */
  uploadedReceipts: number;
  /** 实际上传的图片对象数（报销单 + 替票）。 */
  uploadedImages: number;
  /** 从云端采纳（云端新增 + 云端更新胜出）的报销单数。 */
  downloadedClaims: number;
  /** 从云端采纳的替票数。 */
  downloadedReceipts: number;
  /** 从云端补齐到本地的图片数。 */
  downloadedImages: number;
  /** 上传字节总数。 */
  bytes: number;
  at: number;
};

function credentialsOf(config: ReimburseSyncConfig): R2Credentials {
  return {
    accountId: config.accountId.trim(),
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey.trim(),
    bucket: config.bucket.trim(),
  };
}

function configPath(agentDir: string): string {
  return join(agentDir, "reimburse", CONFIG_FILE_NAME);
}

/** 读取磁盘状态文件（缺失/损坏 → 空对象）。 */
function readStateFile(agentDir: string): Partial<SyncStateFile> {
  try {
    const raw = JSON.parse(readFileSync(configPath(agentDir), "utf8")) as Partial<SyncStateFile>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** 原子写 JSON（临时文件 + rename）。 */
function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  renameSync(tempPath, path);
}

/** env 值（trim；空串视为未设置）。 */
function envValue(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}

/** 云端记录的最小形状过滤（无有效 id/时间戳的条目丢弃）。 */
function parseCloudFile(body: Buffer | null): { claims: Claim[]; receipts: Receipt[] } {
  if (!body) return { claims: [], receipts: [] };
  let parsed: { claims?: unknown; receipts?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("云端 claims.json 内容损坏，无法解析");
  }
  const pick = <T extends { id: number; createdAt: number; updatedAt: number }>(value: unknown): T[] => {
    if (!Array.isArray(value)) return [];
    const items: T[] = [];
    for (const raw of value as T[]) {
      if (typeof raw?.id !== "number" || !Number.isSafeInteger(raw.id)) continue;
      if (typeof raw?.createdAt !== "number" || typeof raw?.updatedAt !== "number") continue;
      items.push(raw);
    }
    return items;
  };
  return {
    claims: pick<Claim>(parsed.claims),
    receipts: pick<Receipt>(parsed.receipts),
  };
}

/**
 * 逐条 LWW 合并（纯函数，便于单测）：
 * - 仅一方存在 → 保留该方（本地新记录 / 其他设备新增的记录）；
 * - 双方存在 → updatedAt 新者胜；打平保留本地；
 * - 墓碑也是一种「更新」（remove 会同时推进 updatedAt），
 *   因此另一台设备在删除之后的编辑（updatedAt 更新）会自然胜出并复活记录。
 */
export function mergeById<T extends { id: number; updatedAt: number }>(
  local: T[],
  cloud: T[],
): { items: T[]; adopted: number } {
  const byId = new Map<number, T>();
  for (const item of local) byId.set(item.id, item);
  let adopted = 0;
  for (const item of cloud) {
    const localItem = byId.get(item.id);
    if (!localItem || item.updatedAt > localItem.updatedAt) {
      byId.set(item.id, item);
      adopted += 1;
    }
  }
  const items = [...byId.values()].sort(
    (a, b) => b.createdAt - a.createdAt || b.id - a.id,
  );
  return { items, adopted };
}

function warn(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[reimburse-sync] ${context}: ${message}`);
}

export class ReimburseSync {
  private readonly agentDir: string;
  private autoSyncTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private startupSyncDone = false;
  private syncing = false;

  constructor(agentDir: string) {
    this.agentDir = agentDir;
  }

  private get store() {
    return getReimburseStore(this.agentDir);
  }

  /** 解析当前生效配置：env 优先，缺失回退旧配置文件；并附最近同步状态。 */
  getSettings(): ReimburseSyncSettings {
    const state = readStateFile(this.agentDir);
    const envAccountId = envValue(ENV_ACCOUNT_ID);
    const envAccessKeyId = envValue(ENV_ACCESS_KEY_ID);
    const envSecret = envValue(ENV_SECRET_ACCESS_KEY);
    const envBucket = envValue(ENV_BUCKET);
    const envAutoSync = envValue(ENV_AUTO_SYNC);
    const accountId = envAccountId ?? (typeof state.accountId === "string" ? state.accountId : "");
    const accessKeyId =
      envAccessKeyId ?? (typeof state.accessKeyId === "string" ? state.accessKeyId : "");
    const secretAccessKey =
      envSecret ?? (typeof state.secretAccessKey === "string" ? state.secretAccessKey : "");
    const bucket = envBucket ?? (typeof state.bucket === "string" ? state.bucket : "");
    const autoSync =
      envAutoSync !== null
        ? AUTO_SYNC_TRUTHY.has(envAutoSync.toLowerCase())
        : state.autoSync === true;
    return {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket,
      autoSync,
      configured: Boolean(accountId && accessKeyId && secretAccessKey && bucket),
      configSource: {
        accountId: envAccountId !== null,
        accessKeyId: envAccessKeyId !== null,
        secretAccessKey: envSecret !== null,
        bucket: envBucket !== null,
      },
      lastSyncAt: typeof state.lastSyncAt === "number" ? state.lastSyncAt : null,
      lastSyncOk: typeof state.lastSyncOk === "boolean" ? state.lastSyncOk : null,
      lastSyncError: typeof state.lastSyncError === "string" ? state.lastSyncError : null,
    };
  }

  /** 当前生效配置（内部用，含明文密钥）。 */
  private resolvedConfig(): ReimburseSyncConfig {
    const settings = this.getSettings();
    return {
      accountId: settings.accountId,
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      bucket: settings.bucket,
      autoSync: settings.autoSync,
    };
  }

  /** 仅把最近一次同步状态写回状态文件（保留其余字段；失败不影响主流程）。 */
  private recordState(at: number, ok: boolean, error: string | null): void {
    try {
      const state = readStateFile(this.agentDir);
      writeJsonAtomic(configPath(this.agentDir), {
        ...state,
        lastSyncAt: at,
        lastSyncOk: ok,
        lastSyncError: error,
      });
    } catch (error) {
      warn("failed to record sync state", error);
    }
  }

  /** 对象键：固定前缀下的相对路径。 */
  private objectKey(relative: string): string {
    return `${OBJECT_KEY_PREFIX}/${relative}`;
  }

  /** 云端图片对象键（报销单图片与替票图片各占一段目录）。 */
  private imageObjectKey(kind: ImageOwnerKind, ownerId: number, fileName: string): string {
    return this.objectKey(`images/${kind}/${ownerId}/${fileName}`);
  }

  /** 读取上传指纹缓存（缺失/损坏/目标变更 → 空缓存）。 */
  private readUploadHashes(): Record<string, string> {
    try {
      const path = join(configPath(this.agentDir), "..", UPLOAD_HASHES_FILE);
      const raw = JSON.parse(readFileSync(path, "utf8")) as UploadHashesFile;
      const config = this.getSettings();
      if (raw?.version !== 1 || typeof raw.target !== "string") return {};
      if (raw.target !== `${config.accountId.trim()}/${config.bucket.trim()}`) return {};
      return typeof raw.hashes === "object" && raw.hashes !== null ? raw.hashes : {};
    } catch {
      return {};
    }
  }

  /** 原子写入上传指纹缓存（失败仅警告，不影响同步结果）。 */
  private writeUploadHashes(target: string, hashes: Record<string, string>): void {
    try {
      const path = join(configPath(this.agentDir), "..", UPLOAD_HASHES_FILE);
      mkdirSync(join(path, ".."), { recursive: true });
      const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(
        tempPath,
        JSON.stringify({ version: 1, target, hashes } satisfies UploadHashesFile),
        "utf8",
      );
      renameSync(tempPath, path);
    } catch (error) {
      warn("failed to persist upload hashes", error);
    }
  }

  /**
   * 测试连接（不落盘，不改动状态）。
   * 不传参时用当前生效配置；传入则测试给定配置（诊断用）。
   */
  async test(config?: ReimburseSyncConfig): Promise<{ ok: boolean; error: string | null }> {
    return testConnection(credentialsOf(config ?? this.resolvedConfig()));
  }

  private requireCreds(): { creds: R2Credentials; config: ReimburseSyncConfig } {
    const config = this.resolvedConfig();
    if (!config.accountId || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new Error(
        "尚未配置 R2 连接信息（在插件设置 → 报销管家的配置表单里填写 accountId / accessKeyId / secretAccessKey / bucket）",
      );
    }
    return { creds: credentialsOf(config), config };
  }

  /**
   * 立即同步：拉取 → 合并 → 清墓碑 → 回写本地 → 补图 → 上传。
   * 并发护栏下串行执行；结果写回 lastSync* 状态。
   */
  async syncNow(): Promise<ReimburseSyncStats> {
    if (this.syncing) throw new Error("已有一次同步在进行中");
    this.syncing = true;
    const at = Date.now();
    try {
      const { creds } = this.requireCreds();
      const store = this.store;

      // 1. 拉取云端全量记录。
      const cloudBody = await getObject(creds, this.objectKey("claims.json"));
      const cloud = parseCloudFile(cloudBody);

      // 2. 报销单与替票各自逐条 LWW 合并（含墓碑）。
      const claims = mergeById(store.listAll(), cloud.claims);
      const receipts = mergeById(store.listAllReceipts(), cloud.receipts);

      // 3. 清理过期墓碑：物理删除本地记录与图片，并删除云端图片对象。
      const cutoff = Date.now() - TOMBSTONE_TTL_MS;
      const expiredClaims = claims.items.filter((c) => c.deletedAt !== null && c.deletedAt <= cutoff);
      const expiredReceipts = receipts.items.filter((r) => r.deletedAt !== null && r.deletedAt <= cutoff);
      if (expiredClaims.length > 0) {
        const expiredIds = new Set(expiredClaims.map((c) => c.id));
        claims.items = claims.items.filter((c) => !expiredIds.has(c.id));
        for (const claim of expiredClaims) {
          store.hardRemove(claim.id);
          for (const image of [claim.invoiceImage, claim.transactionImage]) {
            if (!image) continue;
            await deleteObject(creds, this.imageObjectKey("claims", claim.id, image.fileName)).catch(
              (error: unknown) => warn("failed to delete cloud claim image", error),
            );
          }
        }
      }
      if (expiredReceipts.length > 0) {
        const expiredIds = new Set(expiredReceipts.map((r) => r.id));
        receipts.items = receipts.items.filter((r) => !expiredIds.has(r.id));
        for (const receipt of expiredReceipts) {
          store.hardRemoveReceipt(receipt.id);
          if (receipt.image) {
            await deleteObject(creds, this.imageObjectKey("receipts", receipt.id, receipt.image.fileName)).catch(
              (error: unknown) => warn("failed to delete cloud receipt image", error),
            );
          }
        }
      }

      // 4. 从云端补齐本地缺失的图片（云端 404 → 丢弃引用，避免悬空）。
      // （先补图后落盘：丢弃的引用才会随 replaceAll 一起落定，不会留悬空引用在磁盘上。）
      let downloadedImages = 0;
      const downloadedKeys = new Set<string>();

      // 5a. 报销单图片：invoiceImage 与 transactionImage 各自补齐。
      const liveClaims = claims.items.filter((c) => c.deletedAt === null);
      for (const claim of liveClaims) {
        for (const key of ["invoiceImage", "transactionImage"] as const) {
          const image = claim[key];
          if (!image) continue;
          if (store.hasImageFile("claims", claim.id, image.fileName)) continue;
          const imageKey = this.imageObjectKey("claims", claim.id, image.fileName);
          const body = await getObject(creds, imageKey);
          if (body) {
            store.writeImageFile("claims", claim.id, image.fileName, body);
            downloadedKeys.add(imageKey);
            downloadedImages += 1;
          } else {
            claim[key] = null;
          }
        }
      }

      // 5b. 替票图片。
      const liveReceipts = receipts.items.filter((r) => r.deletedAt === null);
      for (const receipt of liveReceipts) {
        const image = receipt.image;
        if (!image) continue;
        if (store.hasImageFile("receipts", receipt.id, image.fileName)) continue;
        const imageKey = this.imageObjectKey("receipts", receipt.id, image.fileName);
        const body = await getObject(creds, imageKey);
        if (body) {
          store.writeImageFile("receipts", receipt.id, image.fileName, body);
          downloadedKeys.add(imageKey);
          downloadedImages += 1;
        } else {
          receipt.image = null;
        }
      }

      // 5. 合并结果回写本地（含墓碑，供其他设备学习删除；含补图后的引用修正）。
      store.replaceAll(claims.items, receipts.items);

      // 6. 上传合并后的 claims.json + 本地存在的图片（内容未变化的跳过，见 uploadHashes）。
      // nextId 不上云：本地 readFile/replaceAll 已做 max 防御，云端记录集不含自增游标。
      const notesBody = Buffer.from(
        JSON.stringify(
          { schemaVersion: 2, claims: claims.items, receipts: receipts.items },
          null,
          2,
        ),
        "utf8",
      );
      const uploadHashes = this.readUploadHashes();
      const target = `${creds.accountId}/${creds.bucket}`;
      let uploadedImages = 0;
      let bytes = 0;
      if (cloudBody === null || !notesBody.equals(cloudBody)) {
        await putObject(creds, this.objectKey("claims.json"), notesBody);
        uploadHashes[this.objectKey("claims.json")] = createHash("sha256").update(notesBody).digest("hex");
        bytes = notesBody.byteLength;
      }

      // 指纹只保留当前合并结果引用到的图片对象，其余丢弃防膨胀。
      const referencedKeys = new Set<string>();
      for (const claim of liveClaims) {
        for (const key of ["invoiceImage", "transactionImage"] as const) {
          const image = claim[key];
          if (image) referencedKeys.add(this.imageObjectKey("claims", claim.id, image.fileName));
        }
      }
      for (const receipt of liveReceipts) {
        if (receipt.image) referencedKeys.add(this.imageObjectKey("receipts", receipt.id, receipt.image.fileName));
      }
      for (const key of Object.keys(uploadHashes)) {
        if (key !== this.objectKey("claims.json") && !referencedKeys.has(key)) {
          delete uploadHashes[key];
        }
      }

      // 上传图片：本地缺失且刚从云端补齐的记指纹即可，其余真实上传。
      for (const claim of liveClaims) {
        for (const key of ["invoiceImage", "transactionImage"] as const) {
          const image = claim[key];
          if (!image) continue;
          const imageKey = this.imageObjectKey("claims", claim.id, image.fileName);
          const body = store.readImageFile("claims", claim.id, image.fileName);
          if (!body) continue; // 引用悬空（前面补图失败已置 null，这里是墓碑记录的旧引用）
          const hash = createHash("sha256").update(body).digest("hex");
          if (uploadHashes[imageKey] === hash) continue;
          if (downloadedKeys.has(imageKey)) {
            uploadHashes[imageKey] = hash;
            continue;
          }
          await putObject(creds, imageKey, body);
          uploadHashes[imageKey] = hash;
          uploadedImages += 1;
          bytes += body.byteLength;
        }
      }
      for (const receipt of liveReceipts) {
        const image = receipt.image;
        if (!image) continue;
        const imageKey = this.imageObjectKey("receipts", receipt.id, image.fileName);
        const body = store.readImageFile("receipts", receipt.id, image.fileName);
        if (!body) continue;
        const hash = createHash("sha256").update(body).digest("hex");
        if (uploadHashes[imageKey] === hash) continue;
        if (downloadedKeys.has(imageKey)) {
          uploadHashes[imageKey] = hash;
          continue;
        }
        await putObject(creds, imageKey, body);
        uploadHashes[imageKey] = hash;
        uploadedImages += 1;
        bytes += body.byteLength;
      }
      this.writeUploadHashes(target, uploadHashes);

      const stats: ReimburseSyncStats = {
        uploadedClaims: liveClaims.length,
        uploadedReceipts: liveReceipts.length,
        uploadedImages,
        downloadedClaims: claims.adopted,
        downloadedReceipts: receipts.adopted,
        downloadedImages,
        bytes,
        at: Date.now(),
      };
      this.recordState(stats.at, true, null);
      return stats;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordState(at, false, message);
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  /** autoSync 开启时，防抖触发后台同步（吞错，状态写回 lastSync*）。 */
  scheduleAutoSync(): void {
    const config = this.getSettings();
    if (!config.autoSync) return;
    if (this.autoSyncTimer) clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      void this.syncNow().catch((error: unknown) => {
        warn("auto sync failed", error);
      });
    }, AUTO_SYNC_DEBOUNCE_MS);
    this.autoSyncTimer.unref?.();
  }

  /** 进程启动后的首次后台同步（autoSync 开启且已配置时；每次进程只做一次）。 */
  startupSync(): void {
    if (this.startupSyncDone) return;
    this.startupSyncDone = true;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      const config = this.getSettings();
      if (!config.autoSync || !config.accountId || !config.bucket) return;
      void this.syncNow().catch((error: unknown) => {
        warn("startup sync failed", error);
      });
    }, STARTUP_SYNC_DELAY_MS);
    this.startupTimer.unref?.();
  }
}

const syncCache = new Map<string, ReimburseSync>();

export function getReimburseSync(agentDir: string): ReimburseSync {
  let sync = syncCache.get(agentDir);
  if (!sync) {
    sync = new ReimburseSync(agentDir);
    syncCache.set(agentDir, sync);
  }
  return sync;
}

/** 报销数据变更后调用：autoSync 开启则防抖同步（best-effort，绝不抛出）。 */
export function scheduleReimburseAutoSync(agentDir: string): void {
  try {
    getReimburseSync(agentDir).scheduleAutoSync();
  } catch {
    /* best-effort */
  }
}
