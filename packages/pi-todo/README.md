# pi-todo

轻量级的 Pi Agent 任务列表插件，专为 PiDeck 等外部界面读取而设计。

## 设计目标

- 任务完全由 AI Agent 通过 `todo` 工具维护。
- 每次调用返回完整的 `details.tasks` 和 `details.nextId` 快照。
- session reload、compaction、tree navigation 后从当前 branch 恢复任务。
- 按 session 隔离任务状态，避免并行 session 相互覆盖。
- 不包含终端 overlay、`/todos` 命令、快捷键、配置文件、国际化或其他 UI。

## 工具

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",
  subject?: string,
  description?: string,
  activeForm?: string,
  status?: "pending" | "in_progress" | "completed" | "deleted",
  id?: number,
  includeDeleted?: boolean,
})
```

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
    action: "create" | "update" | "list" | "get" | "delete" | "clear",
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
