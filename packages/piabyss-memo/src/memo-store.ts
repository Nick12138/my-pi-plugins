/**
 * 备忘录本地存储层（从 PiAbyss `packages/pi-host/src/memo-store.ts` 外移）。
 *
 * v1（纯本地）：数据落盘在 `<agentDir>/piabyss/memo/` 下：
 *   - `notes.json`  全量记录（单文件，原子写入）
 *
 * 磁盘格式权威是 PiAbyss 原实现（packages/pi-host/src/memo-store.ts）：
 * 桌面备忘录页面 / 协议 handler / 同步引擎与插件共用同一份 notes.json，
 * 任何字段写错都会让整个备忘录页面异常，因此读写逻辑逐行保持一致：
 *   - `schemaVersion: 1` + `notes` 数组；
 *   - 删除是软删除（墓碑 deletedAt）：记录体保留在磁盘上，供同步引擎把
 *     删除传播到其他设备；超过 TTL（30 天）的墓碑由同步引擎在合并时
 *     物理清除（含本地图片目录与云端对象）；
 *   - 写入走「临时文件 + rename」原子替换，进程中断不会留下半截 JSON；
 *   - 每次操作都从磁盘读、写回磁盘，不持有内存缓存。备忘录的数据量很小，
 *     多个消费者各自持有实例也不会互相覆盖，天然多实例安全。
 *
 * 与原实现的差异（不影响磁盘格式）：
 *   - 不依赖 @piabyss/protocol，类型在本文件内自定义（结构与原类型一致）；
 *   - 「新建」草稿（draft.json）由 Host 端 UI/协议层负责，插件只维护
 *     notes.json，故省略草稿相关方法；
 *   - 错误用本地的 MemoStoreError（code 与原 HostError 相同）。
 *
 * v2（云同步插件自持）：补齐同步引擎需要的图片文件方法
 * （hardRemove / readImageFile / hasImageFile / writeImageFile）。图片目录
 * `<agentDir>/piabyss/memo/images/<noteId>/<fileName>` 与 Host 端共用，
 * 读写逻辑与 Host 侧逐行一致。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** contentMd 长度上限。 */
const MAX_CONTENT_LENGTH = 200_000;
/** title 长度上限。 */
const MAX_TITLE_LENGTH = 300;
/** tag 单个长度上限 / 单条记录 tag 数量上限。 */
const MAX_TAG_LENGTH = 60;
const MAX_TAGS_PER_NOTE = 20;

export type MemoNoteType = "memo" | "idea" | "task";
export type MemoNoteStatus = "open" | "in_progress" | "done" | "archived";

/** 备忘录记录的图片引用（图片文件由 Host 存储；插件只保留字段形状）。 */
export type MemoImage = {
  id: string;
  /** 原始文件名（仅用于展示与扩展名推断）。 */
  fileName: string;
  mediaType: string;
  bytes: number;
};

/** Agent 处理备忘录后的结果总结（由 piabyss_memo 工具写入，覆盖式更新）。 */
export type MemoAgentResult = {
  /** 结果总结（Markdown）。 */
  resultMd: string;
  /** 提交总结时所在的会话（用于「继续讨论」跳转）。 */
  sessionId: string;
  /** 会话文件路径（跨工作区跳转用；可能为 null）。 */
  sessionPath: string | null;
  /** 提交时的会话标题（展示用）。 */
  sessionTitle: string | null;
  /** 提交时的工作区 cwd（跨工作区跳转用）。 */
  sessionCwd: string | null;
  /** 提交时间。 */
  at: number;
};

/** 备忘录记录（全局共享，不随工作区隔离；workspaceHint 仅作关联标签）。 */
export type MemoNote = {
  id: string;
  type: MemoNoteType;
  title: string;
  contentMd: string;
  status: MemoNoteStatus;
  tags: string[];
  /** 可空的工作区关联标签（目录名或路径），仅用于过滤与提示。 */
  workspaceHint: string | null;
  images: MemoImage[];
  createdAt: number;
  updatedAt: number;
  /** 最近一次执行所绑定的会话 ID；没有执行会话时为 null。可选以兼容旧版内存快照。 */
  sessionId?: string | null;
  /** 状态变为 done 的时间；非 done 恒为 null。 */
  completedAt: number | null;
  /** 最近一次 Agent 处理的结果总结；手动标记完成不产生总结。重新处理会覆盖旧总结。 */
  result: MemoAgentResult | null;
  /**
   * 删除墓碑（多设备同步用）：删除时置为时间戳并保留记录体，同步引擎据此
   * 把删除传播到其他设备（编辑时间晚于墓碑可复活）；超过 TTL 后物理清除。
   */
  deletedAt: number | null;
};

/** 持久化 JSON 的形状（带 schemaVersion，便于将来迁移）。 */
type MemoFile = {
  schemaVersion: 1;
  notes: MemoNote[];
};

export type MemoCreateInput = {
  type: MemoNoteType;
  title: string;
  contentMd: string;
  tags?: string[];
  workspaceHint?: string | null;
};

export type MemoUpdatePatch = {
  type?: MemoNoteType;
  title?: string;
  contentMd?: string;
  status?: MemoNoteStatus;
  sessionId?: string | null;
  tags?: string[];
  workspaceHint?: string | null;
  /** 清空 Agent 结果总结（进行中恢复后重跑时使用）。 */
  clearResult?: boolean;
};

/** piabyss_memo 工具 complete 时提交的结果总结及会话关联。 */
export type MemoCompleteResultInput = {
  resultMd: string;
  sessionId: string;
  sessionPath: string | null;
  sessionTitle: string | null;
  sessionCwd: string | null;
};

const NOTE_TYPES: readonly MemoNoteType[] = ["memo", "idea", "task"];
const NOTE_STATUSES: readonly MemoNoteStatus[] = ["open", "in_progress", "done", "archived"];

/** 与 PiAbyss HostError 对齐的存储错误（code 取值一致）。 */
export class MemoStoreError extends Error {
  readonly code: "INVALID_REQUEST" | "RESOURCE_NOT_FOUND";

  constructor(code: "INVALID_REQUEST" | "RESOURCE_NOT_FOUND", message: string) {
    super(message);
    this.name = "MemoStoreError";
    this.code = code;
  }
}

function memoError(code: "INVALID_REQUEST" | "RESOURCE_NOT_FOUND", message: string): MemoStoreError {
  return new MemoStoreError(code, message);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#/, "");
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_NOTE) break;
  }
  return result;
}

/** 备忘录存储。目录懒创建；全部方法同步（数据量小，磁盘读取可忽略）。 */
export class MemoStore {
  private readonly root: string;
  private readonly filePath: string;
  private readonly imagesRoot: string;

  constructor(agentDir: string) {
    this.root = join(agentDir, "piabyss", "memo");
    this.filePath = join(this.root, "notes.json");
    this.imagesRoot = join(this.root, "images");
  }

  /** 存储根目录（诊断/展示用）。 */
  get rootDir(): string {
    return this.root;
  }

  /** 可见记录（不含墓碑；UI、协议、agent 工具都用这个）。 */
  list(): MemoNote[] {
    return this.readFile().notes.filter((note) => note.deletedAt === null);
  }

  /** 全量原始记录（含墓碑；同步引擎专用）。 */
  listAll(): MemoNote[] {
    return this.readFile().notes;
  }

  get(id: string): MemoNote | null {
    return this.list().find((note) => note.id === id) ?? null;
  }

  create(input: MemoCreateInput): MemoNote {
    const title = this.requireTitle(input.title);
    const contentMd = this.requireContent(input.contentMd);
    const now = Date.now();
    const note: MemoNote = {
      id: randomUUID(),
      type: this.requireType(input.type),
      title,
      contentMd,
      status: "open",
      sessionId: null,
      tags: normalizeTags(input.tags),
      workspaceHint: this.normalizeHint(input.workspaceHint),
      images: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
      deletedAt: null,
    };
    const file = this.readFile();
    file.notes.unshift(note);
    this.writeFile(file);
    return note;
  }

  update(id: string, patch: MemoUpdatePatch): MemoNote {
    const file = this.readFile();
    const note = file.notes.find((entry) => entry.id === id);
    if (!note) throw memoError("RESOURCE_NOT_FOUND", `备忘录记录不存在：${id}`);

    if (patch.type !== undefined) note.type = this.requireType(patch.type);
    if (patch.title !== undefined) note.title = this.requireTitle(patch.title);
    if (patch.contentMd !== undefined) note.contentMd = this.requireContent(patch.contentMd);
    if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags);
    if (patch.workspaceHint !== undefined) {
      note.workspaceHint = this.normalizeHint(patch.workspaceHint);
    }
    if (patch.status !== undefined) {
      const status = this.requireStatus(patch.status);
      note.status = status;
      note.completedAt = status === "done" ? (note.completedAt ?? Date.now()) : null;
    }
    if (patch.sessionId !== undefined) {
      note.sessionId = this.normalizeSessionId(patch.sessionId);
    }
    if (patch.clearResult) note.result = null;
    note.updatedAt = Date.now();
    this.writeFile(file);
    return note;
  }

  /**
   * Agent 处理完成：标记 done 并写入/覆盖结果总结（含会话关联）。
   * 与手动标记完成（update status）不同，只有本方法会产生总结。
   */
  completeWithResult(id: string, input: MemoCompleteResultInput): MemoNote {
    const file = this.readFile();
    const note = file.notes.find((entry) => entry.id === id);
    if (!note) throw memoError("RESOURCE_NOT_FOUND", `备忘录记录不存在：${id}`);
    const resultMd = input.resultMd.trim();
    if (!resultMd) throw memoError("INVALID_REQUEST", "结果总结不能为空");
    if (resultMd.length > MAX_CONTENT_LENGTH) {
      throw memoError("INVALID_REQUEST", `结果总结过长（上限 ${MAX_CONTENT_LENGTH} 字符）`);
    }
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw memoError("INVALID_REQUEST", "缺少提交总结的会话信息");
    const now = Date.now();
    note.status = "done";
    note.sessionId = sessionId;
    note.completedAt = note.completedAt ?? now;
    note.result = {
      resultMd,
      sessionId,
      sessionPath: input.sessionPath?.trim() || null,
      sessionTitle: input.sessionTitle?.trim() || null,
      sessionCwd: input.sessionCwd?.trim() || null,
      at: now,
    };
    note.updatedAt = now;
    this.writeFile(file);
    return note;
  }

  /** 删除 = 打墓碑（记录体保留，供同步传播删除；见 purgeDeleted）。 */
  remove(id: string): MemoNote {
    const file = this.readFile();
    const note = file.notes.find((entry) => entry.id === id);
    if (!note) throw memoError("RESOURCE_NOT_FOUND", `备忘录记录不存在：${id}`);
    const now = Date.now();
    note.deletedAt = now;
    note.updatedAt = now;
    this.writeFile(file);
    return note;
  }

  /** 物理删除：移除记录体与图片目录（墓碑过期清理 / 同步引擎使用）。 */
  hardRemove(id: string): void {
    const file = this.readFile();
    const index = file.notes.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const note = file.notes[index];
    if (note) rmSync(join(this.imagesRoot, note.id), { recursive: true, force: true });
    file.notes.splice(index, 1);
    this.writeFile(file);
  }

  /**
   * 清理超过 TTL 的墓碑：物理删除记录体与图片目录。
   * 返回被清理的记录（含图片名列表），供同步引擎删除云端对应对象。
   */
  purgeDeleted(cutoff: number): MemoNote[] {
    const file = this.readFile();
    const expired = file.notes.filter(
      (note) => note.deletedAt !== null && note.deletedAt <= cutoff,
    );
    for (const note of expired) {
      rmSync(join(this.imagesRoot, note.id), { recursive: true, force: true });
    }
    if (expired.length > 0) {
      const expiredIds = new Set(expired.map((note) => note.id));
      file.notes = file.notes.filter((note) => !expiredIds.has(note.id));
      this.writeFile(file);
    }
    return expired;
  }

  /** 用给定记录集整体替换 notes.json（同步引擎合并结果落盘用；图片文件不动）。 */
  replaceAll(notes: MemoNote[]): void {
    this.writeFile({ schemaVersion: 1, notes });
  }

  /** 任意记录（含墓碑）按 id 查找（同步引擎图片校验用）。 */
  getAny(id: string): MemoNote | null {
    return this.listAll().find((note) => note.id === id) ?? null;
  }

  /** 读取图片文件原始字节（云同步用；文件缺失抛 RESOURCE_NOT_FOUND）。 */
  readImageFile(noteId: string, fileName: string): Buffer {
    if (!this.getAny(noteId)?.images.some((entry) => entry.fileName === fileName)) {
      throw memoError("RESOURCE_NOT_FOUND", `备忘录图片不存在：${fileName}`);
    }
    const path = join(this.imagesRoot, noteId, fileName);
    try {
      return readFileSync(path);
    } catch {
      throw memoError("RESOURCE_NOT_FOUND", `备忘录图片文件缺失：${fileName}`);
    }
  }

  /** 图片文件是否已存在于本地（同步补图判断用）。 */
  hasImageFile(noteId: string, fileName: string): boolean {
    return existsSync(join(this.imagesRoot, noteId, fileName));
  }

  /** 写入图片文件（同步下载补图用；调用方保证 noteId 与 fileName 已在记录中）。 */
  writeImageFile(noteId: string, fileName: string, body: Buffer): void {
    const dir = join(this.imagesRoot, noteId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), body);
  }

  private readFile(): MemoFile {
    if (!existsSync(this.filePath)) return { schemaVersion: 1, notes: [] };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as MemoFile;
      if (raw && raw.schemaVersion === 1 && Array.isArray(raw.notes)) {
        // 旧数据兼容：result / deletedAt / sessionId 缺失时补齐为 null（下次写盘时落定）。
        for (const note of raw.notes) {
          if (note.result === undefined) note.result = null;
          if (note.deletedAt === undefined) note.deletedAt = null;
          if (note.sessionId === undefined) note.sessionId = null;
        }
        return raw;
      }
    } catch {
      // 损坏的 JSON 视为空库（备份损坏原文件，便于事后排查）。
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
    }
    return { schemaVersion: 1, notes: [] };
  }

  private writeFile(file: MemoFile): void {
    mkdirSync(this.root, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(file, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }

  private requireType(value: MemoNoteType): MemoNoteType {
    if (!NOTE_TYPES.includes(value)) {
      throw memoError("INVALID_REQUEST", `无效的记录类型：${String(value)}`);
    }
    return value;
  }

  private requireStatus(value: MemoNoteStatus): MemoNoteStatus {
    if (!NOTE_STATUSES.includes(value)) {
      throw memoError("INVALID_REQUEST", `无效的记录状态：${String(value)}`);
    }
    return value;
  }

  private requireTitle(value: string): string {
    const title = value.trim();
    if (!title) throw memoError("INVALID_REQUEST", "标题不能为空");
    if (title.length > MAX_TITLE_LENGTH) {
      throw memoError("INVALID_REQUEST", `标题过长（上限 ${MAX_TITLE_LENGTH} 字符）`);
    }
    return title;
  }

  private requireContent(value: string): string {
    if (value.length > MAX_CONTENT_LENGTH) {
      throw memoError("INVALID_REQUEST", `正文过长（上限 ${MAX_CONTENT_LENGTH} 字符）`);
    }
    return value;
  }

  private normalizeHint(value: string | null | undefined): string | null {
    const hint = value?.trim();
    return hint ? hint.slice(0, 300) : null;
  }

  private normalizeSessionId(value: string | null | undefined): string | null {
    const sessionId = value?.trim();
    return sessionId ? sessionId.slice(0, 200) : null;
  }
}

/**
 * 模块级单例：agent 工具共享同一实例（键为 agentDir）。
 * 存储本身是磁盘权威（无内存缓存），多实例也安全，这里只是为了省掉重复构造。
 */
const memoStoreCache = new Map<string, MemoStore>();

export function getMemoStore(agentDir: string): MemoStore {
  let store = memoStoreCache.get(agentDir);
  if (!store) {
    store = new MemoStore(agentDir);
    memoStoreCache.set(agentDir, store);
  }
  return store;
}
