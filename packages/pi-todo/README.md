# pi-todo

轻量级的 Pi Agent 任务列表插件，专为 PiDeck 等外部界面读取而设计。

## 设计目标

- 任务完全由 AI Agent 通过 `todo` 工具维护。
- 提供 `plan` 批量 action：一次调用写入整个任务列表（对齐模型“todo = 整表规划”的既有习惯），让细粒度拆分成为成本最低的行为。
- 单任务伞计划会被软纠正：create/plan 后列表只剩一个 pending 任务时，结果文本附加 Tip 提示拆分或不用 todo。
- 每次调用返回完整的 `details.tasks` 和 `details.nextId` 快照。
- session reload、compaction、tree navigation 后从当前 branch 恢复任务。
- 按 session 隔离任务状态，避免并行 session 相互覆盖。
- 不包含终端 overlay、`/todos` 命令、快捷键、配置文件、国际化或其他 UI。

## 工具

```ts
todo({
  action: "create" | "plan" | "update" | "list" | "get" | "delete" | "clear",
  subject?: string,
  tasks?: Array<{ subject, description?, activeForm?, status? }>,
  description?: string,
  activeForm?: string,
  status?: "pending" | "in_progress" | "completed" | "deleted",
  id?: number,
  includeDeleted?: boolean,
})
```

关键 action：

- `plan`：一次调用写入完整列表（`tasks` 数组，自动分配 id 1..N，空数组 = 清空）。修改计划时重发完整列表并保留各任务当前 `status`；`create` 仅用于追加单个任务。
- 其余 action 语义不变。

任务字段：

```ts
{
  id: number,
  subject: string,
  description?: string,
  activeForm?: string,
  status: "pending" | "in_progress" | "completed" | "deleted"
}
```

工具结果的持久化协议：

```ts
{
  content: [{ type: "text", text: "..." }],
  details: {
    action: "create" | "plan" | "update" | "list" | "get" | "delete" | "clear",
    params: { /* 本次调用参数 */ },
    tasks: Task[],
    nextId: number,
    error?: string,
  },
}
```

PiDeck 适配时读取当前 session 中最后一条 `toolName === "todo"` 且包含完整 `details.tasks` 的 tool result 即可。

## 安装

本插件注册的工具名是 `todo`。安装前请停用 `@juicesharp/rpiv-todo` 或其他同名 todo 插件，避免两个插件同时注册同一个工具。

单独安装本包，或通过仓库根目录的插件清单安装：

```text
repo: packages/pi-todo
```
