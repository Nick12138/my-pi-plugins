/**
 * 备忘录同步控制面单测：鉴权、防 DNS rebinding、状态/测试/同步/防抖通知端点。
 * R2 交互用 mock fetch（引擎单测已覆盖同步语义，这里只验证 HTTP 面）。
 *
 * 注意：用例会临时替换全局 fetch（mock 掉引擎的 R2 请求），因此控制面
 * 请求必须走模块加载时捕获的 realFetch。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ENV_ACCOUNT_ID,
  ENV_ACCESS_KEY_ID,
  ENV_AUTO_SYNC,
  ENV_BUCKET,
  ENV_SECRET_ACCESS_KEY,
} from "../src/memo-sync.js";
import {
  startSyncHttpServer,
  stopSyncHttpServer,
  TOKEN_ENV,
} from "../src/memo-sync-http.js";

const TOKEN = "memo-sync-test-token";
process.env[TOKEN_ENV] = TOKEN;

const realFetch = globalThis.fetch.bind(globalThis);

const tempDirs: string[] = [];
let base = "";
let agentDir = "";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "piabyss-memo-http-"));
  tempDirs.push(root);
  agentDir = join(root, "agent");
  const port = await startSyncHttpServer(agentDir, 0);
  base = `http://127.0.0.1:${port}/api`;
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
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
});

afterAll(async () => {
  stopSyncHttpServer();
  delete process.env[TOKEN_ENV];
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function call(
  method: string,
  path: string,
  options: { token?: string | false } = {},
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const headers: Record<string, string> = {};
  if (options.token !== false) headers["X-Piabyss-Memo-Sync-Token"] = options.token ?? TOKEN;
  const res = await realFetch(`${base}${path}`, { method, headers });
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

/** 记录 R2 请求的 mock fetch（桶 memos；PUT 收集、GET 命中或 404）。 */
function mockR2() {
  const objects = new Map<string, Buffer>();
  const fetchImpl = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = input as URL;
    // 连接测试走 ListObjectsV2（无对象键）：返回空列表 = 连通。
    if (url.searchParams.get("list-type") === "2") {
      return new Response(
        '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
        { status: 200 },
      );
    }
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

function setEnvConfig(autoSync = false): void {
  process.env[ENV_ACCOUNT_ID] = "abc123";
  process.env[ENV_ACCESS_KEY_ID] = "AKID";
  process.env[ENV_SECRET_ACCESS_KEY] = "secret";
  process.env[ENV_BUCKET] = "memos";
  process.env[ENV_AUTO_SYNC] = autoSync ? "true" : "false";
}

describe("memo-sync HTTP 控制面", () => {
  it("health 免 token；其他接口无/错 token 401", async () => {
    const health = await call("GET", "/health", { token: false });
    expect(health.status).toBe(200);
    expect(health.data?.ok).toBe(true);

    const noToken = await call("GET", "/status", { token: false });
    expect(noToken.status).toBe(401);

    const wrongToken = await call("GET", "/status", { token: "wrong" });
    expect(wrongToken.status).toBe(401);
  });

  it("非回环 Host 一律 403（防 DNS rebinding）", async () => {
    const { request } = await import("node:http");
    const port = new URL(base).port;
    const status = await new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/status",
          method: "GET",
          headers: { Host: "evil.example.com", "X-Piabyss-Memo-Sync-Token": TOKEN },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("status 返回不含密钥的状态载荷", async () => {
    setEnvConfig();
    const outcome = await call("GET", "/status");
    expect(outcome.status).toBe(200);
    expect(outcome.data).toMatchObject({
      configured: true,
      accountId: "abc123",
      bucket: "memos",
      autoSync: false,
      hasSecrets: true,
      lastSyncAt: null,
      lastSyncOk: null,
      lastSyncError: null,
    });
    // 不回传任何密钥明文。
    expect(JSON.stringify(outcome.data)).not.toContain("secret");
    expect(JSON.stringify(outcome.data)).not.toContain("AKID");
  });

  it("sync 未配置时返回 409 与可读错误", async () => {
    const outcome = await call("POST", "/sync");
    expect(outcome.status).toBe(409);
    expect(String(outcome.data?.error)).toContain("尚未配置");
  });

  it("test 与 sync 走插件内的同步引擎", async () => {
    setEnvConfig();
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);

    const test = await call("POST", "/test");
    expect(test.status).toBe(200);
    expect(test.data).toMatchObject({ ok: true, error: null });

    const sync = await call("POST", "/sync");
    expect(sync.status).toBe(200);
    expect(sync.data).toMatchObject({
      uploadedNotes: 0,
      uploadedImages: 0,
      downloadedNotes: 0,
      downloadedImages: 0,
    });
    expect(sync.data?.at).toBeTypeOf("number");
    expect(Number(sync.data?.bytes)).toBeGreaterThan(0); // 空库也会 PUT 一份 notes.json
    expect(fetchImpl).toHaveBeenCalled();

    // 同步状态已被引擎写回，status 能看到。
    const status = await call("GET", "/status");
    expect(status.data?.lastSyncOk).toBe(true);
    expect(status.data?.lastSyncAt).not.toBeNull();
  });

  it("auto-sync 通知端点：未配置时静默 200，开启时防抖触发同步", async () => {
    // 未配置：不抛错。
    const idle = await call("POST", "/auto-sync");
    expect(idle.status).toBe(200);
    expect(idle.data).toMatchObject({ scheduled: true });

    // 配置 + 开启：通知后防抖窗口到期时真的同步。
    // （先开 fake timers 再发通知，保证防抖 setTimeout 可被 advance 推进。）
    vi.useFakeTimers();
    setEnvConfig(true);
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    const poke = await call("POST", "/auto-sync");
    expect(poke.status).toBe(200);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // GET 云端 notes.json + PUT 合并结果
  });

  it("未知路径 404；响应不带 CORS 放行头", async () => {
    const missing = await call("GET", "/nope");
    expect(missing.status).toBe(404);

    const res = await realFetch(`${base}/status`, {
      headers: { "X-Piabyss-Memo-Sync-Token": TOKEN },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("startSyncHttpServer 幂等（重复启动返回同一端口）", async () => {
    const again = await startSyncHttpServer(agentDir, 0);
    expect(again).toBe(Number(new URL(base).port));
  });
});
