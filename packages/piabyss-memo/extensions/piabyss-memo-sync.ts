/**
 * piabyss-memo —— 云同步工具 `piabyss_memo_sync` + 进程级同步运行时。
 *
 * 与 pi-reimburse 的 reimburse_sync 同一模式，但配置不进工具：
 * R2 密钥由 PiAbyss「设置 → 插件 → PiAbyss 备忘录」的配置表单管理
 * （pluginLibrary.setEnv 注入环境变量，扩展与其同进程因此实时生效），
 * 本工具只提供 test / sync_now / status 三个动作做诊断与手动同步。
 *
 * 进程级单例（挂 globalThis，防 jiti moduleCache:false 的模块实例分裂）：
 *   - 环回 HTTP 控制面（127.0.0.1:<PIABYSS_MEMO_SYNC_PORT|18768>）：
 *     PiAbyss Host 的 memo.testSync / memo.syncNow 协议代理到这里，
 *     桌面备忘录页的「测试连接 / 立即同步」按钮由此触达插件内的引擎；
 *   - 启动同步：autoSync 开启且已配置时，进程启动后延迟拉齐一次。
 *
 * 备忘录数据变更的 autoSync 触发：
 *   - agent 侧（piabyss_memo 工具改记录）→ 工具内部直接 scheduleAutoSync；
 *   - 桌面侧（memo.create/update/delete 协议落盘）→ Host 经控制面
 *     POST /api/auto-sync 通知本引擎防抖同步。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getMemoSync, type MemoSyncStats } from "../src/memo-sync.js";
import {
  DEFAULT_HTTP_PORT,
  resolvePort,
  startSyncHttpServer,
  syncHttpServerPort,
} from "../src/memo-sync-http.js";

const SYNC_TOOL_NAME = "piabyss_memo_sync";

const RUNTIME_KEY = Symbol.for("piabyss-memo-sync.runtime");

interface SyncRuntime {
  httpPort: number;
  httpError: string | null;
  startedAt: string;
}

function runtimeStore(): Record<symbol, SyncRuntime | undefined> {
  return globalThis as unknown as Record<symbol, SyncRuntime | undefined>;
}

/** 进程级单例（globalThis）：控制面只起一份，跨模块实例共享。 */
function ensureRuntime(): SyncRuntime {
  const store = runtimeStore();
  const existing = store[RUNTIME_KEY];
  if (existing) return existing;

  const agentDir = getAgentDir();
  const runtime: SyncRuntime = {
    httpPort: 0,
    httpError: null,
    startedAt: new Date().toISOString(),
  };
  // 先挂上再启动，避免监听回调里读到旧实例。
  store[RUNTIME_KEY] = runtime;

  const configuredPort = resolvePort();
  void startSyncHttpServer(agentDir, configuredPort)
    .then((port) => {
      runtime.httpPort = port;
      runtime.httpError = null;
      console.error(
        `[piabyss-memo-sync] 已启动：控制面 http://127.0.0.1:${port}（默认端口 ${DEFAULT_HTTP_PORT}，可用 PIABYSS_MEMO_SYNC_PORT 覆盖）`,
      );
    })
    .catch((error: unknown) => {
      runtime.httpError = error instanceof Error ? error.message : String(error);
      console.error(
        `[piabyss-memo-sync] HTTP 控制面启动失败（端口 ${configuredPort}）：${runtime.httpError}。` +
          `PiAbyss 备忘录页的云同步按钮将不可用；同步工具仍可直接调用。`,
      );
    });

  // autoSync 开启且已配置时，进程启动后延迟拉齐一次（每次进程只做一次）。
  getMemoSync(agentDir).startupSync();
  return runtime;
}

const ParamsSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("test"), Type.Literal("sync_now"), Type.Literal("status")],
    {
      description:
        "test = 用当前配置测一次 R2 连通性；sync_now = 立即双向同步；status = 查看配置与最近同步状态",
    },
  ),
});

type SyncParams = Static<typeof ParamsSchema>;

function formatStats(stats: MemoSyncStats): string {
  const lines = [
    `同步完成（${new Date(stats.at).toLocaleString("zh-CN")}）：`,
    `  上传 ${stats.uploadedNotes} 条记录 / ${stats.uploadedImages} 张图片`,
    `  从云端采纳 ${stats.downloadedNotes} 条记录、补齐 ${stats.downloadedImages} 张图片`,
    `  上传流量 ${stats.bytes} 字节`,
  ];
  return lines.join("\n");
}

function formatStatus(settings: ReturnType<ReturnType<typeof getMemoSync>["getSettings"]>): string {
  const lastSync = settings.lastSyncAt
    ? `${new Date(settings.lastSyncAt).toLocaleString("zh-CN")}（${settings.lastSyncOk ? "成功" : `失败：${settings.lastSyncError}`}）`
    : "从未同步";
  const sourceOf = (fromEnv: boolean): string => (fromEnv ? "设置（env）" : "旧配置文件回退");
  const lines = [
    `云端配置: ${settings.configured ? "已配置" : "未配置"}`,
    `  accountId: ${settings.accountId || "（未配置）"} [${sourceOf(settings.configSource.accountId)}]`,
    `  bucket: ${settings.bucket || "（未配置）"} [${sourceOf(settings.configSource.bucket)}]`,
    `  accessKeyId / secretAccessKey: ${settings.accessKeyId && settings.secretAccessKey ? "已配置" : "（未配置）"}`,
    `autoSync: ${settings.autoSync ? "开" : "关"}`,
    `最近同步: ${lastSync}`,
  ];
  if (!settings.configured) {
    lines.push(
      "提示：R2 密钥在 PiAbyss「设置 → 插件 → PiAbyss 备忘录」的配置表单里填写，不要在对话里传密钥。",
    );
  }
  return lines.join("\n");
}

export default function piabyssMemoSyncExtension(pi: ExtensionAPI): void {
  const runtime = ensureRuntime();

  pi.registerTool({
    name: SYNC_TOOL_NAME,
    label: "PiAbyss memo sync",
    description:
      "piabyss-memo 的 R2 云同步控制：test 用当前配置测连通性；sync_now 立即双向同步（LWW 合并+删除墓碑传播+图片补齐/上传）；status 查看配置与最近同步状态。R2 密钥（accountId/accessKeyId/secretAccessKey/bucket）与 autoSync 在 PiAbyss 设置的插件配置里管理，不在对话中传递。",
    promptSnippet: "Test and run piabyss-memo cloud sync (Cloudflare R2)",
    promptGuidelines: [
      "密钥与 autoSync 属于 PiAbyss 插件配置（设置 → 插件 → PiAbyss 备忘录），不要向用户索要或复述密钥；status 未配置时引导用户去设置里填。",
      "sync_now 失败时把错误原样告诉用户（通常是密钥错误或网络问题），不要重试超过一次。",
    ],
    parameters: ParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate) {
      const agentDir = getAgentDir();
      const sync = getMemoSync(agentDir);
      const p = params as SyncParams;

      try {
        switch (p.action) {
          case "test": {
            const settings = sync.getSettings();
            if (!settings.configured) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "尚未配置 R2 连接信息：请在 PiAbyss「设置 → 插件 → PiAbyss 备忘录」的配置表单里填写 Account ID / Access Key ID / Secret Access Key / 桶名。",
                  },
                ],
                details: { action: "test", ok: false, error: "not configured" },
              };
            }
            const result = await sync.test();
            return {
              content: [
                {
                  type: "text" as const,
                  text: result.ok ? "连接成功 ✅" : `连接失败：${result.error}`,
                },
              ],
              details: { action: "test", ...result },
            };
          }

          case "sync_now": {
            const stats = await sync.syncNow();
            return {
              content: [{ type: "text" as const, text: formatStats(stats) }],
              details: { action: "sync_now", stats },
            };
          }

          case "status": {
            const settings = sync.getSettings();
            const port = runtime.httpError
              ? `控制面启动失败：${runtime.httpError}`
              : syncHttpServerPort() !== null
                ? `http://127.0.0.1:${runtime.httpPort || syncHttpServerPort()}`
                : "未启动";
            return {
              content: [
                { type: "text" as const, text: `${formatStatus(settings)}\n控制面: ${port}` },
              ],
              details: {
                action: "status",
                configured: settings.configured,
                autoSync: settings.autoSync,
                lastSyncAt: settings.lastSyncAt,
                lastSyncOk: settings.lastSyncOk,
                lastSyncError: settings.lastSyncError,
              },
            };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { action: p.action, error: message },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Error: 未知 action ${String(p.action)}` }],
        details: { action: p.action, error: "unknown action" },
      };
    },
  });
}
