# pi-todo

轻量级的 Pi Agent 任务列表插件，专为 PiDeck 等外部界面读取而设计。

## 设计目标

- 任务完全由 AI Agent 通过 `todo` 工具维护。
- 提供 `plan` 批量 action：一次调用写入整个任务列表（对齐模型“todo = 整表规划”的既有习惯），让细粒度拆分成为成本最低的行为。
- 单任务伞计划会被软纠正：create/plan 后列表只剩一个 pending 任务时，结果文本附加 Tip 提示拆分或不用 todo。
- 完成状态必须逐条提交：`plan` 只做规划/重排，不能把未完成的任务直接置为 `completed`（只能沿用列表里已存在的完成/删除状态）；一个任务做完就单独 `update` 它。这样每次调用都产生一个只勾掉一条的快照，PiDeck 才能在任务真正完成时勾选，而不是最后一次性全勾。
- 结果文本带下一步提示：多任务 plan 后指向首个任务的 `update`，某个任务完成后再指向下一个待办任务的 `update`，把“逐条循环”变成默认路径。
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

- `plan`：一次调用写入完整列表（`tasks` 数组，自动分配 id 1..N，空数组 = 清空）。用于开工规划和结构性重排；改计划时整表重发，`completed`/`deleted` 只能沿用当前列表里同 subject 任务的同名状态。想把某个任务勾掉，只能用 `update { id, status: "completed" }`（一次一个任务）；作废用 `delete { id }`。`create` 仅用于追加单个任务。
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
