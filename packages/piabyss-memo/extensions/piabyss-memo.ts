/**
 * piabyss-memo —— 把 PiAbyss 内置工具 `piabyss_memo` 外移为 pi 插件。
 *
 * 「用 Agent 处理」一条备忘录时，桌面端把记录内容以引用块注入会话；
 * agent 处理完后通过本工具把该记录标记为已完成（或重新打开 / 更新正文），
 * complete 时必须提交结果总结（覆盖式写入 MemoNote.result），
 * 并自动捕获提交时所在的会话（id/路径/标题/cwd）供「继续讨论」跳转。
 *
 * 完成时机约束（工具描述 + 注入提示词双重约束）：
 *   - 只有任务已产出最终结果、不再等待用户输入时才允许 complete；
 *   - 需要用户决策（如选择方案）时不标记完成，等结论出来再回填；
 *   - 用户会话中手动发送的指令优先级最高，可覆盖备忘录内嵌提示词。
 *
 * 工具直接读写 MemoStore（磁盘权威，无缓存），与 PiAbyss 桌面备忘录页面、
 * 协议 handler、以及本插件自带的云同步引擎（extensions/piabyss-memo-sync.ts
 * + src/memo-sync.ts）共享同一份数据（磁盘格式见 src/memo-store.ts）。
 * 记录变更后触发 autoSync 防抖同步（引擎未配置/未开启时静默跳过）。
 *
 * v3（计划功能）：
 *   - update 支持 dueAt（一次性截止）与 recurrence（周期规则，结构见
 *     src/recurrence.ts），传 null 清除；
 *   - complete 对周期记录只终结本轮：记录总结后自动滚动 nextDueAt，
 *     status 保持 open（周期到达 until 自然终结为 done）；
 *   - list 展示 due / recurs / next / 逾期标记；
 *   - 状态只有 open / in_progress / done 三种（archived 已移除）。
 *
 * v5（agent 侧新建）：
 *   - 新增 create 动作（title 必填，contentMd / tags / dueAt / recurrence 可选），
 *     直接经 store.create 落盘并返回新记录 id；Host 端新建草稿（draft.json）
 *     仍由桌面 UI/协议层负责，本动作不碰草稿。
 *
 * v6（agent 侧删除）：
 *   - 新增 delete 动作（id 必填）：走 store.remove 打墓碑（软删除），记录体
 *     保留在 notes.json 里供同步引擎把删除传播到其他设备；超过 TTL 的墓碑
 *     由同步引擎物理清理，工具层不提供物理删除路径。
 *     语义区分：作废/取消的便签用 delete；任务真正做完用 complete + result。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getMemoStore, type MemoNote } from "../src/memo-store.js";
import type { MemoRecurrence } from "../src/recurrence.js";
import { scheduleMemoAutoSync } from "../src/memo-sync.js";

const MEMO_TOOL_NAME = "piabyss_memo";

/** 周期规则入参（工具层形状；经 toStoreRecurrence 转换后交 store 校验归一）。 */
const RecurrenceSchema = Type.Object({
  frequency: Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")], {
    description: "daily|weekly|monthly",
  }),
  interval: Type.Optional(Type.Number({ description: "每 N 个周期，默认 1" })),
  weekdays: Type.Optional(Type.Array(Type.Number(), { description: "weekly 必填：1=周一 … 7=周日" })),
  monthDay: Type.Optional(
    Type.Union([Type.Number(), Type.Null()], { description: "monthly 必填：1-31（无此日的月份跳过）" }),
  ),
  time: Type.String({ description: "本地时间 HH:mm" }),
  tz: Type.Optional(Type.String({ description: "IANA 时区，默认 Asia/Shanghai" })),
  until: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "结束日期或 ISO；null=长期" })),
});

type RecurrenceParam = Static<typeof RecurrenceSchema>;

const ParamsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("create"),
      Type.Literal("complete"),
      Type.Literal("reopen"),
      Type.Literal("update"),
      Type.Literal("delete"),
    ],
    {
      description:
        "list=列出全部；create=新建（需 title）；complete=完成并写 result；reopen=重开；update=改标题/正文/标签/计划；delete=软删除作废的便签（打墓碑，同步会传播删除）。",
    },
  ),
  id: Type.Optional(
    Type.String({ description: "便签 id（complete/reopen/update/delete 必填；不知道就先 list）。" }),
  ),
  title: Type.Optional(Type.String({ description: "标题（create 必填；update 时改标题）。" })),
  contentMd: Type.Optional(Type.String({ description: "Markdown 正文（create/update）。" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "标签（create 初始；update 整体替换）。" })),
  result: Type.Optional(
    Type.String({
      description: "complete 必填：做了什么 + 产出/结论 + 待跟进项（覆盖旧摘要）。",
    }),
  ),
  dueAt: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "一次性到期：YYYY-MM-DD[ HH:mm] 或 ISO；null 清除。",
    }),
  ),
  recurrence: Type.Optional(
    Type.Union([RecurrenceSchema, Type.Null()], {
      description: "周期规则；null 清除变普通便签。",
    }),
  ),
});

type MemoParams = Static<typeof ParamsSchema>;

/** 工具执行时捕获的当前会话信息（供结果总结与会话关联使用）。 */
type MemoSessionInfo = {
  sessionId: string;
  sessionPath: string | null;
  sessionName: string | null;
  cwd: string | null;
};

const TOOL_DESCRIPTION =
  "PiAbyss「待办 · 速记」看板（待办/备忘/收集）。记一笔或设提醒用 create；查用 list；任务真的做完、且没有在等用户决定的事时才 complete，必须给 result 摘要。周期便签 complete 只结当前轮，要停掉先清 recurrence。作废/取消的便签用 delete（软删除，同步会传播），不要拿 delete 代替做完（结项用 complete + result），也不要拿 complete 当删除。用户口头指令优先于便签字面。";

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 周期规则的人读描述（list 输出用）。 */
function describeRecurrence(rule: MemoRecurrence): string {
  let base: string;
  if (rule.frequency === "daily") {
    base = rule.interval === 1 ? "daily" : `every ${rule.interval} days`;
  } else if (rule.frequency === "weekly") {
    const suffix = rule.interval === 1 ? "weekly" : `every ${rule.interval} weeks`;
    base = `${suffix} on ${rule.weekdays.map((wd) => WEEKDAY_NAMES[wd - 1] ?? String(wd)).join("/")}`;
  } else {
    const suffix = rule.interval === 1 ? "monthly" : `every ${rule.interval} months`;
    base = `${suffix} on day ${rule.monthDay ?? "?"}`;
  }
  let text = `${base} at ${rule.time} (${rule.tz})`;
  if (rule.until !== null) text += ` until ${new Date(rule.until).toISOString()}`;
  return text;
}

/** 面向模型的单条记录摘要行。 */
function formatNote(note: MemoNote): string {
  const parts = [
    `id: ${note.id}`,
    `status: ${note.status}`,
    `title: ${note.title}`,
  ];
  if (note.tags.length) parts.push(`tags: ${note.tags.map((tag) => `#${tag}`).join(" ")}`);
  if (note.workspaceHint) parts.push(`workspace: ${note.workspaceHint}`);
  if (note.dueAt !== null) parts.push(`due: ${new Date(note.dueAt).toISOString()}`);
  if (note.recurrence !== null) parts.push(`recurs: ${describeRecurrence(note.recurrence)}`);
  if (note.nextDueAt !== null) {
    const overdue = note.status !== "done" && note.nextDueAt < Date.now();
    parts.push(`next: ${new Date(note.nextDueAt).toISOString()}${overdue ? " (OVERDUE)" : ""}`);
  }
  if (note.lastDoneAt !== null) parts.push(`last done: ${new Date(note.lastDoneAt).toISOString()}`);
  const updated = new Date(note.updatedAt).toISOString();
  parts.push(`updated: ${updated}`);
  return `- ${parts.join(" | ")}`;
}

/**
 * 从 ExtensionContext 读取当前会话信息（与原实现 memoSessionInfo 一致：
 * sessionId 取 getSessionId()，sessionPath 取会话文件路径，cwd 取会话 cwd）。
 */
function memoSessionInfo(ctx: ExtensionContext): MemoSessionInfo {
  const sessionManager = ctx.sessionManager;
  return {
    sessionId: sessionManager.getSessionId(),
    sessionPath: sessionManager.getSessionFile() ?? null,
    sessionName: sessionManager.getSessionName() ?? null,
    cwd: sessionManager.getCwd(),
  };
}

/** 不带时区的时间串（按设备本地时区解释）：YYYY-MM-DD[ HH:mm|THH:mm[:ss]]。 */
const LOCAL_DUE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * 解析截止/终点时间：带 Z 或 ±hh:mm 偏移的完整 ISO 直接用；
 * 其余（'YYYY-MM-DD'、'YYYY-MM-DD HH:mm'）按设备本地时区解释。
 */
function parseDueAt(raw: string): number {
  const value = raw.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const iso = Date.parse(value);
    if (!Number.isNaN(iso)) return iso;
  }
  const match = LOCAL_DUE_RE.exec(value);
  if (!match) {
    throw new Error(`无法解析时间：${raw}（支持 YYYY-MM-DD[ HH:mm] 或 ISO 格式）`);
  }
  const local = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? "00"),
    Number(match[5] ?? "00"),
    Number(match[6] ?? "00"),
  );
  const epoch = local.getTime();
  if (Number.isNaN(epoch)) {
    throw new Error(`无法解析时间：${raw}（日期不合法）`);
  }
  return epoch;
}

/** 工具层周期入参 → store 原始规则（until 字符串转 epoch，其余透传交校验）。 */
function toStoreRecurrence(param: RecurrenceParam): Record<string, unknown> {
  const rule: Record<string, unknown> = {
    frequency: param.frequency,
    time: param.time,
  };
  if (param.interval !== undefined) rule.interval = param.interval;
  if (param.weekdays !== undefined) rule.weekdays = param.weekdays;
  if (param.monthDay !== undefined && param.monthDay !== null) rule.monthDay = param.monthDay;
  if (param.tz !== undefined) rule.tz = param.tz;
  if (param.until !== undefined && param.until !== null) rule.until = parseDueAt(param.until);
  return rule;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: MEMO_TOOL_NAME,
    label: "待办 · 速记",
    description: TOOL_DESCRIPTION,
    promptSnippet: "待办 · 速记看板：list/create/complete/reopen/update/delete",
    parameters: ParamsSchema,

    async execute(_toolCallId, params: MemoParams, _signal, _onUpdate, ctx) {
      const agentDir = getAgentDir();
      const store = getMemoStore(agentDir);
      try {
        if (params.action === "list") {
          const notes = store.list();
          if (notes.length === 0) {
            return {
              content: [{ type: "text" as const, text: "The memo board is empty." }],
              details: undefined,
            };
          }
          const body = notes.map(formatNote).join("\n");
          return {
            content: [{ type: "text" as const, text: `Memo notes (${notes.length}):\n${body}` }],
            details: undefined,
          };
        }

        if (params.action === "create") {
          const note = store.create({
            title: params.title ?? "",
            contentMd: params.contentMd ?? "",
            tags: params.tags,
            dueAt: params.dueAt == null ? null : parseDueAt(params.dueAt),
            recurrence:
              params.recurrence == null ? undefined : toStoreRecurrence(params.recurrence),
          });
          // 变更后触发云同步防抖（autoSync 开启时生效；引擎未配置时静默跳过）。
          scheduleMemoAutoSync(agentDir);
          return {
            content: [
              { type: "text" as const, text: `Memo note created:\n${formatNote(note)}` },
            ],
            details: undefined,
          };
        }

        const id = params.id?.trim();
        if (!id) {
          return {
            content: [
              { type: "text" as const, text: "Error: a note id is required for this action." },
            ],
            details: undefined,
            isError: true,
          };
        }

        if (params.action === "complete") {
          const summary = params.result?.trim();
          if (!summary) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: complete requires a `result` parameter — a concise markdown summary of what was done, the outcome, and any remaining follow-ups.",
                },
              ],
              details: undefined,
              isError: true,
            };
          }
          const info = memoSessionInfo(ctx);
          const note = store.completeWithResult(id, {
            resultMd: summary,
            sessionId: info.sessionId,
            sessionPath: info.sessionPath,
            sessionTitle: info.sessionName,
            sessionCwd: info.cwd,
          });
          // 变更后触发云同步防抖（autoSync 开启时生效；引擎未配置时静默跳过）。
          scheduleMemoAutoSync(agentDir);
          let text: string;
          if (note.recurrence !== null && note.status === "open") {
            // 周期记录：complete 只终结本轮，下一轮已排上。
            text =
              `Memo note ${note.title}: this cycle is done; summary recorded. ` +
              `Next occurrence: ${new Date(note.nextDueAt ?? 0).toISOString()}. ` +
              `The note stays open for the next cycle — do NOT mark it done.`;
          } else if (note.recurrence !== null && note.status === "done") {
            text =
              `Memo note ${note.title}: this cycle is done; summary recorded. ` +
              `The recurring plan has reached its end (until), so the note is now marked done.`;
          } else {
            text = `Memo note ${note.title} is now done; summary recorded.`;
          }
          return {
            content: [{ type: "text" as const, text }],
            details: undefined,
          };
        }

        // delete（软删除：打墓碑，记录体保留供同步传播；工具层不提供物理删除）
        if (params.action === "delete") {
          if (!store.get(id)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: 备忘录记录不存在或已删除：${id}`,
                },
              ],
              details: undefined,
              isError: true,
            };
          }
          const note = store.remove(id);
          scheduleMemoAutoSync(agentDir);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Memo note ${note.title} deleted (soft delete: a tombstone is written, ` +
                  `the record body is kept so the deletion propagates through cloud sync; ` +
                  `expired tombstones are purged automatically later).`,
              },
            ],
            details: undefined,
          };
        }

        // reopen
        if (params.action === "reopen") {
          const note = store.update(id, { status: "open", sessionId: null });
          scheduleMemoAutoSync(agentDir);
          return {
            content: [
              {
                type: "text" as const,
                text: `Memo note ${note.title} is now ${note.status}.`,
              },
            ],
            details: undefined,
          };
        }

        // update
        const patch: Parameters<typeof store.update>[1] = {};
        if (params.title !== undefined) patch.title = params.title;
        if (params.contentMd !== undefined) patch.contentMd = params.contentMd;
        if (params.tags !== undefined) patch.tags = params.tags;
        if (params.dueAt !== undefined) {
          patch.dueAt = params.dueAt === null ? null : parseDueAt(params.dueAt);
        }
        if (params.recurrence !== undefined) {
          patch.recurrence = params.recurrence === null ? null : toStoreRecurrence(params.recurrence);
        }
        if (Object.keys(patch).length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: nothing to update." }],
            details: undefined,
            isError: true,
          };
        }
        const note = store.update(id, patch);
        scheduleMemoAutoSync(agentDir);
        return {
          content: [{ type: "text" as const, text: `Memo note updated:\n${formatNote(note)}` }],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}
