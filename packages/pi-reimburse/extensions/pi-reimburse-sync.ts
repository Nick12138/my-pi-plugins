/**
 * pi-reimburse —— 云同步工具 `reimburse_sync`。
 *
 * 四个 action：
 *   - config：读取/保存 R2 连接配置（accountId / accessKeyId / secretAccessKey /
 *     bucket / autoSync）；只覆盖传入字段，密钥在输出中打码；
 *   - test：连接测试（不落盘不改动状态）；
 *   - sync_now：立即双向同步（拉取→合并→清墓碑→补图→上传），返回统计；
 *   - status：最近一次同步状态 + 数据概况。
 *
 * 报销数据的 autoSync 由 reimburse 工具在每次成功变更后防抖触发；本工具
 * 只负责配置、诊断与手动同步。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getReimburseStore } from "../src/reimburse-store.js";
import { getReimburseSync, type ReimburseSyncStats } from "../src/reimburse-sync.js";

const SYNC_TOOL_NAME = "reimburse_sync";

const ParamsSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("config"), Type.Literal("test"), Type.Literal("sync_now"), Type.Literal("status")],
    {
      description:
        "config = 读取/保存 R2 配置；test = 连接测试；sync_now = 立即双向同步；status = 最近同步状态与数据概况",
    },
  ),
  accountId: Type.Optional(Type.String({ description: "Cloudflare 账户 ID（config 保存时传入）" })),
  accessKeyId: Type.Optional(Type.String({ description: "R2 访问密钥 ID（config 保存时传入）" })),
  secretAccessKey: Type.Optional(
    Type.String({ description: "R2 秘密访问密钥（config 保存时传入；输出中始终打码）" }),
  ),
  bucket: Type.Optional(Type.String({ description: "R2 桶名（config 保存时传入）" })),
  autoSync: Type.Optional(
    Type.Boolean({ description: "是否在每次报销数据变更后自动防抖同步（config 保存时传入）" }),
  ),
});

type SyncParams = Static<typeof ParamsSchema>;

function formatStats(stats: ReimburseSyncStats): string {
  const lines = [
    `同步完成（${new Date(stats.at).toLocaleString("zh-CN")}）：`,
    `  云端共 ${stats.uploadedClaims} 条报销单 / ${stats.uploadedReceipts} 张替票已就绪`,
    `  从云端采纳 ${stats.downloadedClaims} 条报销单、${stats.downloadedReceipts} 张替票`,
    `  上传图片 ${stats.uploadedImages} 张，补齐图片 ${stats.downloadedImages} 张`,
    `  上传流量 ${stats.bytes} 字节`,
  ];
  return lines.join("\n");
}

function maskSecret(secret: string): string {
  return secret ? "******（已配置）" : "（未配置）";
}

export default function (pi: ExtensionAPI) {
  // 每个进程（agent 实例）启动后延迟触发一次启动同步（autoSync 开启且已配置时生效）。
  pi.on("session_start", async () => {
    getReimburseSync(getAgentDir()).startupSync();
  });

  pi.registerTool({
    name: SYNC_TOOL_NAME,
    label: "报销同步",
    description:
      "pi-reimburse 的 R2 云同步控制：config 配置 Cloudflare R2（accountId/accessKeyId/secretAccessKey/bucket/autoSync，只覆盖传入字段）；test 连接测试；sync_now 立即双向同步（LWW 合并+删除墓碑传播+图片补齐/上传）；status 查看最近同步状态与数据概况。同步策略与备忘录一致：逐条最后写入者胜，删除靠 30 天墓碑传播。",
    promptSnippet: "Configure and run pi-reimburse cloud sync (Cloudflare R2)",
    promptGuidelines: [
      "首次配置时依次要用户要 accountId、accessKeyId、secretAccessKey、bucket；secretAccessKey 是敏感信息，输出时永远打码，不复述明文。",
      "保存配置后先跑 test 验证连通性，通过后可以开 autoSync 或手动 sync_now。",
      "sync_now 失败时把错误原样告诉用户（通常是密钥错误或网络问题），不要重试超过一次。",
    ],
    parameters: ParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate) {
      const agentDir = getAgentDir();
      const sync = getReimburseSync(agentDir);
      const p = params as SyncParams;

      try {
        switch (p.action) {
          case "config": {
            const hasPatch =
              p.accountId !== undefined ||
              p.accessKeyId !== undefined ||
              p.secretAccessKey !== undefined ||
              p.bucket !== undefined ||
              p.autoSync !== undefined;
            if (hasPatch) {
              const saved = sync.setConfig({
                accountId: p.accountId,
                accessKeyId: p.accessKeyId,
                secretAccessKey: p.secretAccessKey,
                bucket: p.bucket,
                autoSync: p.autoSync,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: [
                      "已保存同步配置：",
                      `  accountId: ${saved.accountId || "（未配置）"}`,
                      `  accessKeyId: ${saved.accessKeyId || "（未配置）"}`,
                      `  secretAccessKey: ${maskSecret(saved.secretAccessKey)}`,
                      `  bucket: ${saved.bucket || "（未配置）"}`,
                      `  autoSync: ${saved.autoSync ? "开" : "关"}`,
                      "建议先跑 test 验证连通性。",
                    ].join("\n"),
                  },
                ],
                details: { action: "config", configured: Boolean(saved.accountId && saved.bucket) },
              };
            }
            const settings = sync.getSettings();
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    "当前同步配置：",
                    `  accountId: ${settings.accountId || "（未配置）"}`,
                    `  accessKeyId: ${settings.accessKeyId || "（未配置）"}`,
                    `  secretAccessKey: ${maskSecret(settings.secretAccessKey)}`,
                    `  bucket: ${settings.bucket || "（未配置）"}`,
                    `  autoSync: ${settings.autoSync ? "开" : "关"}`,
                  ].join("\n"),
                },
              ],
              details: { action: "config", configured: Boolean(settings.accountId && settings.bucket) },
            };
          }

          case "test": {
            const settings = sync.getSettings();
            const result = await sync.test({
              accountId: p.accountId ?? settings.accountId,
              accessKeyId: p.accessKeyId ?? settings.accessKeyId,
              secretAccessKey: p.secretAccessKey ?? settings.secretAccessKey,
              bucket: p.bucket ?? settings.bucket,
              autoSync: false,
            });
            return {
              content: [
                { type: "text" as const, text: result.ok ? "连接成功 ✅" : `连接失败：${result.error}` },
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
            const store = getReimburseStore(agentDir);
            const claims = store.list();
            const pending = claims.filter((claim) => claim.status === "pending");
            const pendingTotal = pending.reduce((sum, claim) => sum + claim.amount, 0);
            const lastSync = settings.lastSyncAt
              ? `${new Date(settings.lastSyncAt).toLocaleString("zh-CN")}（${settings.lastSyncOk ? "成功" : `失败：${settings.lastSyncError}`}）`
              : "从未同步";
            const text = [
              `autoSync: ${settings.autoSync ? "开" : "关"}`,
              `最近同步: ${lastSync}`,
              `报销单: ${claims.length} 条可见（待报销 ${pending.length} 笔 / ¥${pendingTotal.toFixed(2)} 未到账）`,
              `替票: ${store.listReceipts().length} 张`,
              `云端配置: ${settings.accountId && settings.bucket ? "已配置" : "未配置"}`,
            ].join("\n");
            return {
              content: [{ type: "text" as const, text }],
              details: {
                action: "status",
                autoSync: settings.autoSync,
                lastSyncAt: settings.lastSyncAt,
                lastSyncOk: settings.lastSyncOk,
                lastSyncError: settings.lastSyncError,
                visibleClaims: claims.length,
                pendingClaims: pending.length,
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
