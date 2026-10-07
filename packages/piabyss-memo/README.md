# piabyss-memo

把 PiAbyss 内置工具 `piabyss_memo` 外移为 pi 插件：让 agent 直接操作用户的
PiAyssey 备忘录看板（list / complete / reopen / update），与 PiAbyss 桌面端
备忘录页面共用同一份磁盘数据。

## 功能

- `list`：列出全部备忘录记录（id / 类型 / 状态 / 标题 / 标签 / 更新时间）。
- `complete`：把某条记录标记为已完成，并**必须**提交 `result`（一段简洁的
  Markdown 总结），覆盖式写入记录的结果字段；同时捕获提交时的会话信息
  （sessionId / 会话文件路径 / 会话标题 / cwd），供桌面端「继续讨论」跳转。
  工具描述中内置了完成时机约束：任务未产出最终结果、仍在等待用户输入或
  用户决策时，不得调用 complete；用户会话中的手动指令优先级最高。
- `reopen`：把已完成的记录重新打开。
- `update`：修改记录的标题 / 正文 / 标签。

## 磁盘路径与格式

数据落盘在 `<agentDir>/piabyss/memo/notes.json`（与 PiAbyss 内置实现同一
路径、同一格式）：

```jsonc
{
  "schemaVersion": 1,
  "notes": [
    {
      "id": "…",
      "type": "memo | idea | task",
      "title": "…",
      "contentMd": "…",
      "status": "open | in_progress | done | archived",
      "tags": ["…"],
      "workspaceHint": null,
      "images": [],
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "sessionId": null,
      "completedAt": null,
      "result": null,          // complete 时写入 { resultMd, sessionId, sessionPath, sessionTitle, sessionCwd, at }，覆盖式更新
      "deletedAt": null        // 软删除墓碑（TTL 30 天；插件不清扫，由 Host 侧 purge）
    }
  ]
}
```

**格式权威是 PiAbyss 原实现** `D:/我的项目/PiAbyss/packages/pi-host/src/memo-store.ts`
（本插件的 `src/memo-store.ts` 逐行照搬其读写逻辑）。桌面备忘录页面与同步
引擎共用该文件，任何字段写错都会让整个页面异常，因此：

- 写入始终走「临时文件 + rename」原子替换；
- 每次操作都从磁盘读后写回，无内存缓存（多实例安全）；
- 删除是软删除（`deletedAt` 墓碑），记录体保留供同步引擎传播删除；
  超过 30 天的墓碑由 Host 侧 `purgeDeleted` 物理清除；
- 旧数据缺 `result` / `deletedAt` / `sessionId` 字段时读入自动补齐为 null。

### agentDir 对齐（前置条件）

插件通过 pi 的 `getAgentDir()`（读环境变量 `PI_CODING_AGENT_DIR`，缺省
`~/.pi/agent`）定位数据目录。PiAbyss Host 若以 `--agent-dir=` 参数启动而
未设置 `PI_CODING_AGENT_DIR`，两边会指向不同目录，导致插件写到另一份
`notes.json`。因此 **PiAbyss 启动 agent 时必须把 agentDir 以环境变量
`PI_CODING_AGENT_DIR` 注入**（PiDeck 场景默认如此）。

## 安装

放进 pi 插件目录即可（`pi.extensions` 指向 `./extensions`）。运行时依赖
`@earendil-works/pi-coding-agent` 与 `typebox`（peerDependencies）。
