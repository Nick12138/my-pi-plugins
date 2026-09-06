/**
 * Pure task state and mutation logic for pi-todo.
 *
 * The state is intentionally small. The complete post-operation snapshot is
 * returned by every tool call so PiDeck can project the latest task list and
 * Pi can reconstruct it after reload, compaction, or tree navigation.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "plan" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
}

export interface TodoState {
  tasks: Task[];
  nextId: number;
}

/** One entry of a whole-list plan write. Ids are assigned by the state, not by the caller. */
export interface PlanItem {
  subject: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
}

export interface TodoDetails {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
}

export interface TodoParams {
  action: TaskAction;
  subject?: string;
  tasks?: PlanItem[];
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  id?: number;
  includeDeleted?: boolean;
}

export type TodoOperation =
  | { kind: "create"; id: number }
  | { kind: "plan"; count: number }
  | { kind: "update"; id: number; from: TaskStatus; to: TaskStatus; changed: boolean }
  | { kind: "list"; count: number }
  | { kind: "get"; id: number }
  | { kind: "delete"; id: number }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

export interface MutationResult {
  state: TodoState;
  operation: TodoOperation;
}

export const EMPTY_STATE: TodoState = { tasks: [], nextId: 1 };

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted";
}

export function isTaskAction(value: unknown): value is TaskAction {
  return value === "create" || value === "plan" || value === "update" || value === "list" || value === "get" || value === "delete" || value === "clear";
}

export function cloneState(state: TodoState): TodoState {
  return {
    tasks: state.tasks.map((task) => ({ ...task })),
    nextId: state.nextId,
  };
}

function error(state: TodoState, message: string): MutationResult {
  return { state, operation: { kind: "error", message } };
}

function taskChanged(before: Task, after: Task): boolean {
  return (
    before.subject !== after.subject ||
    before.description !== after.description ||
    before.activeForm !== after.activeForm ||
    before.status !== after.status
  );
}

function nonBlank(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Apply one tool operation without mutating the input state. */
export function applyMutation(state: TodoState, params: TodoParams): MutationResult {
  switch (params.action) {
    case "create": {
      const subject = nonBlank(params.subject);
      if (!subject) return error(state, "subject required for create");

      const task: Task = {
        id: state.nextId,
        subject,
        status: "pending",
      };
      if (params.description !== undefined) task.description = params.description;
      if (params.activeForm !== undefined) task.activeForm = params.activeForm;

      return {
        state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 },
        operation: { kind: "create", id: task.id },
      };
    }

    case "plan": {
      // Whole-list write: one call replaces the plan and assigns fresh ids
      // 1..N, so planning a full multi-step list costs a single tool call.
      if (!Array.isArray(params.tasks)) return error(state, "tasks array required for plan");

      const tasks: Task[] = [];
      for (let index = 0; index < params.tasks.length; index++) {
        const raw: unknown = params.tasks[index];
        const item = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PlanItem>;
        const subject = nonBlank(item.subject);
        if (!subject) return error(state, `tasks[${index}] requires a non-blank subject`);
        if (item.status !== undefined && !isTaskStatus(item.status)) {
          return error(state, `tasks[${index}] has invalid status: ${String(item.status)}`);
        }

        const task: Task = { id: index + 1, subject, status: item.status ?? "pending" };
        if (item.description !== undefined) task.description = item.description;
        if (item.activeForm !== undefined) task.activeForm = item.activeForm;
        tasks.push(task);
      }

      return {
        state: { tasks, nextId: tasks.length + 1 },
        operation: { kind: "plan", count: tasks.length },
      };
    }

    case "update": {
      if (params.id === undefined) return error(state, "id required for update");
      const index = state.tasks.findIndex((task) => task.id === params.id);
      if (index < 0) return error(state, `#${params.id} not found`);
      const current = state.tasks[index]!;

      const hasMutation =
        params.subject !== undefined ||
        params.description !== undefined ||
        params.activeForm !== undefined ||
        params.status !== undefined;
      if (!hasMutation) {
        return error(state, "update requires at least one mutable field: subject, description, activeForm, or status");
      }

      if (params.status !== undefined) {
        if (!isTaskStatus(params.status)) return error(state, `invalid status: ${String(params.status)}`);
        if (params.status !== current.status && !VALID_TRANSITIONS[current.status].has(params.status)) {
          return error(state, `illegal transition ${current.status} → ${params.status}`);
        }
      }

      const updated: Task = { ...current };
      if (params.subject !== undefined) {
        const subject = nonBlank(params.subject);
        if (!subject) return error(state, "subject cannot be blank");
        updated.subject = subject;
      }
      if (params.description !== undefined) updated.description = params.description;
      if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
      if (params.status !== undefined) updated.status = params.status;

      const tasks = [...state.tasks];
      tasks[index] = updated;
      return {
        state: { tasks, nextId: state.nextId },
        operation: {
          kind: "update",
          id: updated.id,
          from: current.status,
          to: updated.status,
          changed: taskChanged(current, updated),
        },
      };
    }

    case "list":
      return {
        state,
        operation: {
          kind: "list",
          count: state.tasks.filter((task) => params.includeDeleted || task.status !== "deleted").length,
        },
      };

    case "get": {
      if (params.id === undefined) return error(state, "id required for get");
      if (!state.tasks.some((task) => task.id === params.id)) return error(state, `#${params.id} not found`);
      return { state, operation: { kind: "get", id: params.id } };
    }

    case "delete": {
      if (params.id === undefined) return error(state, "id required for delete");
      const index = state.tasks.findIndex((task) => task.id === params.id);
      if (index < 0) return error(state, `#${params.id} not found`);
      const current = state.tasks[index]!;
      if (current.status === "deleted") return error(state, `#${params.id} is already deleted`);
      const tasks = [...state.tasks];
      tasks[index] = { ...current, status: "deleted" };
      return { state: { tasks, nextId: state.nextId }, operation: { kind: "delete", id: params.id } };
    }

    case "clear":
      return {
        state: { tasks: [], nextId: 1 },
        operation: { kind: "clear", count: state.tasks.length },
      };
  }
}

export function visibleTasks(state: TodoState, includeDeleted = false): Task[] {
  return state.tasks.filter((task) => includeDeleted || task.status !== "deleted");
}

function formatTaskLines(state: TodoState, includeDeleted = false): string {
  return visibleTasks(state, includeDeleted)
    .map((task) => {
      const active = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
      return `[${task.status}] #${task.id} ${task.subject}${active}`;
    })
    .join("\n");
}

/**
 * Soft nudge for plan shapes that add bookkeeping without planning value.
 * Fires on create/plan when the visible list is exactly one still-pending
 * task, so the model gets a correction signal instead of silently keeping a
 * single umbrella task.
 */
export function operationHint(operation: TodoOperation, state: TodoState): string | undefined {
  if (operation.kind !== "create" && operation.kind !== "plan") return undefined;
  const visible = visibleTasks(state);
  if (visible.length !== 1 || visible[0]!.status !== "pending") return undefined;
  return "Tip: a single-task list adds tracking overhead without planning value. For multi-step work, call plan once with one task per step (typically 3-7); for simple work, skip todo.";
}

export function formatOperation(operation: TodoOperation, state: TodoState, params: TodoParams): string {
  switch (operation.kind) {
    case "create": {
      const task = state.tasks.find((item) => item.id === operation.id);
      return task ? `Created #${task.id}: ${task.subject} (pending)` : `Created #${operation.id}`;
    }
    case "update":
      return operation.changed
        ? operation.from === operation.to
          ? `Updated #${operation.id}`
          : `Updated #${operation.id} (${operation.from} → ${operation.to})`
        : `No change: #${operation.id} already matches the requested values (status: ${operation.to})`;
    case "list": {
      const includeDeleted = params.includeDeleted === true;
      return visibleTasks(state, includeDeleted).length === 0
        ? "No tasks"
        : formatTaskLines(state, includeDeleted);
    }
    case "plan":
      return operation.count === 0
        ? "Planned 0 tasks (list cleared)"
        : `Planned ${operation.count} tasks:\n${formatTaskLines(state)}`;
    case "get": {
      const task = state.tasks.find((item) => item.id === operation.id);
      if (!task) return `Error: #${operation.id} not found`;
      const lines = [`#${task.id} [${task.status}] ${task.subject}`];
      if (task.description) lines.push(`  description: ${task.description}`);
      if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
      return lines.join("\n");
    }
    case "delete": {
      const task = state.tasks.find((item) => item.id === operation.id);
      return task ? `Deleted #${task.id}: ${task.subject}` : `Deleted #${operation.id}`;
    }
    case "clear":
      return `Cleared ${operation.count} tasks`;
    case "error":
      return `Error: ${operation.message}`;
  }
}
