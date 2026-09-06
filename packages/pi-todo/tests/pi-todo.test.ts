import extension, {
  __replayTodoStateForTests,
  TODO_TOOL_NAME,
} from "../extensions/pi-todo.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function jsonEqual(actual: unknown, expected: unknown, message: string): void {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

type TodoTool = {
  name: string;
  executionMode: string;
  execute: (...args: unknown[]) => Promise<{
    content?: Array<{ type?: string; text?: string }>;
    details: { tasks: unknown[]; nextId: number };
  }>;
};

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
let todoTool: TodoTool | undefined;

const pi = {
  on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
    handlers.set(name, handler);
  },
  registerTool(definition: unknown) {
    todoTool = definition as TodoTool;
  },
};

extension(pi as never);
assert(todoTool, "todo tool was not registered");
equal(todoTool.name, TODO_TOOL_NAME, "tool name");
equal(todoTool.executionMode, "sequential", "tool execution mode");

const session = {
  id: "session-a",
  branch: [] as unknown[],
};
const context = {
  sessionManager: {
    getSessionId: () => session.id,
    getBranch: () => session.branch,
  },
};

await handlers.get("session_start")?.({}, context);
const created = await todoTool.execute("call-1", { action: "create", subject: "Create the adapter" }, undefined, undefined, context);
jsonEqual(created.details.tasks, [{ id: 1, subject: "Create the adapter", status: "pending" }], "created tasks");
equal(created.details.nextId, 2, "created next id");

session.branch.push({
  type: "message",
  message: { role: "toolResult", toolName: TODO_TOOL_NAME, details: created.details },
});
const restored = __replayTodoStateForTests(context);
jsonEqual(
  restored,
  {
    tasks: [{ id: 1, subject: "Create the adapter", status: "pending" }],
    nextId: 2,
  },
  "replayed state",
);

const updated = await todoTool.execute(
  "call-2",
  { action: "update", id: 1, status: "in_progress", activeForm: "Creating the adapter" },
  undefined,
  undefined,
  context,
);
const updatedTask = updated.details.tasks[0] as { status?: unknown; activeForm?: unknown };
equal(updatedTask.status, "in_progress", "updated status");
equal(updatedTask.activeForm, "Creating the adapter", "updated active form");

const otherSession = {
  sessionManager: {
    getSessionId: () => "session-b",
    getBranch: () => [],
  },
};
await handlers.get("session_start")?.({}, otherSession);
const otherList = await todoTool.execute("call-3", { action: "list" }, undefined, undefined, otherSession);
jsonEqual(otherList.details.tasks, [], "session isolation");

// plan writes the whole list in one call and the snapshot carries fresh ids
const planned = await todoTool.execute(
  "call-plan",
  {
    action: "plan",
    tasks: [{ subject: "Research auth requirements" }, { subject: "Implement login UI" }, { subject: "Wire the API" }],
  },
  undefined,
  undefined,
  context,
);
equal(planned.details.tasks.length, 3, "plan snapshot tasks");
equal(planned.details.nextId, 4, "plan snapshot next id");
jsonEqual(planned.details.tasks.map((task) => (task as { id: number }).id), [1, 2, 3], "plan assigns fresh ids");
assert(
  ((planned.content ?? [])[0] as { text?: string } | undefined)?.text?.startsWith("Planned 3 tasks:") === true,
  "plan summary text",
);
assert(!((planned.content ?? [])[0] as { text?: string }).text!.includes("Tip:"), "no hint on a 3-task plan");

// a single-task plan gets a correction hint in the result text
const singlePlan = await todoTool.execute(
  "call-plan-single",
  { action: "plan", tasks: [{ subject: "Do everything" }] },
  undefined,
  undefined,
  context,
);
assert(((singlePlan.content ?? [])[0] as { text?: string } | undefined)?.text?.includes("Tip:") === true, "single-task plan hint");

// plan snapshots restore through replay like every other action
session.branch.push({
  type: "message",
  message: { role: "toolResult", toolName: TODO_TOOL_NAME, details: singlePlan.details },
});
const replanned = __replayTodoStateForTests(context);
jsonEqual(replanned, { tasks: [{ id: 1, subject: "Do everything", status: "pending" }], nextId: 2 }, "replayed plan state");

console.log("pi-todo extension tests passed");
