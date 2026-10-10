/**
 * pi-reimburse —— 云同步工具 `reimburse_sync`。
 *
 * 与 PiAbyss 备忘录同一模式，配置不进工具：
 * R2 密钥与 autoSync 由插件设置页「报销管家」的配置表单管理（写入
 * PI_REIMBURSE_R2_* / PI_REIMBURSE_AUTO_SYNC 环境变量，扩展与其同进程
 * 因此实时生效），本工具只提供 test / sync_now / status 三个动作做
 * 诊断与手动同步。
 *
 * 报销数据的 autoSync 由 reimburse 工具在每次成功变更后防抖触发；每个
 * 进程（agent 实例）启动后还会延迟触发一次启动同步（autoSync 开启且
 * 已配置时生效）。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getReimburseStore } from "../src/reimburse-store.js";
import { getReimburseSync, type ReimburseSyncStats } from "../src/reimburse-sync.js";

const SYNC_TOOL_NAME = "reimburse_sync";

const CONFIG_FORM_HINT =
  "R2 密钥在插件设置 →「报销管家」的配置表单里填写，不要在对话里传密钥。";

const ParamsSchema = Type.Object({
  action: Type.Union([Type.Literal("test"), Type.Literal("sync_now"), Type.Literal("status")], {
    description:
      "test = 用当前配置测一次 R2 连通性；sync_now = 立即双向同步；status = 查看配置与最近同步状态",
  }),
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

export default function (pi: ExtensionAPI) {
  // 每个进程（agent 实例）启动后延迟触发一次启动同步（autoSync 开启且已配置时生效）。
  pi.on("session_start", async () => {
    getReimburseSync(getAgentDir()).startupSync();
  });

  pi.registerTool({
    name: SYNC_TOOL_NAME,
    label: "报销同步",
    description:
      "pi-reimburse 的 R2 云同步控制：test 用当前配置测连通性；sync_now 立即双向同步（LWW 合并+删除墓碑传播+图片补齐/上传）；status 查看配置与最近同步状态。R2 密钥（accountId/accessKeyId/secretAccessKey/bucket）与 autoSync 在插件设置的配置表单里管理，不在对话中传递。同步策略与备忘录一致：逐条最后写入者胜，删除靠 30 天墓碑传播。",
    promptSnippet: "Test and run pi-reimburse cloud sync (Cloudflare R2)",
    promptGuidelines: [
      "密钥与 autoSync 属于插件配置（设置 → 报销管家的配置表单），不要向用户索要或复述密钥；status/test 显示未配置时引导用户去配置表单里填写。",
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
          case "test": {
            const settings = sync.getSettings();
            if (!settings.configured) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `尚未配置 R2 连接信息：请在插件设置 →「报销管家」的配置表单里填写 Account ID / Access Key ID / Secret Access Key / 桶名。`,
                  },
                ],
                details: { action: "test", ok: false, error: "not configured" },
              };
            }
            const result = await sync.test();
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
            const sourceOf = (fromEnv: boolean): string => (fromEnv ? "设置（env）" : "旧配置文件回退");
            const textLines = [
              `云端配置: ${settings.configured ? "已配置" : "未配置"}`,
              `  accountId: ${settings.accountId || "（未配置）"} [${sourceOf(settings.configSource.accountId)}]`,
              `  bucket: ${settings.bucket || "（未配置）"} [${sourceOf(settings.configSource.bucket)}]`,
              `  accessKeyId / secretAccessKey: ${settings.accessKeyId && settings.secretAccessKey ? "已配置" : "（未配置）"}`,
              `autoSync: ${settings.autoSync ? "开" : "关"}`,
              `最近同步: ${lastSync}`,
              `报销单: ${claims.length} 条可见（待报销 ${pending.length} 笔 / ¥${pendingTotal.toFixed(2)} 未到账）`,
              `替票: ${store.listReceipts().length} 张`,
            ];
            if (!settings.configured) textLines.push(`提示：${CONFIG_FORM_HINT}`);
            return {
              content: [{ type: "text" as const, text: textLines.join("\n") }],
              details: {
                action: "status",
                configured: settings.configured,
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
