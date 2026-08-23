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
  type Task,
  type TodoDetails,
  type TodoParams,
  type TodoState,
} from "../src/todo-state.js";

export const TODO_TOOL_NAME = "todo";

const TodoParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("delete"),
    Type.Literal("clear"),
  ]),
  subject: Type.Optional(Type.String({ description: "Task subject (required for create)" })),
  description: Type.Optional(Type.String({ description: "Optional details describing the task" })),
  activeForm: Type.Optional(
    Type.String({ description: "Present-continuous label shown while the task is in_progress" }),
  ),
  status: Type.Optional(
    Type.Union(
      [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")],
      { description: "Task status for update" },
    ),
  ),
  id: Type.Optional(Type.Number({ description: "Task id (required for update, get, or delete)" })),
  includeDeleted: Type.Optional(
    Type.Boolean({ description: "For list, include deleted task records (default false)" }),
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
  return {
    content: [{ type: "text" as const, text: formatOperation(operation.operation, state, params) }],
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
      "Manage the agent's task list. Use it to track multi-step work. Actions: create, update, list, get, delete, clear. The task list is persisted in the session and shown by PiDeck.",
    promptSnippet: "Track multi-step work with the todo task list",
    promptGuidelines: [
      "Use todo for work with multiple implementation or research steps, and create the task list before starting those steps.",
      "Mark the task currently being worked on as in_progress, and mark it completed immediately after the work and its verification finish.",
      "Keep exactly one task in_progress when possible; do not mark incomplete or failing work as completed.",
      "Use todo list to refresh the current task list when you are unsure of task ids or status.",
      "Use todo update with id and status to change a task; use activeForm to describe the current activity while in_progress.",
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
