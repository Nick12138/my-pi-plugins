/**
 * pi-todo — a small, agent-only task state extension.
 *
 * Deliberately has no terminal widget, slash command, shortcut, config, or
 * localization. PiDeck reads the latest `details.tasks` snapshot from the
 * session transcript and owns the user-facing task UI.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyMutation,
  cloneState,
  EMPTY_STATE,
  formatOperation,
  isTaskAction,
  isTaskStatus,
  operationHint,
  type Task,
  type TodoDetails,
  type TodoParams,
  type TodoState,
} from "../src/todo-state.js";

export const TODO_TOOL_NAME = "todo";

const TodoParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("plan"),
    Type.Literal("update"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("delete"),
    Type.Literal("clear"),
  ]),
  subject: Type.Optional(Type.String({ description: "任务标题（create 必填）" })),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        subject: Type.String({ description: "任务标题" }),
        description: Type.Optional(Type.String({ description: "可选细节" })),
        activeForm: Type.Optional(
          Type.String({ description: "进行中显示名（present-continuous）" }),
        ),
        status: Type.Optional(
          Type.Union(
            [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")],
            { description: "初始状态，默认 pending。completed/deleted 只能沿用列表里已有的状态，不能靠 plan 新增完成或删除" },
          ),
        ),
      }),
      {
        description:
          "一次写全的任务表（plan 必填；空数组=清空）。plan 只用于规划/重排，完成状态必须逐个 update，不能批量提交。",
      },
    ),
  ),
  description: Type.Optional(Type.String({ description: "可选细节" })),
  activeForm: Type.Optional(
    Type.String({ description: "进行中显示名（present-continuous）" }),
  ),
  status: Type.Optional(
    Type.Union(
      [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")],
      { description: "任务状态（update 用）；每完成一个任务就单独调用一次，不要批量勾" },
    ),
  ),
  id: Type.Optional(Type.Number({ description: "任务 id（update/get/delete 必填）" })),
  includeDeleted: Type.Optional(
    Type.Boolean({ description: "含已删除记录（默认 false）" }),
  ),
});

type SessionIdentity = Pick<ExtensionContext["sessionManager"], "getSessionId">;

const states = new Map<string, TodoState>();

function sessionId(ctx: { sessionManager: SessionIdentity }): string {
  return ctx.sessionManager.getSessionId() || "";
}

function emptyState(): TodoState {
  return { tasks: [], nextId: EMPTY_STATE.nextId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id < 1) return null;
  if (typeof value.subject !== "string" || value.subject.trim().length === 0) return null;
  if (!isTaskStatus(value.status)) return null;

  const task: Task = {
    id: value.id,
    subject: value.subject,
    status: value.status,
  };
  if (typeof value.description === "string") task.description = value.description;
  if (typeof value.activeForm === "string") task.activeForm = value.activeForm;
  return task;
}

/** Validate and clone a persisted snapshot before putting it in live state. */
function stateFromDetails(value: unknown): TodoState | null {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return null;
  const nextId = value.nextId;
  if (typeof nextId !== "number" || !Number.isSafeInteger(nextId) || nextId < 1) return null;

  const tasks: Task[] = [];
  const ids = new Set<number>();
  for (const item of value.tasks) {
    const task = cloneTask(item);
    if (!task || ids.has(task.id)) return null;
    ids.add(task.id);
    tasks.push(task);
  }
  if (tasks.some((task) => task.id >= nextId)) return null;
  return { tasks, nextId };
}

function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
  let latest = emptyState();

  for (const entry of ctx.sessionManager.getBranch()) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;

    const snapshot = stateFromDetails(message.details);
    if (snapshot) latest = snapshot;
  }

  return latest;
}

function snapshotDetails(
  action: TodoParams["action"],
  params: TodoParams,
  state: TodoState,
  error?: string,
): TodoDetails {
  return {
    action,
    params: { ...params } as Record<string, unknown>,
    tasks: state.tasks.map((task) => ({ ...task })),
    nextId: state.nextId,
    ...(error ? { error } : {}),
  };
}

function resultFor(params: TodoParams, state: TodoState, operation: ReturnType<typeof applyMutation>) {
  const error = operation.operation.kind === "error" ? operation.operation.message : undefined;
  const hint = operationHint(operation.operation, state);
  return {
    content: [
      {
        type: "text" as const,
        text: formatOperation(operation.operation, state, params) + (hint ? `\n\n${hint}` : ""),
      },
    ],
    details: snapshotDetails(params.action, params, state, error),
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    states.set(sessionId(ctx), replayFromBranch(ctx));
  });

  pi.on("session_compact", async (_event, ctx) => {
    states.set(sessionId(ctx), replayFromBranch(ctx));
  });

  pi.on("session_tree", async (_event, ctx) => {
    states.set(sessionId(ctx), replayFromBranch(ctx));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    states.delete(sessionId(ctx));
  });

  pi.registerTool({
    name: TODO_TOOL_NAME,
    label: "Todo",
    description:
      "维护多步任务清单（≥3 步）。plan 一次写完整表（推荐起点），另有 create/update/list/get/delete/clear；清单存进会话并由 PiDeck 显示。每完成一个任务就用 update 把它置为 completed（一次一个），不要用 plan 批量提交完成状态。",
    promptSnippet: "多步任务清单（plan/update/list）",
    promptGuidelines: [
      "≥3 步的活开工时用 todo plan 一次写全表（每步具体可验证，通常 3-7 条，别合成一个大任务）；1-2 步的活不用 todo。",
      "同一时刻只留一个 in_progress：要开始某个任务前先 update 它为 in_progress。",
      "每做完并验证一个任务，立刻 update 这个任务 status=\"completed\"，再开始下一个。不要攒到最后用一次 plan 批量全勾——plan 也不允许把未完成的任务置为 completed，前端靠每次调用的快照逐条勾选。",
      "做完的活用 update 逐条勾掉；需要作废/取消的才用 delete（delete 不是完成，complete 也不是删除）。",
    ],
    parameters: TodoParamsSchema,
    // Mutations must not run concurrently: each call consumes the previous
    // nextId/state snapshot, and parallel execution could allocate duplicate ids.
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // TypeBox validates the action before execute. Keep this guard because
      // the extension API is also callable from tests and alternate hosts.
      if (!isTaskAction(params.action)) {
        const state = states.get(sessionId(ctx)) ?? emptyState();
        const invalid = { ...state, tasks: state.tasks.map((task) => ({ ...task })) };
        return {
          content: [{ type: "text" as const, text: `Error: invalid action ${String(params.action)}` }],
          details: snapshotDetails("list", { action: "list" }, invalid, `invalid action ${String(params.action)}`),
        };
      }

      const id = sessionId(ctx);
      const current = states.get(id) ?? emptyState();
      const operation = applyMutation(current, params as TodoParams);
      states.set(id, operation.state);
      return resultFor(params as TodoParams, operation.state, operation);
    },
  });
}

/** Test helpers intentionally kept private to the runtime surface. */
export function __resetTodoStateForTests(): void {
  states.clear();
}

export function __replayTodoStateForTests(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
  return cloneState(replayFromBranch(ctx));
}
