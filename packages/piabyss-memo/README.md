# piabyss-memo

把 PiAbyss 内置工具 `piabyss_memo` 外移为 pi 插件：让 agent 直接操作用户的
方寸间（原「备忘录」；定位：待办 · 速记 · 备忘 · 收集）看板
（list / complete / reopen / update），与 PiAbyss 桌面端方寸间页面共用同一份
磁盘数据。v2 起把云同步的 **Cloudflare R2 引擎** 也收进插件自持
（`piabyss_memo_sync` 工具 + 本地控制面），不再依赖 PiAbyss Host 内置的
同步引擎。v0.3.0 起取消记录类别（备忘 / 想法 / 任务），旧数据的 type 字段
读盘时自动剔除。v0.4.0 新增**计划功能**（一次性截止 + 周期规则）并把状态
收敛为三种（详见下文）。

## 功能

- `list`：列出全部记录（id / 状态 / 标题 / 标签 / 截止 / 周期 / 下一轮 /
  逾期标记 / 更新时间）。
- `complete`：把某条记录标记为已完成，并**必须**提交 `result`（一段简洁的
  Markdown 总结），覆盖式写入记录的结果字段；同时捕获提交时的会话信息
  （sessionId / 会话文件路径 / 会话标题 / cwd），供桌面端「继续讨论」跳转。
  工具描述中内置了完成时机约束：任务未产出最终结果、仍在等待用户输入或
  用户决策时，不得调用 complete；用户会话中的手动指令优先级最高。
- `reopen`：把已完成的记录重新打开。
- `update`：修改记录的标题 / 正文 / 标签 / **计划**（dueAt / recurrence）。
- 以上任一变更后，云同步引擎会防抖触发 autoSync（开启且已配置时）。

## 计划功能（v0.4.0）

记录可以携带两种计划：

- **一次性截止**（`dueAt`，epoch ms）：如「2026-10-12 13:00 前完成」；
- **周期规则**（`recurrence`）：如「每周一 13:00 处理一次」，结构化表达
  （daily / weekly / monthly + interval + weekdays / monthDay + time + tz
  + until + startDate，见 `src/recurrence.ts`），时刻计算在规则声明的
  IANA 时区内进行，不依赖设备本地时区（多设备同步不分歧）。

**周期记录的完成语义**（核心）：

- `complete` 对周期记录只终结**本轮**：记录总结、更新 `lastDoneAt`、把
  `nextDueAt` 滚到严格晚于当前时刻的下一个发生时刻（错过多轮直接跳到
  未来，skip 策略），`status` 保持 `open`——永远不会因为完成一轮而
  「死掉」；
- 周期到达 `until`（含端点）后，最后一次 complete 使记录自然终结为
  `done`（规则保留供追溯）；
- **停用周期** = update 传 `recurrence: null`（转普通记录，可正常完成）；
- update 直接把周期记录置 `done` 会被拒绝（防误操作）；同一次 update 里
  先清周期再置 done 则允许（明确表达「停用并完结」）；
- reopen 周期记录时 `nextDueAt` 为空则重算（如云端同步下来缺字段的记录）。

**状态收敛（v0.4.0）**：只有 `open / in_progress / done` 三种。v2 的
`archived` 已移除，读取旧数据（本地或云端）时自动迁移为 `done`；
「归档停用」语义改由「清除周期 + 正常完成」表达。

## 云同步（v2，插件自持）

同步策略与 pi-reimburse 一致、代码从 PiAbyss Host 的 `memo-sync.ts` 逐行
移植（云端键布局与老数据完全兼容，多设备无缝衔接）：

- 键布局（固定前缀）：`piabyss/memo/notes.json`、`piabyss/memo/images/<noteId>/<fileName>`；
- 逐条 LWW（updatedAt 新者胜）+ 删除墓碑传播（TTL 30 天，过期物理清除含云端对象）；
- 图片按内容指纹跳过重复上传；从云端补齐本地缺失图片；
- autoSync：备忘录每次变更后 5 秒防抖同步；进程启动后拉齐一次。

### 配置（密钥不进对话）

R2 连接信息与 autoSync 在 **PiAbyss「设置 → 插件 → PiAbyss 方寸间」的配置
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

桌面方寸间页的「测试连接 / 立即同步」按钮经 Host 的 `memo.testSync` /
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
      "title": "…",
      "contentMd": "…",
      "status": "open | in_progress | done",   // v0.4.0 起只有三种；旧数据 archived 读取时迁移为 done
      "tags": ["…"],
      "workspaceHint": null,
      "images": [],
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "sessionId": null,
      "completedAt": null,
      "result": null,          // complete 时写入 { resultMd, sessionId, sessionPath, sessionTitle, sessionCwd, at }，覆盖式更新
      "deletedAt": null,       // 软删除墓碑（TTL 30 天；由同步引擎在合并时物理清除）
      "dueAt": null,           // v0.4.0：一次性截止时刻（epoch ms）；null = 无
      "recurrence": null,      // v0.4.0：周期规则（见下）；null = 非周期记录
      "nextDueAt": null,       // v0.4.0：周期记录当前轮次应处理时刻（epoch ms）；非周期恒 null
      "lastDoneAt": null       // v0.4.0：周期记录最近一轮完成时刻；从未完成过为 null
    }
  ]
}
```

`recurrence` 的形状（`src/recurrence.ts` 为权威）：

```jsonc
{
  "frequency": "daily | weekly | monthly",
  "interval": 1,            // 每 N 天/周/月；缺省 1
  "weekdays": [1],           // weekly 必填：ISO 星期，1=周一 … 7=周日（去重升序）
  "monthDay": null,          // monthly 必填：每月几号（1..31；短月无此日则跳过该月）
  "time": "13:00",           // 发生当天时刻（24 小时制 HH:mm）
  "tz": "Asia/Shanghai",     // IANA 时区；缺省 Asia/Shanghai，绝不依赖设备本地时区
  "until": null,             // 周期终点（epoch ms，含端点）；null = 无限期
  "startDate": null          // interval 对齐锚点；null 时以记录 createdAt 为锚
}
```

**格式权威是 PiAbyss 原实现** `packages/pi-host/src/memo-store.ts`
（本插件的 `src/memo-store.ts` 逐行照搬其读写逻辑，v0.4.0 的计划字段与
状态迁移需桌面端同步适配，见 `HOST-ADAPTATION.md`）。桌面方寸间页面与本
插件的同步引擎共用该文件，任何字段写错都会让整个页面异常，因此：

- 写入始终走「临时文件 + rename」原子替换；
- 每次操作都从磁盘读后写回，无内存缓存（多实例安全）；
- 删除是软删除（`deletedAt` 墓碑），记录体保留供同步引擎传播删除；
  超过 30 天的墓碑由同步引擎在合并时物理清除（本地 + 云端）；
- 旧数据兼容统一走 `normalizeNoteDefaults`（本地读取与云端拉取共用）：
  可空字段缺失补 null、`archived` 迁移为 `done`、形状非法的 recurrence
  清为 null（防单条脏数据拖垮整个看板）、v0.3.0 之前写入的 `type` 类别
  字段自动剔除（不再落盘）；
- 云同步对计划字段零改动：LWW 整条覆盖天然携带新字段，旧版本设备写入的
  记录在拉取时同样经 `normalizeNoteDefaults` 补齐。

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
