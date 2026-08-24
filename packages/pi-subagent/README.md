# pi-subagent

Windows 专用的 pi 子代理运行时：把任务委托给独立的子 pi 进程（独立上下文），**后台并行运行**，完成/失败后**自动回调主 agent**。

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
| `SUBAGENT_DEFAULT_MODEL` | `inherit` | 子代理默认模型（`provider/id`）；`inherit` = 继承主 agent |
| `SUBAGENT_RETRY` | `1` | 失败自动重试次数（0-3） |
| `SUBAGENT_HTTP_PORT` | `18765` | HTTP API 端口（PiDeck 面板用） |

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

## HTTP API（PiDeck 面板）

绑定 `127.0.0.1:<port>`，支持 CORS：

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 + runs 根目录 |
| `GET /api/runs` | 子代理列表（状态/标题/角色/模型/耗时/输出预览） |
| `GET /api/runs/:id` | 单个 run 详情 |
| `GET /api/runs/:id/events?offset=N` | 原始事件流（增量读取；含思考内容、工具调用） |
| `GET /api/runs/:id/result` | 最终结果（输出/用法统计） |
| `POST /api/runs/:id/stop` | 停止 |
| `POST /api/runs/:id/pause` / `continue` / `resume` | 控制 |

完整数据在 `~/.pi/subagent/runs/<runId>/`：`task.json`、`status.json`、`events.jsonl`（原始 NDJSON）、`result.json`、`sessions/`（pi 会话，恢复凭据）。

## 架构

```
主 pi（pi-subagent 扩展）
├─ subagent 工具 + 命令 + 回调 + 启动接管 + HTTP API
└─ spawn(detached, 新进程组, stdout→events.jsonl)
     └─ 子 pi（pi --mode json -p --session-id sub-<id> --name <标题>
          --exclude-tools subagent --append-system-prompt <角色.md> @prompt.md）
```

- **失败恢复**：子进程退出后，会话文件在 `sessions/`，重跑同一 `--session-id` 即续跑（上下文不丢）
- **主 pi 退出**：子进程继续（detached + 文件句柄）；重启后扫描 `runs/` 接管 running、补发未通知回调、重建 pending 队列

## 安全

- 子代理排除 `subagent` 工具（`--exclude-tools`），不能递归再开子代理
- 子代理默认 `--no-approve`（主项目受信任时 `--approve`）
- HTTP API 仅绑定回环地址
