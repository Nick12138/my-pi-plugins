/**
 * pi-reimburse —— 个人报销管家工具（v2）。
 *
 * 两个工具：
 *   - `reimburse`：报销单（类别/日期/项目/事宜/费用/票据/备注）与替票的
 *     增删改查；票据图片从本地路径复制托管，替票是可被多条报销单共享的实体；
 *   - `reimburse_sync`：R2 云同步（配置/测试/立即同步/状态），见
 *     extensions/pi-reimburse-sync.ts。
 *
 * 数据落盘在 `<agentDir>/reimburse/`（磁盘权威，无内存缓存），跨会话、
 * 跨工作区共享同一份个人报销数据。任何变更成功后防抖触发 autoSync。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  CATEGORIES,
  getReimburseStore,
  ReimburseStoreError,
  type Claim,
  type Receipt,
} from "../src/reimburse-store.js";
import { scheduleReimburseAutoSync } from "../src/reimburse-sync.js";

const REIMBURSE_TOOL_NAME = "reimburse";

const CategorySchema = Type.Union(
  CATEGORIES.map((category) => Type.Literal(category)),
  { description: "报销类别" },
);

const ParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("update"),
    Type.Literal("delete"),
    Type.Literal("receipt_add"),
    Type.Literal("receipt_list"),
    Type.Literal("receipt_update"),
    Type.Literal("receipt_delete"),
  ]),
  id: Type.Optional(
    Type.Number({ description: "报销单 id 或替票 id（receipt_* 系列 action 操作替票；update/get/delete 必填）" }),
  ),
  category: Type.Optional(CategorySchema),
  date: Type.Optional(Type.String({ description: "发生日期 YYYY-MM-DD（add 可选，默认今天）" })),
  project: Type.Optional(Type.String({ description: "项目名称（可选；update 传空字符串清空）" })),
  subject: Type.Optional(Type.String({ description: "事宜（add/receipt_add 必填，如「出差高铁票」）" })),
  amount: Type.Optional(Type.Number({ description: "费用/替票面额（元，大于 0；add 必填；receipt_add 可选）" })),
  note: Type.Optional(Type.String({ description: "备注（可选；update 传空字符串清空）" })),
  status: Type.Optional(
    Type.Union([Type.Literal("pending"), Type.Literal("reimbursed")], {
      description: "状态（update 用）：pending = 待报销，reimbursed = 已到账",
    }),
  ),
  month: Type.Optional(Type.String({ description: "list 按发生月过滤，格式 YYYY-MM" })),
  invoiceImagePath: Type.Optional(
    Type.String({
      description:
        "发票/车票图片的本地绝对路径（add 登记时直接关联；update 传入=替换，传 null=清除）",
    }),
  ),
  transactionImagePath: Type.Optional(
    Type.String({
      description:
        "交易截图的本地绝对路径，与替票配套（add 登记时直接关联；update 传入=替换，传 null=清除）",
    }),
  ),
  substituteReceiptId: Type.Optional(
    Type.Number({
      description: "关联的替票 id（update 传入=改关联，传 null=解除；替票须已用 receipt_add 登记）",
    }),
  ),
  imagePath: Type.Optional(
    Type.String({ description: "替票图片的本地绝对路径（receipt_add/receipt_update 用；receipt_update 传 null=清除）" }),
  ),
});

type ReimburseParams = Static<typeof ParamsSchema>;

/** 单条报销单的可读文本行。 */
function formatClaim(store: ReturnType<typeof getReimburseStore>, claim: Claim): string {
  const parts = [
    `#${claim.id}`,
    claim.date,
    `[${claim.category}]`,
    claim.subject,
    `¥${claim.amount.toFixed(2)}`,
  ];
  if (claim.project) parts.push(`（项目：${claim.project}）`);
  if (claim.note) parts.push(`备注：${claim.note}`);
  const tickets: string[] = [];
  if (claim.invoiceImage) tickets.push(`发票/车票:${claim.invoiceImage.fileName}`);
  if (claim.transactionImage) tickets.push(`交易截图:${claim.transactionImage.fileName}`);
  if (claim.substituteReceiptId !== null) {
    const receipt = store.getReceipt(claim.substituteReceiptId);
    tickets.push(`替票#${claim.substituteReceiptId}${receipt ? `(${receipt.title})` : "(已删)"}`);
  }
  if (tickets.length > 0) parts.push(`票据：${tickets.join(" + ")}`);
  parts.push(claim.status === "reimbursed" ? "✅已到账" : "⏳待报销");
  return parts.join(" ");
}

/** 单条替票的可读文本行。 */
function formatReceipt(store: ReturnType<typeof getReimburseStore>, receipt: Receipt): string {
  const parts = [`替票#${receipt.id}`, receipt.title];
  if (receipt.amount !== null) parts.push(`面额¥${receipt.amount.toFixed(2)}`);
  if (receipt.image) parts.push(`图片:${receipt.image.fileName}`);
  const used = store.receiptUsageCount(receipt.id);
  parts.push(used > 0 ? `被 ${used} 条报销单引用` : "未被引用");
  return parts.join(" ");
}

/** pending 汇总行（list 输出末尾附带）。 */
function pendingSummary(claims: Claim[]): string {
  const pending = claims.filter((claim) => claim.status === "pending");
  const total = pending.reduce((sum, claim) => sum + claim.amount, 0);
  return pending.length > 0 ? `未到账 ${pending.length} 笔，合计 ¥${total.toFixed(2)}` : "没有待报销的垫付款";
}

function claimDetails(claim: Claim): Record<string, unknown> {
  return { ...claim };
}

function receiptDetails(receipt: Receipt): Record<string, unknown> {
  return { ...receipt };
}

function errorText(error: unknown): string {
  if (error instanceof ReimburseStoreError) return `Error: ${error.message}`;
  console.error("[pi-reimburse] unexpected error:", error);
  return "Error: 内部错误，详见日志";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: REIMBURSE_TOOL_NAME,
    label: "报销",
    description:
      "管理用户的个人报销单与替票。报销单字段：类别（差旅/交通/餐饮/办公用品/招待/其他）、日期、项目名称、事宜、费用、票据、备注。票据两种模式：直票（invoiceImagePath=发票/车票图片）或替票组合（transactionImagePath=交易截图 + substituteReceiptId=共享替票）。替票用 receipt_add 登记、可被多条报销单共享（同一张替票+各自不同的交易截图）。list 支持按状态/月份/类别/项目过滤，末尾附未到账汇总。图片会复制进 ~/.pi/reimburse/images/ 托管，原图可删。数据跨会话保留；变更后自动防抖云同步。",
    promptSnippet: "Manage the user's personal reimbursement claims and shared substitute receipts",
    promptGuidelines: [
      "用户提到报销、垫付、垫了多少钱、报销到账没有时，用 reimburse 工具登记或查询。",
      "add 必填 category、subject（事宜）、amount（费用）；date 缺省为今天，不要替用户猜历史日期。",
      "票据模式二选一：有发票/车票图片用 invoiceImagePath；用替票报销时先 receipt_add 登记替票（可复用），再传 transactionImagePath + substituteReceiptId。",
      "查询未到账的报销用 list status=pending；确认到账后用 update 把 status 改为 reimbursed。",
      "金额以元为单位；不确定金额、类别或日期时先问用户，不要编造。",
      "替票删除前必须先解除所有报销单的引用（update substituteReceiptId=null）；替票被引用时删除会报错。",
      "登记/修改后把单据关键信息（id、类别、事宜、费用、状态、票据）复述给用户确认。",
    ],
    parameters: ParamsSchema,
    // 写操作都读改写整个文件，串行执行避免并发覆盖。
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const agentDir = getAgentDir();
      const store = getReimburseStore(agentDir);
      const p = params as ReimburseParams;

      // 成功的写操作之后防抖触发 autoSync（读操作与失败路径不触发）。
      const mutate = () => scheduleReimburseAutoSync(agentDir);

      try {
        switch (p.action) {
          case "add": {
            if (!p.subject || p.amount === undefined || !p.category) {
              return {
                content: [
                  { type: "text" as const, text: "Error: add 需要 category（类别）、subject（事宜）和 amount（费用）" },
                ],
                details: { action: "add", error: "missing category/subject/amount" },
              };
            }
            const claim = store.create({
              category: p.category,
              subject: p.subject,
              amount: p.amount,
              date: p.date,
              project: p.project,
              note: p.note ?? null,
              invoiceImagePath: p.invoiceImagePath,
              transactionImagePath: p.transactionImagePath,
              substituteReceiptId: p.substituteReceiptId,
            });
            mutate();
            return {
              content: [{ type: "text" as const, text: `已登记：${formatClaim(store, claim)}` }],
              details: { action: "add", claim: claimDetails(claim) },
            };
          }

          case "list": {
            const claims = store.list({
              status: p.status,
              month: p.month,
              category: p.category,
              project: p.project,
            });
            const lines = claims.map((claim) => formatClaim(store, claim));
            const text =
              lines.length > 0
                ? `${lines.join("\n")}\n—— ${pendingSummary(claims)}`
                : "没有符合条件的报销单";
            return {
              content: [{ type: "text" as const, text }],
              details: { action: "list", claims, count: claims.length },
            };
          }

          case "get": {
            if (p.id === undefined) {
              return {
                content: [{ type: "text" as const, text: "Error: get 需要 id" }],
                details: { action: "get", error: "missing id" },
              };
            }
            const claim = store.get(p.id);
            if (!claim) {
              return {
                content: [{ type: "text" as const, text: `Error: 报销单不存在：id ${p.id}` }],
                details: { action: "get", id: p.id, error: "not found" },
              };
            }
            return {
              content: [{ type: "text" as const, text: formatClaim(store, claim) }],
              details: { action: "get", claim: claimDetails(claim) },
            };
          }

          case "update": {
            if (p.id === undefined) {
              return {
                content: [{ type: "text" as const, text: "Error: update 需要 id" }],
                details: { action: "update", error: "missing id" },
              };
            }
            const claim = store.update(p.id, {
              category: p.category,
              date: p.date,
              project: p.project,
              subject: p.subject,
              amount: p.amount,
              note: p.note,
              status: p.status,
              invoiceImagePath: p.invoiceImagePath,
              transactionImagePath: p.transactionImagePath,
              substituteReceiptId: p.substituteReceiptId,
            });
            mutate();
            return {
              content: [{ type: "text" as const, text: `已更新：${formatClaim(store, claim)}` }],
              details: { action: "update", claim: claimDetails(claim) },
            };
          }

          case "delete": {
            if (p.id === undefined) {
              return {
                content: [{ type: "text" as const, text: "Error: delete 需要 id" }],
                details: { action: "delete", error: "missing id" },
              };
            }
            const removed = store.remove(p.id);
            mutate();
            return {
              content: [
                {
                  type: "text" as const,
                  text: `已删除：${formatClaim(store, removed)}（30 天内其他设备同步回来之前仍可复活；物理清理在云端同步时进行）`,
                },
              ],
              details: { action: "delete", claim: claimDetails(removed) },
            };
          }

          case "receipt_add": {
            if (!p.subject) {
              return {
                content: [{ type: "text" as const, text: "Error: receipt_add 需要 subject（替票说明）" }],
                details: { action: "receipt_add", error: "missing subject" },
              };
            }
            const receipt = store.createReceipt({
              title: p.subject,
              amount: p.amount ?? null,
              imagePath: p.imagePath,
            });
            mutate();
            return {
              content: [{ type: "text" as const, text: `已登记：${formatReceipt(store, receipt)}` }],
              details: { action: "receipt_add", receipt: receiptDetails(receipt) },
            };
          }

          case "receipt_list": {
            const receipts = store.listReceipts();
            const text =
              receipts.length > 0
                ? receipts.map((receipt) => formatReceipt(store, receipt)).join("\n")
                : "还没有登记替票";
            return {
              content: [{ type: "text" as const, text }],
              details: { action: "receipt_list", receipts, count: receipts.length },
            };
          }

          case "receipt_update": {
            if (p.id === undefined) {
              return {
                content: [{ type: "text" as const, text: "Error: receipt_update 需要 id" }],
                details: { action: "receipt_update", error: "missing id" },
              };
            }
            const receipt = store.updateReceipt(p.id, {
              title: p.subject,
              amount: p.amount,
              imagePath: p.imagePath,
            });
            mutate();
            return {
              content: [{ type: "text" as const, text: `已更新：${formatReceipt(store, receipt)}` }],
              details: { action: "receipt_update", receipt: receiptDetails(receipt) },
            };
          }

          case "receipt_delete": {
            if (p.id === undefined) {
              return {
                content: [{ type: "text" as const, text: "Error: receipt_delete 需要 id" }],
                details: { action: "receipt_delete", error: "missing id" },
              };
            }
            const removed = store.removeReceipt(p.id);
            mutate();
            return {
              content: [{ type: "text" as const, text: `已删除：${formatReceipt(store, removed)}` }],
              details: { action: "receipt_delete", receipt: receiptDetails(removed) },
            };
          }
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: errorText(error) }],
          details: { action: p.action, error: String(error) },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Error: 未知 action ${String(p.action)}` }],
        details: { action: p.action, error: "unknown action" },
      };
    },
  });
}
