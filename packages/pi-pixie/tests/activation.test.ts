/**
 * pixie_report/pixie_ask 激活门控、cwd 角色判定与扩展入口的 vitest 用例。
 *
 * 覆盖：
 * - GET /api/pixie/dispatch-state 的 armed true/false 映射（node:http mock 环回）；
 * - 请求携带 sessionId 查询参数；
 * - 端口缺失 / 请求失败 / 超时 → 安全返回未 armed，绝不抛错；
 * - before_agent_start 门控：小精灵会话（env/cwd）→ dispatch/rest 激活；
 *   普通会话 → report/ask 仅在 armed 时激活；
 * - 扩展入口注册全部工具（可见性交给 active-tools 门控）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createPixieReportActivationExtension,
  isPixieWorkspaceCwd,
  queryPixieDispatchArmed,
  resolvePixieWorkspacePath,
  sessionIdFromCtx,
} from "../src/activation.js";
import {
  PIXIE_ASK_NAME,
  PIXIE_DISPATCH_NAME,
  PIXIE_INTERJECT_NAME,
  PIXIE_RECALL_NAME,
  PIXIE_REPORT_NAME,
  PIXIE_REST_NAME,
  PIXIE_RETRY_NAME,
  PIXIE_SESSIONS_NAME,
  PIXIE_STATUS_NAME,
  PIXIE_STOP_NAME,
} from "../src/pixie-tools.js";
import {
  PIXIE_PORT_ENV,
  PIXIE_RESIDENT_ENV,
  PIXIE_TOKEN_ENV,
  readPixiePort,
  readPixieToken,
} from "../src/http-client.js";
import buildPixieExtension from "../extensions/pi-pixie.js";

// ── mock 环回服务 ──────────────────────────────────────────────

async function startMockServer(
  responder: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; port: number; requests: { method: string; url: string }[] }> {
  const requests: { method: string; url: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "" });
    responder(req, res, "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server failed to listen");
  return { server, port: address.port, requests };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ── ExtensionAPI mock ─────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function createMockPi(initialActive: string[] = []): {
  pi: never;
  registered: { name: string }[];
  active: string[];
  emitBeforeAgentStart: (ctx?: unknown) => Promise<void>;
  hasHandler: (event: string) => boolean;
} {
  const handlers = new Map<string, Handler[]>();
  const registered: { name: string }[] = [];
  const state = { active: [...initialActive] };
  const pi = {
    registerTool(tool: { name: string }): void {
      registered.push(tool);
    },
    on(event: string, handler: Handler): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools(): string[] {
      return [...state.active];
    },
    setActiveTools(toolNames: string[]): void {
      state.active = [...toolNames];
    },
  };
  return {
    pi: pi as never,
    registered,
    get active(): string[] {
      return state.active;
    },
    hasHandler: (event: string) => (handlers.get(event) ?? []).length > 0,
    async emitBeforeAgentStart(ctx?: unknown): Promise<void> {
      for (const handler of handlers.get("before_agent_start") ?? []) {
        await handler({ type: "before_agent_start" }, ctx);
      }
    },
  };
}

const ctxWithSession = (sessionId: string, cwd?: string): unknown => ({
  sessionManager: { getSessionId: () => sessionId },
  ...(cwd !== undefined ? { cwd } : {}),
});

const envSnapshot = (): Record<string, string | undefined> => ({
  [PIXIE_PORT_ENV]: process.env[PIXIE_PORT_ENV],
  [PIXIE_RESIDENT_ENV]: process.env[PIXIE_RESIDENT_ENV],
  [PIXIE_TOKEN_ENV]: process.env[PIXIE_TOKEN_ENV],
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PIABYSS_PIXIE_WORKSPACE: process.env.PIABYSS_PIXIE_WORKSPACE,
});

const restoreEnv = (snapshot: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const savedEnv = envSnapshot();

afterEach(() => {
  restoreEnv(savedEnv);
});

afterAll(async () => {
  // 各用例自行关闭服务；这里无共享资源。
});

describe("queryPixieDispatchArmed (GET /api/pixie/dispatch-state)", () => {
  it("returns true when the host reports armed:true, carrying sessionId as a query param", async () => {
    const { server, port, requests } = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed: true }));
    });
    try {
      await expect(queryPixieDispatchArmed({ port, sessionId: "sess-armed-1" })).resolves.toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "GET", url: "/api/pixie/dispatch-state?sessionId=sess-armed-1" });
    } finally {
      await closeServer(server);
    }
  });

  it("returns false when the host reports armed:false", async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed: false }));
    });
    try {
      await expect(queryPixieDispatchArmed({ port, sessionId: "sess-idle" })).resolves.toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("encodes the sessionId in the query string", async () => {
    const { server, port, requests } = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed: true }));
    });
    try {
      await expect(queryPixieDispatchArmed({ port, sessionId: "sess/with spaces&chars" })).resolves.toBe(true);
      expect(requests[0]?.url).toBe(
        `/api/pixie/dispatch-state?sessionId=${encodeURIComponent("sess/with spaces&chars")}`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("treats non-200 responses as not armed", async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    try {
      await expect(queryPixieDispatchArmed({ port, sessionId: "sess-1" })).resolves.toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("fails safe (not armed) when the port is missing or the sessionId is absent", async () => {
    await expect(queryPixieDispatchArmed({ port: null, sessionId: "sess-1" })).resolves.toBe(false);
    await expect(queryPixieDispatchArmed({ port: 1, sessionId: null })).resolves.toBe(false);
  });

  it("fails safe (not armed) when nothing is listening on the port", async () => {
    // 起一个服务再立即关掉，保证拿到一个确定没有监听者的端口。
    const { server, port } = await startMockServer(() => undefined);
    await closeServer(server);
    await expect(queryPixieDispatchArmed({ port, sessionId: "sess-1" })).resolves.toBe(false);
  });

  it("fails safe (not armed) on a hanging server (timeout)", async () => {
    const { server, port } = await startMockServer(() => {
      /* 挂起不响应，触发 3 秒超时 */
    });
    try {
      await expect(queryPixieDispatchArmed({ port, sessionId: "sess-1" })).resolves.toBe(false);
    } finally {
      await closeServer(server);
    }
  }, 10_000);
});

describe("before_agent_start activation gating", () => {
  it("adds pixie_report to active tools only while armed", async () => {
    let armed = false;
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed }));
    });
    try {
      const mock = createMockPi([PIXIE_REPORT_NAME]);
      const extension = createPixieReportActivationExtension({ getPort: () => port });
      extension(mock.pi);

      // 未 armed：保持剪除。
      await mock.emitBeforeAgentStart(ctxWithSession("sess-1"));
      expect(mock.active).not.toContain(PIXIE_REPORT_NAME);

      // armed：进入 active tools。
      armed = true;
      await mock.emitBeforeAgentStart(ctxWithSession("sess-1"));
      expect(mock.active).toContain(PIXIE_REPORT_NAME);

      // 再次未 armed：重新剪除。
      armed = false;
      await mock.emitBeforeAgentStart(ctxWithSession("sess-1"));
      expect(mock.active).not.toContain(PIXIE_REPORT_NAME);
      expect(mock.active).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("does not duplicate pixie_report/pixie_ask when they are already active", async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed: true }));
    });
    try {
      const mock = createMockPi(["read", PIXIE_REPORT_NAME, PIXIE_ASK_NAME]);
      createPixieReportActivationExtension({ getPort: () => port })(mock.pi);
      await mock.emitBeforeAgentStart(ctxWithSession("sess-1"));
      expect(mock.active.filter((name) => name === PIXIE_REPORT_NAME)).toHaveLength(1);
      expect(mock.active).toEqual(["read", PIXIE_REPORT_NAME, PIXIE_ASK_NAME]);
    } finally {
      await closeServer(server);
    }
  });

  it("never throws and keeps active tools untouched when the gate query fails", async () => {
    const { server, port } = await startMockServer(() => {
      /* 挂起 → 超时 */
    });
    try {
      const mock = createMockPi(["read", "bash"]);
      createPixieReportActivationExtension({ getPort: () => port })(mock.pi);
      await expect(mock.emitBeforeAgentStart(ctxWithSession("sess-1"))).resolves.toBeUndefined();
      expect(mock.active).toEqual(["read", "bash"]);
    } finally {
      await closeServer(server);
    }
  }, 10_000);

  it("skips the gate entirely when the port is not configured", async () => {
    const mock = createMockPi(["read"]);
    createPixieReportActivationExtension({ getPort: () => null })(mock.pi);
    await expect(mock.emitBeforeAgentStart(ctxWithSession("sess-1"))).resolves.toBeUndefined();
    expect(mock.active).toEqual(["read"]);
  });

  it("treats a missing sessionId as not armed", async () => {
    let requested = false;
    const { server, port } = await startMockServer((_req, res) => {
      requested = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed: true }));
    });
    try {
      const mock = createMockPi(["read"]);
      createPixieReportActivationExtension({ getPort: () => port })(mock.pi);
      await mock.emitBeforeAgentStart(ctxWithSession(undefined as unknown as string));
      expect(mock.active).toEqual(["read"]);
      expect(requested).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

describe("sessionIdFromCtx", () => {
  it("reads the session id from ctx.sessionManager.getSessionId()", () => {
    expect(sessionIdFromCtx(ctxWithSession("sess-42") as never)).toBe("sess-42");
  });

  it("returns null (never throws) for unusable contexts", () => {
    expect(sessionIdFromCtx(undefined)).toBeNull();
    expect(sessionIdFromCtx({} as never)).toBeNull();
    expect(
      sessionIdFromCtx({
        sessionManager: {
          getSessionId: () => {
            throw new Error("no session");
          },
        },
      } as never),
    ).toBeNull();
  });
});

describe("extension entry (extensions/pi-pixie.ts)", () => {
  it("registers all eight tools; visibility is gated per turn, not per registration", () => {
    delete process.env[PIXIE_RESIDENT_ENV];
    const mock = createMockPi();
    buildPixieExtension(mock.pi);
    expect(mock.registered.map((tool) => tool.name)).toEqual([
      PIXIE_DISPATCH_NAME,
      PIXIE_REPORT_NAME,
      PIXIE_ASK_NAME,
      PIXIE_REST_NAME,
      PIXIE_RECALL_NAME,
      PIXIE_STATUS_NAME,
      PIXIE_SESSIONS_NAME,
      PIXIE_INTERJECT_NAME,
      PIXIE_STOP_NAME,
      PIXIE_RETRY_NAME,
    ]);
    expect(mock.hasHandler("before_agent_start")).toBe(true);
  });

  it("activates the resident console on the resident session (legacy env marker)", async () => {
    process.env[PIXIE_RESIDENT_ENV] = "1";
    const mock = createMockPi([PIXIE_REPORT_NAME]);
    buildPixieExtension(mock.pi);
    await mock.emitBeforeAgentStart(ctxWithSession("pixie-resident"));
    expect(mock.active).toEqual([
      PIXIE_DISPATCH_NAME,
      PIXIE_REST_NAME,
      PIXIE_RECALL_NAME,
      PIXIE_STATUS_NAME,
      PIXIE_SESSIONS_NAME,
      PIXIE_INTERJECT_NAME,
      PIXIE_STOP_NAME,
      PIXIE_RETRY_NAME,
    ]);
    await mock.emitBeforeAgentStart(ctxWithSession("pixie-resident"));
    expect(mock.active).toEqual([
      PIXIE_DISPATCH_NAME,
      PIXIE_REST_NAME,
      PIXIE_RECALL_NAME,
      PIXIE_STATUS_NAME,
      PIXIE_SESSIONS_NAME,
      PIXIE_INTERJECT_NAME,
      PIXIE_STOP_NAME,
      PIXIE_RETRY_NAME,
    ]);
  });

  it("activates the resident console when ctx.cwd matches the pixie workspace", async () => {
    delete process.env[PIXIE_RESIDENT_ENV];
    process.env.PI_CODING_AGENT_DIR = "C:/agent-test";
    delete process.env.PIABYSS_PIXIE_WORKSPACE;
    const mock = createMockPi([]);
    buildPixieExtension(mock.pi);
    await mock.emitBeforeAgentStart(ctxWithSession("sess-x", "C:\\agent-test\\workspace\\pixie"));
    expect(mock.active).toEqual([
      PIXIE_DISPATCH_NAME,
      PIXIE_REST_NAME,
      PIXIE_RECALL_NAME,
      PIXIE_STATUS_NAME,
      PIXIE_SESSIONS_NAME,
      PIXIE_INTERJECT_NAME,
      PIXIE_STOP_NAME,
      PIXIE_RETRY_NAME,
    ]);
  });

  it("gates report/ask by armed on non-resident sessions", async () => {
    delete process.env[PIXIE_RESIDENT_ENV];
    process.env.PI_CODING_AGENT_DIR = "C:/agent-test";
    let armed = false;
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ armed }));
    });
    // 扩展入口用默认端口读取器：把 mock 服务端口写进环境变量。
    process.env[PIXIE_PORT_ENV] = String(port);
    try {
      const mock = createMockPi([]);
      buildPixieExtension(mock.pi);
      // armed=false：普通会话看不到任何 pixie 工具。
      await mock.emitBeforeAgentStart(ctxWithSession("sess-1", "C:/somewhere-else"));
      expect(mock.active).toEqual([]);
      // armed=true：report+ask 进入 active tools。
      armed = true;
      await mock.emitBeforeAgentStart(ctxWithSession("sess-1", "C:/somewhere-else"));
      expect(mock.active).toEqual([PIXIE_REPORT_NAME, PIXIE_ASK_NAME]);
    } finally {
      delete process.env[PIXIE_PORT_ENV];
      await closeServer(server);
    }
  });

  it("treats any resident value other than 1 as non-resident (env fallback only)", async () => {
    process.env[PIXIE_RESIDENT_ENV] = "0";
    const mock = createMockPi([]);
    buildPixieExtension(mock.pi);
    await mock.emitBeforeAgentStart(ctxWithSession("sess-1", "C:/somewhere-else"));
    expect(mock.active).toEqual([]);
  });
});

describe("pixie workspace cwd resolution", () => {
  it("defaults to <agentDir>/workspace/pixie", () => {
    delete process.env.PIABYSS_PIXIE_WORKSPACE;
    process.env.PI_CODING_AGENT_DIR = "C:/agent-x";
    expect(resolvePixieWorkspacePath()).toBe(join("C:/agent-x", "workspace", "pixie"));
  });

  it("honours PIABYSS_PIXIE_WORKSPACE with the {agentDir} placeholder", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/agent-x";
    process.env.PIABYSS_PIXIE_WORKSPACE = "{agentDir}/custom";
    expect(resolvePixieWorkspacePath()).toBe(join("C:/agent-x", "custom"));
  });

  it("compares case-insensitively on Windows, sensitively elsewhere", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/agent-x";
    delete process.env.PIABYSS_PIXIE_WORKSPACE;
    const workspace = join("C:/agent-x", "workspace", "pixie");
    if (process.platform === "win32") {
      expect(isPixieWorkspaceCwd(workspace.toUpperCase())).toBe(true);
    } else {
      expect(isPixieWorkspaceCwd(workspace.toUpperCase())).toBe(false);
    }
    expect(isPixieWorkspaceCwd(workspace)).toBe(true);
    expect(isPixieWorkspaceCwd("C:/other")).toBe(false);
    expect(isPixieWorkspaceCwd(null)).toBe(false);
  });
});

describe("readPixiePort / readPixieToken", () => {
  it("parses a valid port from PIABYSS_PIXIE_HTTP_PORT", () => {
    expect(readPixiePort({ [PIXIE_PORT_ENV]: "18790" })).toBe(18790);
  });

  it("returns null for missing or invalid ports", () => {
    expect(readPixiePort({})).toBeNull();
    expect(readPixiePort({ [PIXIE_PORT_ENV]: "" })).toBeNull();
    expect(readPixiePort({ [PIXIE_PORT_ENV]: "not-a-port" })).toBeNull();
    expect(readPixiePort({ [PIXIE_PORT_ENV]: "0" })).toBeNull();
    expect(readPixiePort({ [PIXIE_PORT_ENV]: "70000" })).toBeNull();
    expect(readPixiePort({ [PIXIE_PORT_ENV]: "8080.5" })).toBeNull();
  });

  it("reads the control-plane token (trimmed; null when unset)", () => {
    expect(readPixieToken({})).toBeNull();
    expect(readPixieToken({ [PIXIE_TOKEN_ENV]: "" })).toBeNull();
    expect(readPixieToken({ [PIXIE_TOKEN_ENV]: "  tok  " })).toBe("tok");
  });
});
