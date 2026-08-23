import { applyMutation, EMPTY_STATE, formatOperation, type TodoState } from "../src/todo-state.js";

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

console.log("pi-todo state tests passed");
