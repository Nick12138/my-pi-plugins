# piabyss-memo

把 PiAbyss 内置工具 `piabyss_memo` 外移为 pi 插件：让 agent 直接操作用户的
PiAyssey 备忘录看板（list / complete / reopen / update），与 PiAbyss 桌面端
备忘录页面共用同一份磁盘数据。v2 起把备忘录的 **Cloudflare R2 云同步** 也
收进插件自持（`piabyss_memo_sync` 工具 + 本地控制面），不再依赖 PiAbyss
Host 内置的同步引擎。

## 功能

- `list`：列出全部备忘录记录（id / 类型 / 状态 / 标题 / 标签 / 更新时间）。
- `complete`：把某条记录标记为已完成，并**必须**提交 `result`（一段简洁的
  Markdown 总结），覆盖式写入记录的结果字段；同时捕获提交时的会话信息
  （sessionId / 会话文件路径 / 会话标题 / cwd），供桌面端「继续讨论」跳转。
  工具描述中内置了完成时机约束：任务未产出最终结果、仍在等待用户输入或
  用户决策时，不得调用 complete；用户会话中的手动指令优先级最高。
- `reopen`：把已完成的记录重新打开。
- `update`：修改记录的标题 / 正文 / 标签。
- 以上任一变更后，云同步引擎会防抖触发 autoSync（开启且已配置时）。

## 云同步（v2，插件自持）

同步策略与 pi-reimburse 一致、代码从 PiAbyss Host 的 `memo-sync.ts` 逐行
移植（云端键布局与老数据完全兼容，多设备无缝衔接）：

- 键布局（固定前缀）：`piabyss/memo/notes.json`、`piabyss/memo/images/<noteId>/<fileName>`；
- 逐条 LWW（updatedAt 新者胜）+ 删除墓碑传播（TTL 30 天，过期物理清除含云端对象）；
- 图片按内容指纹跳过重复上传；从云端补齐本地缺失图片；
- autoSync：备忘录每次变更后 5 秒防抖同步；进程启动后拉齐一次。

### 配置（密钥不进对话）

R2 连接信息与 autoSync 在 **PiAbyss「设置 → 插件 → PiAbyss 备忘录」的配置
表单**里填写，经 `pluginLibrary.setEnv` 注入环境变量（扩展与 Host 同进程，
保存即生效）：

| 环境变量 | 说明 |
| --- | --- |
| `PIABYSS_MEMO_R2_ACCOUNT_ID` | Cloudflare 账户 ID |
| `PIABYSS_MEMO_R2_ACCESS_KEY_ID` | R2 Access Key ID |
| `PIABYSS_MEMO_R2_SECRET_ACCESS_KEY` | R2 Secret Access Key（敏感，打码显示） |
| `PIABYSS_MEMO_R2_BUCKET` | R2 桶名 |
| `PIABYSS_MEMO_AUTO_SYNC` | `true` / `false`，变更后防抖自动同步 |

兼容回退：环境变量缺失时读旧版 `<agentDir>/piabyss/memo/sync-config.json`
里的同名字段（Host 内置同步时代的配置，老设备免重填）；`lastSync*` 状态
仍持久化在该文件。

### 本地控制面（127.0.0.1）

桌面备忘录页的「测试连接 / 立即同步」按钮经 Host 的 `memo.testSync` /
`memo.syncNow` 协议代理到插件的环回 HTTP 控制面（与 pi-schedule 同一模式）：

- 端口：`PIABYSS_MEMO_SYNC_PORT`（缺省 **18768**）；
- 鉴权：`X-Piabyss-Memo-Sync-Token` 头，token 在
  `<agentDir>/piabyss/memo/sync-token`（0600，首次自动生成）或
  `PIABYSS_MEMO_SYNC_TOKEN` 覆盖；
- 端点：`GET /api/health`（免鉴权）、`GET /api/status`（状态，不含密钥）、
  `POST /api/test`、`POST /api/sync`、`POST /api/auto-sync`
  （Host 在 memo.create/update/delete 落盘后通知引擎防抖同步）。

### agent 工具 `piabyss_memo_sync`

- `test`：用当前配置测一次连通性；
- `sync_now`：立即双向同步，返回统计；
- `status`：配置来源与最近同步状态。
- 密钥不在对话中传递：未配置时引导用户去 PiAbyss 设置的插件配置里填。

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
      "deletedAt": null        // 软删除墓碑（TTL 30 天；由同步引擎在合并时物理清除）
    }
  ]
}
```

**格式权威是 PiAbyss 原实现** `packages/pi-host/src/memo-store.ts`
（本插件的 `src/memo-store.ts` 逐行照搬其读写逻辑）。桌面备忘录页面与本
插件的同步引擎共用该文件，任何字段写错都会让整个页面异常，因此：

- 写入始终走「临时文件 + rename」原子替换；
- 每次操作都从磁盘读后写回，无内存缓存（多实例安全）；
- 删除是软删除（`deletedAt` 墓碑），记录体保留供同步引擎传播删除；
  超过 30 天的墓碑由同步引擎在合并时物理清除（本地 + 云端）；
- 旧数据缺 `result` / `deletedAt` / `sessionId` 字段时读入自动补齐为 null。

图片目录 `<agentDir>/piabyss/memo/images/<noteId>/<fileName>` 同样与
Host 共用；本插件 v2 补齐了 `hardRemove` / `readImageFile` /
`hasImageFile` / `writeImageFile`（同步引擎用）。

### agentDir 对齐（前置条件）

插件通过 pi 的 `getAgentDir()`（读环境变量 `PI_CODING_AGENT_DIR`，缺省
`~/.pi/agent`）定位数据目录。PiAbyss Host 若以 `--agent-dir=` 参数启动而
未设置 `PI_CODING_AGENT_DIR`，两边会指向不同目录，导致插件写到另一份
`notes.json`。因此 **PiAbyss 启动 agent 时必须把 agentDir 以环境变量
`PI_CODING_AGENT_DIR` 注入**（PiDeck 场景默认如此）。

## 安装

放进 pi 插件目录即可（`pi.extensions` 指向 `./extensions`，两个扩展文件：
`piabyss-memo.ts` 工具 + `piabyss-memo-sync.ts` 同步工具与控制面）。运行时
依赖 `@earendil-works/pi-coding-agent` 与 `typebox`（peerDependencies）。
