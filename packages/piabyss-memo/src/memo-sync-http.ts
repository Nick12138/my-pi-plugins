/**
 * 备忘录云同步的本地 HTTP 控制面（127.0.0.1）。
 *
 * 为什么用 HTTP：PiAbyss 桌面端（备忘录页的「测试连接 / 立即同步」）需要即时
 * 触发插件内的同步引擎，而协议层（memo.* RPC）由 Host 代理到这里 —— 与
 * pi-schedule 的既有模式一致（Host 的 schedule-api.ts ↔ 插件的 http.ts）。
 * 数据面仍然是文件：notes.json / 图片目录由引擎直接读写，控制面只做
 * 触发与状态查询。
 *
 * 端点（除 health 外都要求鉴权头 `X-Piabyss-Memo-Sync-Token`）：
 *   GET  /api/health     存活探测（未鉴权；端口关闭 = 插件未加载）
 *   GET  /api/status      同步状态（configured/autoSync/lastSync*，不含密钥）
 *   POST /api/test       用当前配置做一次 R2 连接测试（不落盘）
 *   POST /api/sync       立即双向同步，返回统计
 *   POST /api/auto-sync  提示引擎「数据有变更」：autoSync 开启时防抖同步
 *
 * 鉴权必要性：仅监听 127.0.0.1 不是安全边界——任意网页都能发起跨源请求
 * （简单请求免预检）。token 存在 `<agentDir>/piabyss/memo/sync-token`
 * （0600），或用环境变量 PIABYSS_MEMO_SYNC_TOKEN 覆盖；Host 侧读同一文件
 * 带上鉴权头即可。不发送 CORS 许可，浏览器跨源读不到响应。
 */
import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoSync, type MemoSyncStats, type MemoSyncSettings } from "./memo-sync.js";

export const DEFAULT_HTTP_PORT = 18768;
export const PORT_ENV = "PIABYSS_MEMO_SYNC_PORT";
export const TOKEN_ENV = "PIABYSS_MEMO_SYNC_TOKEN";
const TOKEN_FILE_NAME = "sync-token";
const MAX_BODY_BYTES = 64 * 1024;

/** 运行时单例挂 globalThis：pi 用 jiti(moduleCache:false) 加载扩展，模块级
 * 变量会随模块实例分裂（见 pi-schedule 的同类注释）。 */
const SERVER_KEY = Symbol.for("piabyss-memo-sync.http");

interface HttpRuntime {
  server: http.Server | null;
  port: number;
  agentDir: string;
}

function runtimeStore(): Record<symbol, HttpRuntime | undefined> {
  return globalThis as unknown as Record<symbol, HttpRuntime | undefined>;
}

function tokenFilePath(agentDir: string): string {
  return join(agentDir, "piabyss", "memo", TOKEN_FILE_NAME);
}

/** 读取（缺失则生成并落盘）控制面 token。 */
export function resolveToken(agentDir: string): string {
  const fromEnv = process.env[TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const file = tokenFilePath(agentDir);
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    /* 读失败则重新生成 */
  }
  const token = randomBytes(24).toString("hex");
  try {
    writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* 写不了就只在内存里生效 */
  }
  return token;
}

export function resolvePort(): number {
  const raw = process.env[PORT_ENV]?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65_536) return parsed;
  }
  return DEFAULT_HTTP_PORT;
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.split(":")[0]?.toLowerCase() ?? "";
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers["x-piabyss-memo-sync-token"];
  const fromHeader = (Array.isArray(header) ? header[0] : header) ?? "";
  if (fromHeader && safeEqual(fromHeader, token)) return true;
  // `?token=` 仅对只读 GET 有效：写操作走 query 会被当成「简单请求」绕过
  // CORS 预检，属于 CSRF 面。
  const isReadOnly = req.method === "GET" || req.method === "HEAD";
  if (!isReadOnly) return false;
  const fromQuery = url.searchParams.get("token") ?? "";
  return fromQuery.length > 0 && safeEqual(fromQuery, token);
}

async function readBody(req: http.IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体过大（>${MAX_BODY_BYTES} 字节）`));
        req.destroy();
      }
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
}

/** 同步状态（不含密钥）：桌面端状态点 / agent 工具共用这个形状。 */
export type MemoSyncStatusPayload = {
  configured: boolean;
  accountId: string;
  bucket: string;
  autoSync: boolean;
  /** 密钥已配置（只报有/无，不回传明文）。 */
  hasSecrets: boolean;
  lastSyncAt: number | null;
  lastSyncOk: boolean | null;
  lastSyncError: string | null;
};

export function toStatusPayload(settings: MemoSyncSettings): MemoSyncStatusPayload {
  return {
    configured: settings.configured,
    accountId: settings.accountId,
    bucket: settings.bucket,
    autoSync: settings.autoSync,
    hasSecrets: settings.accessKeyId !== "" && settings.secretAccessKey !== "",
    lastSyncAt: settings.lastSyncAt,
    lastSyncOk: settings.lastSyncOk,
    lastSyncError: settings.lastSyncError,
  };
}

function errorResponse(res: http.ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/尚未配置/.test(message)) {
    json(res, 409, { error: message });
    return;
  }
  if (/已有一次同步在进行中/.test(message)) {
    json(res, 409, { error: message });
    return;
  }
  json(res, 500, { error: message });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: HttpRuntime,
): Promise<void> {
  // 防 DNS rebinding：只接受回环 Host。
  if (!isLoopbackHost(req.headers.host)) {
    json(res, 403, { error: "仅允许回环地址访问" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") {
    json(res, 404, { error: "未知路径" });
    return;
  }
  const seg = parts.slice(1);

  // 预检不发 CORS 许可：跨源请求会被浏览器拦下（Host 是本地客户端，不需要 CORS）。
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const sync = getMemoSync(runtime.agentDir);
  const token = resolveToken(runtime.agentDir);

  // GET /api/health —— 存活探测（未鉴权）。
  if (req.method === "GET" && seg[0] === "health" && seg.length === 1) {
    json(res, 200, { ok: true, agentDir: runtime.agentDir, port: runtime.port });
    return;
  }

  if (!authorized(req, url, token)) {
    json(res, 401, {
      error: "缺少或错误的 token",
      hint: `读取 ${tokenFilePath(runtime.agentDir)}，并通过 X-Piabyss-Memo-Sync-Token 头传入`,
    });
    return;
  }

  // GET /api/status —— 同步状态（不含密钥）。
  if (req.method === "GET" && seg[0] === "status" && seg.length === 1) {
    json(res, 200, toStatusPayload(sync.getSettings()));
    return;
  }

  // POST /api/test —— 连接测试（用当前生效配置，不落盘）。
  if (req.method === "POST" && seg[0] === "test" && seg.length === 1) {
    await readBody(req);
    const result = await sync.test();
    json(res, 200, result);
    return;
  }

  // POST /api/sync —— 立即双向同步，返回统计。
  if (req.method === "POST" && seg[0] === "sync" && seg.length === 1) {
    await readBody(req);
    const stats: MemoSyncStats = await sync.syncNow();
    json(res, 200, stats);
    return;
  }

  // POST /api/auto-sync —— 「数据有变更」提示：autoSync 开启时防抖同步。
  if (req.method === "POST" && seg[0] === "auto-sync" && seg.length === 1) {
    await readBody(req);
    sync.scheduleAutoSync();
    json(res, 200, { scheduled: true });
    return;
  }

  json(res, 404, { error: `未知接口：${req.method} /${parts.join("/")}` });
}

/**
 * 启动 HTTP 服务（进程级单例，幂等；挂 globalThis 防模块实例分裂）。
 * 返回实际监听端口；监听失败会 reject。
 */
export function startSyncHttpServer(agentDir: string, port = resolvePort()): Promise<number> {
  const store = runtimeStore();
  const existing = store[SERVER_KEY];
  if (existing?.server) return Promise.resolve(existing.port);

  return new Promise<number>((resolve, reject) => {
    const runtime: HttpRuntime = { server: null, port, agentDir };
    const instance = http.createServer((req, res) => {
      void handle(req, res, runtime).catch((error: unknown) => errorResponse(res, error));
    });
    instance.once("error", (error: Error) => {
      if (store[SERVER_KEY]?.server === instance) store[SERVER_KEY] = undefined;
      reject(error);
    });
    instance.once("listening", () => {
      const address = instance.address();
      runtime.port =
        address && typeof address === "object" ? address.port : port;
      runtime.server = instance;
      store[SERVER_KEY] = runtime;
      resolve(runtime.port);
    });
    instance.listen(port, "127.0.0.1");
  });
}

export function stopSyncHttpServer(): void {
  const store = runtimeStore();
  const runtime = store[SERVER_KEY];
  if (!runtime?.server) return;
  try {
    runtime.server.close();
  } catch {
    /* 忽略 */
  }
  store[SERVER_KEY] = undefined;
}

/** 当前控制面监听端口（未启动为 null；诊断用）。 */
export function syncHttpServerPort(): number | null {
  return runtimeStore()[SERVER_KEY]?.port ?? null;
}
