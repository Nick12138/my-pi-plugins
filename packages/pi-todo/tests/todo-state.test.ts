import { applyMutation, EMPTY_STATE, formatOperation, operationHint, type TodoState } from "../src/todo-state.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function jsonEqual(actual: unknown, expected: unknown, message: string): void {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function apply(state: TodoState, params: Parameters<typeof applyMutation>[1]): TodoState {
  const result = applyMutation(state, params);
  assert(result.operation.kind !== "error", "expected a successful operation");
  return result.state;
}

const created = applyMutation(EMPTY_STATE, { action: "create", subject: "  Inspect the repository  " });
jsonEqual(created.state.tasks, [{ id: 1, subject: "Inspect the repository", status: "pending" }], "create task");
equal(created.state.nextId, 2, "next id");
equal(formatOperation(created.operation, created.state, { action: "create" }), "Created #1: Inspect the repository (pending)", "create summary");

const active = apply(created.state, {
  action: "update",
  id: 1,
  status: "in_progress",
  activeForm: "Inspecting the repository",
});
equal(active.tasks[0]?.status, "in_progress", "active status");
equal(active.tasks[0]?.activeForm, "Inspecting the repository", "active form");

const completed = apply(active, { action: "update", id: 1, status: "completed" });
const illegal = applyMutation(completed, { action: "update", id: 1, status: "in_progress" });
equal(illegal.operation.kind, "error", "illegal transition");
equal(illegal.state.tasks[0]?.status, "completed", "failed mutation keeps state");

const deleted = apply(completed, { action: "delete", id: 1 });
equal(deleted.tasks[0]?.status, "deleted", "delete tombstone");
equal(applyMutation(deleted, { action: "list" }).operation.kind, "list", "list operation");
equal(formatOperation({ kind: "list", count: 0 }, deleted, { action: "list" }), "No tasks", "hidden tombstone");
assert(formatOperation({ kind: "list", count: 1 }, deleted, { action: "list", includeDeleted: true }).includes("[deleted] #1"), "included tombstone");

const invalidCreate = applyMutation(EMPTY_STATE, { action: "create", subject: "   " });
equal(invalidCreate.operation.kind, "error", "blank subject");
jsonEqual(invalidCreate.state, EMPTY_STATE, "failed create keeps state");

// plan: one call writes the whole list with fresh ids 1..N
const planned = applyMutation(EMPTY_STATE, {
  action: "plan",
  tasks: [
    { subject: "Research auth requirements" },
    { subject: "Implement login UI", activeForm: "Implementing login UI" },
    { subject: "Wire the API", status: "in_progress" },
  ],
});
equal(planned.operation.kind, "plan", "plan operation");
jsonEqual(
  planned.state.tasks,
  [
    { id: 1, subject: "Research auth requirements", status: "pending" },
    { id: 2, subject: "Implement login UI", status: "pending", activeForm: "Implementing login UI" },
    { id: 3, subject: "Wire the API", status: "in_progress" },
  ],
  "plan tasks",
);
equal(planned.state.nextId, 4, "plan next id");
assert(formatOperation(planned.operation, planned.state, { action: "plan" }).startsWith("Planned 3 tasks:"), "plan summary");

// plan replaces an existing list and preserves explicit statuses
const replanned = apply(
  planned.state,
  {
    action: "plan",
    tasks: [
      { subject: "Research auth requirements", status: "completed" },
      { subject: "Implement login UI", status: "in_progress", activeForm: "Implementing login UI" },
      { subject: "Wire the API" },
      { subject: "Write tests" },
    ],
  },
);
equal(replanned.tasks.length, 4, "replan replaces list");
equal(replanned.tasks[0]?.status, "completed", "replan keeps status");
equal(replanned.nextId, 5, "replan next id");

// plan with an empty array clears the list
jsonEqual(apply(replanned, { action: "plan", tasks: [] }), EMPTY_STATE, "empty plan clears");

// plan validation keeps state on failure
equal(applyMutation(EMPTY_STATE, { action: "plan" }).operation.kind, "error", "plan without tasks");
equal(applyMutation(EMPTY_STATE, { action: "plan", tasks: [{ subject: "  " }] }).operation.kind, "error", "plan blank subject");
const badStatusPlan = applyMutation(EMPTY_STATE, { action: "plan", tasks: [{ subject: "A", status: "done" }] });
equal(badStatusPlan.operation.kind, "error", "plan invalid status");
jsonEqual(badStatusPlan.state, EMPTY_STATE, "failed plan keeps state");

// single-task nudge: only fires on create/plan that leaves exactly one pending task
const hinted = applyMutation(EMPTY_STATE, { action: "create", subject: "Do everything" });
assert(operationHint(hinted.operation, hinted.state), "hint on single create");
const twoTasks = apply(hinted.state, { action: "create", subject: "Second task" });
equal(operationHint({ kind: "create", id: 2 }, twoTasks), undefined, "no hint with two tasks");
const oneTaskPlan = applyMutation(EMPTY_STATE, { action: "plan", tasks: [{ subject: "Do everything" }] });
assert(operationHint(oneTaskPlan.operation, oneTaskPlan.state), "hint on single-task plan");
const startedSingle = apply(oneTaskPlan.state, { action: "update", id: 1, status: "in_progress" });
equal(operationHint({ kind: "plan", count: 1 }, startedSingle), undefined, "no hint once in_progress");
equal(operationHint({ kind: "list", count: 1 }, oneTaskPlan.state), undefined, "no hint on other actions");

console.log("pi-todo state tests passed");
