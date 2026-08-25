# pi-subagent

Windows 专用的 pi 子代理运行时：把任务委托给独立的子 pi 进程（独立上下文），**后台并行运行**，完成/失败后**自动回调主 agent**，并支持**子代理 ↔ 主代理的双向工具回调**（`contact_supervisor` / `subagent_supervisor`）。

> ⚠️ 仅支持 Windows（使用 taskkill 做进程暂停/恢复）。其他系统请勿安装。

## 功能

- **3 个角色**（markdown agent，不限制工具，靠 system prompt 区分）：
  | 角色 | 用途 |
  |---|---|
  | `scout` | 只读探索：摸清代码库/问题范围，输出压缩上下文摘要 |
  | `worker` | 执行实现：改代码、跑验证，列出改动清单 |
  | `reviewer` | 只读审查：正确性/测试/安全/简洁性审查报告 |
- **并行 + 队列**：同时运行 ≤ 并发上限（默认 10，可配），超出的自动排队（FIFO）
- **模型可控**：默认继承主 agent 的模型/thinking，可用配置指定，agent 调用时可覆盖
- **手动控制**：停止 / 暂停 / 继续 / 恢复（暂停用 `taskkill /SUSPEND`，Windows 独有能力）
- **失败可恢复**：模型报错不白做——会话与文件改动保留，自动重试（可配次数）+ 主 agent 可随时 resume 从断点继续
- **后台运行**：子进程 detached 独立进程组，主 pi 退出/重启不影响；重启后自动接管 + **补发**未通知的回调
- **回调**：完成/失败/停止时通知主 agent（不打断当前轮，空闲自动唤醒）
- **双向工具回调**（Nico pi-subagents 风格）：子代理可主动联系主代理要决策/结构化输入/报进度，并**阻塞等待回复**；主代理用 `subagent_supervisor` 工具回复。跨进程走**文件系统信箱**（`%TEMP%/pi-subagent-supervisor-channels/`），不依赖会话消息注入
- **Steering 运行中引导**：主代理可在子代理运行中发送引导消息（`subagent({action:"steer", runId, message, mode})`），子代理在下一安全点/回合边界收到并调整方向
- **预算与超时**：`maxRuntimeMs` 总超时、`turnBudget` 回合数上限、`toolTimeoutMs` 无输出卡死检测，超出自动终止防失控
- **模型自动回退**：`fallbackModels` 列表，主模型限流/超时/错误时自动换下一个续跑（同会话断点续跑）
- **subagent_wait**：主代理可阻塞等待子代理完成（`subagent_wait({runId?|all, timeoutMs})`），适合编排依赖关系
- **会话标题**：每个任务带标题，显示在列表与回调中
- **全量落盘**：原始 NDJSON 事件流（含思考内容、工具调用）+ 结果 + 会话文件，前端零丢失
- **worktree 隔离**（可选）：并行写文件的子代理在 git worktree 中运行，审查后一键 merge
- **HTTP API**（127.0.0.1）：供 PiDeck 右侧面板查看/停止

## 安装

```bash
pi install git:github.com/Nick12138/my-pi-plugins   # 全仓库安装后启用本插件
# 或通过 PiDeck 插件库卡片一键安装
```

## 配置（环境变量，PiDeck 配置界面自动生成）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SUBAGENT_MAX_CONCURRENCY` | `10` | 同时运行上限，超出自动排队 |
| `SUBAGENT_DEFAULT_MODEL` | 空（= inherit） | 子代理默认模型（`provider/id`，配置界面为下拉选择，选项与「视觉看图」同源）；留空/`inherit` = 继承主 agent |
| `SUBAGENT_RETRY` | `1` | 失败自动重试次数（0-3） |
| `SUBAGENT_HTTP_PORT` | `18765` | HTTP API 端口（PiDeck 面板用）。**可选，无需配置**：不设置时固定使用默认值 `18765`；仅当该端口被本机其他程序占用时才需要设置（改端口无需改代码/重启插件） |
| `SUBAGENT_FALLBACK_MODELS` | 空 | 全局默认回退模型列表（逗号分隔，如 `4/hy3-free,1/glm-5.2`）；任务参数 `fallbackModels` 优先 |
| `PI_SUBAGENT_SUPERVISOR_TIMEOUT_MS` | `600000` | 子代理等主代理回复的超时（毫秒） |

## 使用

```text
# 单任务：让 scout 探索代码
subagent(agent:"scout", task:"找出认证相关的所有入口", title:"认证探索")

# 多任务（自动排队并行）
subagent(tasks:[
  {agent:"scout", task:"审查数据库模型"},
  {agent:"reviewer", task:"审查当前的 diff"}
])

# 指定模型 / worktree 隔离 / 关闭自动重试
subagent(agent:"worker", task:"实现 xx", model:"openai/gpt-5", worktree:true, retry:0)

# 预算与超时 / 模型回退
subagent(agent:"worker", task:"长任务", maxRuntimeMs:600000, turnBudget:20, toolTimeoutMs:300000,
         fallbackModels:["4/hy3-free", "1/glm-5.2"])   # 主模型失败自动换下一个

# 模型回退优先级：任务 fallbackModels > 全局 SUBAGENT_FALLBACK_MODELS
# 回退流程：主模型 → fallbackModels[0..n] → 主 agent 继承模型（最终兜底）

# 运行中引导（steering）
subagent(action:"steer", runId:"run_xxx", message:"改用方案 B，并先读 plan.md", mode:"steer")

# 阻塞等待完成（编排依赖）
subagent_wait({all:true, timeoutMs:120000})
subagent_wait({runId:"run_xxx"})

# 查看 / 控制
subagent(action:"list")
subagent(action:"stop", runId:"run_xxx")
subagent(action:"pause", runId:"run_xxx")     # 暂停（进程挂起）
subagent(action:"continue", runId:"run_xxx")  # 继续
subagent(action:"resume", runId:"run_xxx")    # 失败后从断点恢复
subagent(action:"result", runId:"run_xxx")    # 查看完整输出
subagent(action:"merge", runId:"run_xxx")     # 合并 worktree 改动到主分支
```

手动命令：`/subagents`、`/subagent-stop <id>`、`/subagent-pause`、`/subagent-continue`、`/subagent-resume`、`/subagent-result`、`/subagent-merge`。

### Steering（主代理 → 运行中子代理）

主代理在子代理运行中发送引导消息（写 `%TEMP%/pi-subagent-supervisor-channels/<runId>-<agent>/steer/<id>.json`），子代理侧扩展轮询后通过 `pi.sendUserMessage(..., {deliverAs})` 注入为消息，并写 ack 确认：

```text
subagent({action:"steer", runId:"run_xxx", message:"改用方案 B", mode:"steer"})      # 中断当前执行投递
subagent({action:"steer", runId:"run_xxx", message:"完成后补充测试", mode:"follow_up"}) # 回合边界投递
subagent({action:"steer", runId:"run_xxx", message:"...", mode:"auto"})                # 自动
```

## 双向工具回调（子代理 ↔ 主代理）

子代理进程内自动注入 `contact_supervisor` 工具；主 agent 侧自动注册 `subagent_supervisor` 工具。跨进程消息走文件系统信箱（`%TEMP%/pi-subagent-supervisor-channels/<runId>-<agent>/` 下的 `requests/` 与 `replies/` 目录），双方进程解耦、无端口依赖。

### 子代理侧：`contact_supervisor`

子代理需要主代理时主动调用（工具会**阻塞等待回复**，默认 10 分钟超时）：

```text
contact_supervisor({
  reason: "need_decision",       # 需要决策/批准/澄清 → 阻塞等回复
  message: "方案 A 还是 B？我倾向于 A"
})

contact_supervisor({
  reason: "interview_request",   # 需要结构化输入
  message: "请提供发布清单",
  interview: { title: "发布清单", questions: ["版本号", "目标环境"] }
})

contact_supervisor({
  reason: "progress_update",     # 单向进度通知，不等待
  message: "UPDATE: 已完成后端模块"
})
```

- `need_decision` / `interview_request`：写请求文件后**轮询等待回复**（250ms 间隔），主代理回复后工具返回回复文本，子代理继续执行；超时抛错
- `progress_update`：写请求后立即返回 `Supervisor progress update queued.`

### 主代理侧：`subagent_supervisor`

子代理请求到达时主 agent 会被唤醒（`sendMessage` + `triggerTurn`，不打断当前轮）。主 agent 用工具回复：

```text
subagent_supervisor({ action: "pending" })                      # 列出待回复请求
subagent_supervisor({ action: "reply", replyTo: "<请求id>", message: "同意方案 A" })
subagent_supervisor({ action: "status" })                       # 通道状态
```

工具直接扫描文件系统，不依赖内存状态（多进程实例下同样可靠）。

## HTTP API（PiDeck 面板）

绑定 `127.0.0.1:<port>`，支持 CORS。端口读取环境变量 `SUBAGENT_HTTP_PORT`（可选），**未设置时固定为默认值 `18765`**；如需更换端口，设置环境变量即可，例如 `SUBAGENT_HTTP_PORT=19000`。

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 + runs 根目录 |
| `GET /api/runs` | 子代理列表（状态/标题/角色/模型/耗时/输出预览） |
| `GET /api/runs/:id` | 单个 run 详情 |
| `GET /api/runs/:id/events?offset=N` | 原始事件流（增量读取；含思考内容、工具调用） |
| `GET /api/supervisor` | supervisor 通道诊断（started/timer/pending/sessionId/root） |
| `GET /api/runs/:id/result` | 最终结果（输出/用法统计） |
| `POST /api/runs/:id/stop` | 停止 |
| `POST /api/runs/:id/pause` / `continue` / `resume` | 控制 |

完整数据在 `~/.pi/subagent/runs/<runId>/`：`task.json`、`status.json`、`events.jsonl`（原始 NDJSON）、`result.json`、`sessions/`（pi 会话，恢复凭据）。

## 架构

```
主 pi（pi-subagent 扩展）
├─ subagent 工具 + subagent_supervisor 工具 + 命令 + 回调 + 启动接管 + HTTP API
├─ supervisor 轮询（500ms 扫 requests/，会话归属校验，唤醒主 agent）
└─ spawn(detached, 新进程组, stdout→events.jsonl, --extension supervisor-client.ts)
     └─ 子 pi（pi --mode json -p --session-id sub-<id> --name <标题>
          --exclude-tools subagent --append-system-prompt <角色.md> @prompt.md
          + contact_supervisor 工具（--extension））

跨进程信箱：%TEMP%/pi-subagent-supervisor-channels/<runId>-<agent>/
  ├─ requests/<uuid>.json   子代理 → 主代理（reason/message/expiresAt/orchestratorSessionId）
  └─ replies/<uuid>.json    主代理 → 子代理（subagent_supervisor 回复）
```

- **失败恢复**：子进程退出后，会话文件在 `sessions/`，重跑同一 `--session-id` 即续跑（上下文不丢）
- **主 pi 退出**：子进程继续（detached + 文件句柄）；重启后扫描 `runs/` 接管 running、补发未通知回调、重建 pending 队列
- **双向回调**：子代理通过环境变量（`PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` / `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` / `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_CHILD_AGENT`）获得通道位置与会话归属，写入请求文件后阻塞等回复

## 安全

- 子代理排除 `subagent` 工具（`--exclude-tools`），不能递归再开子代理
- 子代理默认 `--no-approve`（主项目受信任时 `--approve`）
- HTTP API 仅绑定回环地址
- supervisor 请求带 `orchestratorSessionId` 会话归属校验，其他会话的请求不会被处理
- 子代理可写/读的仅限自己的通道目录（`<runId>-<agent>`）；通道根目录在系统临时目录，过期请求自动清理
