# pi-schedule 对接契约

> 本文是 **PiAbyss 侧（面板 / 协议 / 控制器）对接 pi-schedule 的接口说明**。
> 插件只负责调度与执行；界面、通知投递、工作区激活由 PiAbyss 决定。

- 包路径：`my-pi-plugins/packages/pi-schedule`
- 数据根：`~/.pi/schedule`（可用 `PI_SCHEDULE_DIR` 覆盖）
- 控制面：`http://127.0.0.1:18766`（可用 `PI_SCHEDULE_PORT` 覆盖）
- 生命周期：**pi 进程存活期间**调度（PiAbyss 关闭 → 不执行，符合既定需求）

---

## 一、两种对接方式（建议都用）

| 用途 | 方式 | 理由 |
|---|---|---|
| 列表、任务定义、执行记录、会话转录 | **直接读盘**（只读） | 数据天然持久化；与 `subagent-runs.ts` 的既有范式一致 |
| 创建/修改/删除/启停/立即执行/续聊 | **HTTP API** | 需要即时生效与校验反馈；文件轮询有延迟 |
| 通知（完成/失败） | **读盘** `notify-queue.jsonl` 或 `GET /api/notifications` | 插件写队列，面板消费并决定是否弹系统通知 |

**写盘边界（重要）**：`jobs.json` **只由插件写**。PiAbyss 不要直接改它——
并发写会丢更新（插件用 O_EXCL 锁保护自己的读改写，外部绕过锁会破坏该保证）。
所有修改走 HTTP。

---

## 二、目录布局

```
~/.pi/schedule/
├── jobs.json                        # 任务定义（唯一真相源，只由插件写）
├── runs/<jobId>/<runId>.json        # 单次执行元数据
├── sessions/<jobId>/<runId>.jsonl   # 单次执行的 pi 会话（实际文件名见下）
├── locks/<jobId>.lock               # 单飞锁（跨进程）
├── locks/jobs.lock                  # jobs.json 写锁
├── runs.jsonl                       # 追加型台账（保留最近 5000 行）
├── notify-queue.jsonl               # 通知队列（保留最近 500 条）
└── token                            # 控制面鉴权 token（0600）
```

> ⚠️ **会话文件名不要拼**：SDK 实际写的是 `<ISO时间戳带横线>_<sessionId>.jsonl`，
> 不是 `<runId>.jsonl`。请始终用 run 记录里的 `sessionPath` 字段（或 `GET /api/runs/:runId`）。

会话文件是**标准 pi session JSONL（v3）**，首个 header 行含 `cwd`，可直接用
`SessionManager.open(path)` / `session.fork` 打开或 fork。

---

## 三、数据格式

版本号在 `jobs.json` 的 `version` 字段（当前 `1`）。字段演进只做向后兼容新增。

### 3.1 `jobs.json`

```jsonc
{
  "version": 1,
  "jobs": [
    {
      "id": "a1b2c3d4",              // 8 位 hex
      "name": "安全审查",
      "prompt": "审查 src/ ...",      // 任务内容，运行时作为独立会话的任务书
      "cwd": "D:/proj/foo",          // 工作区绝对路径（执行会话的 cwd）
      "enabled": true,
      "permission": "read_only",     // read_only | write | full
      "model": { "provider": "5", "id": "deepseek-v4.1-flash", "thinkingLevel": "medium" }, // 或 null=用宿主默认
      "trigger": { "type": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai" },
      // 其余 trigger 形态：
      // { "type": "manual" }
      // { "type": "once", "at": "2026-01-01T09:00:00.000Z" }
      // { "type": "interval", "every": "30m" }
      "missedWindow": "catch_up_one", // catch_up_one | skip
      "timeoutMs": 1800000,
      "maxRuns": null,               // 数字 = 投递上限，到达后自动停用
      "loadExtensions": false,       // 执行会话是否加载扩展/技能
      "tags": [],
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "updatedBy": "piabyss",        // agent | piabyss | cli
      "nextRunAt": "2026-01-02T01:00:00.000Z",  // manual/已终止 → null
      "lastRunAt": null,
      "lastRunId": null,
      "lastStatus": null,            // running | ok | error | timeout | aborted
      "runCount": 0,                 // 已投递次数（ok+error+timeout；aborted 不计）
      "terminated": null             // null | "once" | "maxRuns" | "missed"
    }
  ]
}
```

### 3.2 `runs/<jobId>/<runId>.json`

```jsonc
{
  "runId": "2fa6a8c56cc8",
  "jobId": "a1b2c3d4",
  "jobName": "安全审查",
  "trigger": "manual",             // manual | once | interval | cron | reply
  "scheduledFor": null,            // 计划触发时刻（手动/续聊为 null）
  "startedAt": "...",
  "finishedAt": "...",             // running 时为 null
  "status": "ok",                  // running | ok | error | timeout | aborted
  "cwd": "D:/proj/foo",
  "model": { "provider": "5", "id": "deepseek-v4.1-flash" },  // 实际使用的模型
  "permission": "read_only",
  "tools": ["read", "grep", "find", "ls"],   // full 档记 ["*"]
  "sessionId": "01a0aa...",        // 与 sessionPath 对应的会话 id（不要拼接路径，用 sessionPath）
  "sessionPath": "C:/Users/.../sessions/a1b2c3d4/2026-...jsonl",
  "forkOf": null,                  // 续聊时指向源 runId
  "replyText": null,               // 续聊时用户的追问原文
  "usage": { "input": 1713, "output": 54, "total": 1767, "cost": 0 },
  "summary": "首段输出摘要（≤2000 字）",
  "outputText": "最后一条 assistant 文本（≤20000 字）",
  "toolCalls": 2,
  "error": null,                   // 失败原因（模型 451/超时/越权等）
  "idempotencyKey": "a1b2c3d4:2026-01-02T01:00:00.000Z"
  // 排期触发为 <jobId>:<scheduledFor>；手动/续聊为 <jobId>:<runId>。
  // 仅作审计/外部去重提示（单飞去重由 job 锁负责，本键不参与内部判定）。
}
```

### 3.3 `notify-queue.jsonl`

```jsonc
{ "at": "...", "jobId": "...", "jobName": "...", "runId": "...",
  "status": "error", "level": "error", "title": "定时任务「X」失败", "message": "..." }
```

只保留最近 500 条。面板按 `at` 做游标即可增量消费。

---

## 四、HTTP API

基址 `http://127.0.0.1:18766/api`。全部返回 JSON；错误为 `{ "error": "..." }`。

### 鉴权（必读）

除 `GET /api/health` 外，**所有接口都需要 token**：

1. token 位于 `~/.pi/schedule/token`（首次启动自动生成，权限 0600）；也可用 `PI_SCHEDULE_TOKEN` 指定。
2. 传递方式：请求头 `X-Pi-Schedule-Token: <token>`。**写操作（POST/PATCH/DELETE）必须用头部**；
   `?token=` 仅对只读 GET 有效（写走 query 会被当作 CORS「简单请求」绕过预检，属 CSRF 面）。
3. 缺少/错误 → `401`。
4. 带 body 的写请求必须声明 `Content-Type: application/json`，否则 `400`。
5. 插件**不下发 CORS 头**，因此浏览器里的跨源页面读不到响应；PiAbyss 是同机本地客户端，不受影响。
6. `Host` 头必须是回环地址（`127.0.0.1` / `localhost` / `[::1]`），否则 `403`（防 DNS rebinding）。

### 状态码

- 参数校验失败 → `400`；Token 不对/缺失 → `401`；Host 非回环 → `403`；
  目标不存在 → `404`；**单飞冲突（同一任务正在执行）→ `409`**。
- 针对具体任务的操作（`PATCH/DELETE/GET /jobs/:id`、`enable/disable`、`run_now`、`/jobs/:id/runs`）
  在任务不存在时一律 `404`。
- `/runs/:runId/reply` 若该 run 没有可续聊的会话文件 → `409`。

### `GET /api/health`（免 token）

返回 `{ ok, root, port, activeJobs, tickMs, maxConcurrent }`，不泄露任务内容/密钥。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活 + 数据根 + 调度器状态（activeJobs/tickMs/maxConcurrent） |
| GET | `/jobs` | 任务列表（含 activeJobs） |
| POST | `/jobs` | 创建任务（body 见下） |
| GET | `/jobs/:id` | 单任务 + 可读描述 |
| PATCH / POST | `/jobs/:id` | 修改（部分字段即可） |
| DELETE | `/jobs/:id?purge=1` | 删除（purge=1 同时清理 runs/sessions） |
| POST | `/jobs/:id/enable` \| `/disable` | 启停（enable 会清除终止标记并重排） |
| POST | `/jobs/:id/run_now` | 立即执行（**同步等待**，body 可带 permission/timeoutMs） |
| GET | `/jobs/:id/runs?limit=` | 该任务的执行历史（RunSummary） |
| GET | `/runs?limit=` | 全部执行历史（倒序） |
| GET | `/runs/:runId` | 执行详情（完整 RunRecord） |
| GET | `/runs/:runId/transcript` | 会话转录（`{ entries: [{id, role, text, at}] }`，末尾 200 条） |
| POST | `/runs/:runId/reply` | **续聊**：`{ text }` → fork 该 run 的会话再执行，返回新 run |
| GET | `/ledger?limit=` | 台账（fire/skip/lock/terminate/error/reply） |
| GET | `/notifications?limit=` | 通知队列 |
| GET | `/cron/validate?cron=&timezone=` | `{ valid, reason }`，用于表单实时校验 |

### 创建任务请求体

```jsonc
{
  "name": "安全审查",
  "prompt": "审查 src/ ...",
  "cwd": "D:/proj/foo",
  "trigger": { "type": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai" },
  "permission": "read_only",
  "model": { "provider": "5", "id": "deepseek-v4.1-flash", "thinkingLevel": "medium" },
  "missedWindow": "catch_up_one",
  "timeoutMs": 1800000,
  "maxRuns": null,
  "loadExtensions": false,
  "tags": ["安全"],
  "enabled": true,
  "by": "piabyss"          // 审计用，落进 updatedBy
}
```

### `run_now` 与 `reply` 是「长请求」

两者默认**等这次执行跑完**再返回（可能几十秒到 `timeoutMs`；HTTP 无内建等待上限）。
面板应对它们设置足够超时（建议 ≥ 5 分钟）并显示"执行中"，或者改为轮询 `/runs/:runId`。
工具侧有非阻塞选项：`schedule(action:"run_now", wait:false)` 立即返回。

> 并发上限（默认 2）只约束**定时扫描**发起的执行；`run_now`/`reply` 是显式操作，不受该上限限制。
> 同一任务的单飞锁对两者都生效（不会并发跑同一个任务）。

---

## 五、agent 侧接口

插件同时注册 `schedule` 工具，供 agent 在对话里建任务。动作：
`create / list / get / update / cancel / enable / disable / run_now / history / reply / status`。
与 HTTP 走同一套服务层校验，行为一致。详见 `skills/schedule/SKILL.md`。

---

## 六、执行语义（必须知道的行为）

1. **每次执行 = 一个独立会话文件**，不进入用户当前对话；历史可读、可 fork 续聊。
2. **权限是结构性的**：白名单直接传给会话创建接口，越权工具不存在，不靠 prompt 约束。
   - `read_only` → `read, grep, find, ls`
   - `write` → 上面 + `edit, write`（仍无 `bash`）
   - `full` → 不限制
3. **超时**：默认 30 分钟（`timeoutMs`，5s–6h）。超时会 abort 并把状态记为 `timeout`。
4. **单飞**：同一任务的上一次执行未结束时，本次触发被跳过（记 `lock` 台账），
   排期照常推进，不会堆积。
5. **并发**：同进程内最多 2 个执行会话同时跑（`DEFAULTS.maxConcurrentRuns`）。
6. **错过窗口**：`catch_up_one` 补跑一次；`skip` 在宽限期（interval：`max(2×tick, 25%周期)`
   上限 15 分钟；cron：1 小时）之外只推进排期不发车。
7. **模型**：任务显式指定但解析不到 → 直接失败并记 error（**不静默换模型**）。
8. **失败判定**：模型返回 `stopReason=error`（如 451/429/网络错误）会被识别为 `error`，
   不会误报成功。
9. **`aborted` 不计入 `runCount`**；`once` 跑完即终止；`maxRuns` 到顶自动停用。
10. **错过窗口且无法推进**（典型：`once` 已过期 + `missedWindow:"skip"`）：任务直接
    终止（`terminated:"missed"`），而不是反复重写文件——这曾经是个自持写入死循环。
11. **节拍**：`interval` 的下次触发从**原计划时刻**推进（不是从本次结束时刻），
    因此长任务不会让整体节拍漂移。
12. **DST**：cron 遇到不存在的本地时刻（如纽约春季 02:30）时，按迭代收敛到的
    实际时刻触发（可能偏移到 01:30 或 03:30），不跳过。
13. **保留策略**：`runs.jsonl` 保留最近 5000 行；每任务最多保留 300 个 run 文件；
    通知队列保留最近 500 条。
14. **通知策略**：所有终态都进 `notify-queue.jsonl`（面板自行决定弹什么）；
    但**进会话的消息**只发「失败类」或「用户主动触发（run_now/reply）」——
    高频成功轮询保持安静（自定义消息会进入 LLM 上下文，不能刷屏）。

---

## 七、配置项（环境变量）

`pi` 启动时以环境变量注入（PiAbyss 的插件配置机制可直接复用）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_SCHEDULE_DIR` | `~/.pi/schedule` | 数据根 |
| `PI_SCHEDULE_PORT` | `18766` | HTTP 端口 |
| `PI_SCHEDULE_TICK_MS` | `30000` | 扫描间隔（最小 1000） |
| `PI_SCHEDULE_TZ` | 系统时区 | 默认时区（cron 未指定 timezone 时；**任务自带 timezone 优先**） |
| `PI_SCHEDULE_TOKEN` | 自动生成 | HTTP 控制面鉴权 token（不设则写入 `<root>/token`） |

---

## 八、给 PiAbyss 的实现建议（按现有代码范式）

1. **协议层**（`packages/protocol`）：新增 `schedule.*` 方法，`HostContext`；
   或更省事——Host 侧直接做 HTTP 代理（参考 `subagent-api.ts` 的 `node:http` 直连，
   绕开 fetch 代理问题），前端只调用 `schedule.*` 一个薄方法。
   **代理时必须带上 `X-Pi-Schedule-Token`**（读 `~/.pi/schedule/token`，或环境变量 `PI_SCHEDULE_TOKEN`），
   否则所有接口返回 401。
2. **Host 侧**：新增 `packages/pi-host/src/schedule-*.ts`，
   - HTTP 客户端（控制）；
   - 读盘投影（列表/历史/转录，参考 `subagent-runs.ts` 的有界截断常量）；
   - 通知桥：轮询 `notify-queue.jsonl` → `server.emit("schedule.notification")` → 前端 toast / 系统通知。
3. **前端**：RightDock 新增 tab（`DockTabId` 加 `"schedule"`）或顶级 page。
   - 表单：name / prompt / cwd / trigger（四选一）/ permission / model / missedWindow / timeout / maxRuns
   - 列表：状态、下次触发倒计时、最近结果、启停/立即执行
   - 历史：run 列表 → 展开转录 → 「继续」按钮调 `/runs/:runId/reply`
4. **模型选择器**：可直接用 Host 已有的 `provider.*` 模型列表，或让插件返回
   `/health`…（当前未提供 models 列表接口，若需要可加 `GET /api/models`）。

---

## 九、当前范围与已知限制

- 无 OS 守护进程：pi 不在跑就不执行（既定设计）。
- 无 `GET /api/models`（面板可先用宿主模型列表）。
- `notify-queue.jsonl` 无 ack 机制（按 `at` 游标消费；保留 500 条）。
- 执行会话默认不加载扩展/技能（`loadExtensions:true` 可开）。
- HTTP 仅监听 `127.0.0.1` + token 鉴权 + 回环 Host 校验；**不要**把端口暴露到外部网络。
- 通知只投递给「最近活跃会话」（多会话宿主下的取巧策略）；面板应以队列为准。
- ⚠️ `permission:"full"` 让任务能跑任意命令，且执行会话会读到工作区内**不可信内容**
  （被审查的仓库/README 可含注入指令）。无人值守场景请默认用 `read_only`。
