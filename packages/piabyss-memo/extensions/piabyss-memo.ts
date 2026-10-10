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
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getMemoStore, type MemoNote } from "../src/memo-store.js";
import { scheduleMemoAutoSync } from "../src/memo-sync.js";

const MEMO_TOOL_NAME = "piabyss_memo";

const ParamsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("complete"),
      Type.Literal("reopen"),
      Type.Literal("update"),
    ],
    {
      description:
        "list = show all memo notes with ids and statuses; complete = mark a note as done, ONLY when the work it asked for is truly finished and nothing is awaited from the user; reopen = mark a done note as open again; update = change a note's title/content/tags.",
    },
  ),
  id: Type.Optional(
    Type.String({ description: "The memo note id. Required for complete/reopen/update." }),
  ),
  title: Type.Optional(Type.String({ description: "New title (update action only)." })),
  contentMd: Type.Optional(Type.String({ description: "New markdown body (update action only)." })),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "New tag list replacing the old one (update action only).",
    }),
  ),
  result: Type.Optional(
    Type.String({
      description:
        "Required for complete: a concise markdown summary of what was done, the outcome/outputs, and any remaining follow-ups. Overwrites any previous summary on the note.",
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

const TOOL_DESCRIPTION = [
  "Access the user's PiAbyss memo board (备忘录).",
  "Use it to list pending notes, to mark a note as complete (complete) once the task described in it has been handled, or to reopen/update notes.",
  "Before calling complete, self-check: has the task produced a final result? Are you still waiting for user input or a user decision? If anything is still awaited (e.g. you asked the user to pick an option), do NOT call complete — reply and wait instead.",
  "Instructions the user sends manually in the session always override memo prompts: if the user says not to mark a note done yet, do not call complete.",
  "complete REQUIRES a `result` parameter: a concise markdown summary of what was done and the outcome; it overwrites any previous summary.",
  "A note id is required for complete/reopen/update; call list first if you don't have one.",
].join(" ");

/** 面向模型的单条记录摘要行。 */
function formatNote(note: MemoNote): string {
  const parts = [
    `id: ${note.id}`,
    `type: ${note.type}`,
    `status: ${note.status}`,
    `title: ${note.title}`,
  ];
  if (note.tags.length) parts.push(`tags: ${note.tags.map((tag) => `#${tag}`).join(" ")}`);
  if (note.workspaceHint) parts.push(`workspace: ${note.workspaceHint}`);
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: MEMO_TOOL_NAME,
    label: "PiAbyss memo",
    description: TOOL_DESCRIPTION,
    promptSnippet: "List and update the user's memo notes (mark done after handling)",
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
          return {
            content: [
              {
                type: "text" as const,
                text: `Memo note ${note.title} is now done; summary recorded.`,
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
