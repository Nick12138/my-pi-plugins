---
name: schedule
description: 'Create and manage scheduled agent tasks (cron / interval / once / manual). Each run executes in its OWN isolated session, so history is browsable and can be forked to continue. Use when the user says: 每天/每周/每小时、定时、计划任务、周期检查、定期审查、cron、提醒我、监控、轮询、"every day", "hourly", "daily at", "check periodically", "watch for", "remind me", "schedule".'
---

# Schedule — 定时任务

`pi-schedule` 提供 `schedule` 工具。**每次执行都是一个全新会话**：没有当前对话上下文，
所以任务 prompt 必须自包含；执行历史独立保存，可随时 fork 续聊。

## 触发方式（trigger）

| 想要 | 用 | 参数 |
|---|---|---|
| 只在用户手动点/你说的时侯跑 | `manual` | — |
| 某个绝对时刻跑一次，然后结束 | `once` | `at="2026-01-01T09:00:00+08:00"` |
| 固定间隔重复 | `interval` | `every="30m"` / `"2h"` / `"1d"`（最小 1m，最大 90d） |
| 墙钟时刻 / 复杂日程 | `cron` | `cron="0 9 * * 1-5"`（5 段：分 时 日 月 周），可加 `timezone` |

经验法则：**轮询/心跳用 interval；报告/审查用 cron**（`0 9 * * *` = 每天 9 点）。

## 权限（permission）—— 按任务**实际要跑什么**选

| 档位 | 能用 | 什么时候用 |
|---|---|---|
| `read_only`（默认） | read / grep / find / ls | 审查、扫描、总结、找问题 |
| `write` | 以上 + edit / write（**不能跑命令**） | 生成/修改文件、写报告 |
| `full` | 全部（含 `bash`） | 需要 git / npm / gh / 脚本 |

⚠️ 最大的坑：**任务里要跑 shell 命令就必须 `full`**。`read_only` 和 `write` 都不给 `bash`。
无人值守执行**不会弹窗确认**，越权工具在会话里根本不存在，所以选低了会直接失败。
默认用**够用的最低档**。

## 写 prompt（最关键的一步）

每次执行都是零上下文，prompt 就是全部任务书。检查表：

- **一句话目标**：这次运行要产出什么？
- **范围与输入**：哪些文件/包/命令？不要假设 cwd 或"之前聊的内容"。
- **期望输出**："给出 file:line 的发现列表"、"列出 当前版本→最新版本"。
- **约束**："只看 src/auth/"、"忽略 devDependencies"。
- **逃生口**：明确告诉它"没发现就回 `No findings`"，否则模型会为了显得有用而编造。

好的 prompt：
```
审查 src/auth/ 的代码安全问题（注入、鉴权绕过、泄露的密钥）。
用 file:line 列出具体发现。没有发现就精确回复 "No findings"。不要修改任何文件。
```

坏的 prompt：
```
看看我们之前说的那个东西修好了没
```

## 常用调用

```text
# 每个工作日 9 点做一次只读安全审查（cron + 项目工作区）
schedule(action:"create", name:"安全审查", trigger:"cron", cron:"0 9 * * 1-5",
  cwd:"D:/proj/foo", permission:"read_only",
  prompt:"审查 src/ 的安全问题...无发现回复 No findings")

# 每 5 分钟轮询一次（需要跑命令 → full）
schedule(action:"create", name:"CI轮询", trigger:"interval", every:"5m",
  permission:"full", prompt:"运行 gh run list --limit 1 ... 失败就分析原因，成功回复 无发现")

# 30 分钟后提醒一次，然后自动结束
schedule(action:"create", name:"提醒", trigger:"once", at:"2026-01-01T10:30:00+08:00",
  permission:"read_only", prompt:"用一句话提醒我：该起身活动了。")

# 指定模型 + 有界轮询（跑 10 次就停）
schedule(action:"create", name:"部署观察", trigger:"interval", every:"5m", maxRuns:10,
  model:"5/deepseek-v4.1-flash:medium", permission:"full", prompt:"...")

# 管理
schedule(action:"list")
schedule(action:"run_now", id:"a1b2c3d4")           # 立即跑一次（默认等结果）
schedule(action:"history", id:"a1b2c3d4", limit:5)  # 执行历史
schedule(action:"reply", runId:"...", text:"继续分析第 3 条")  # 在某次历史基础上续聊
schedule(action:"disable", id:"...") / (action:"enable", id:"...") / (action:"cancel", id:"...")
```

## 生命周期

- `once`：跑一次后自动停用（`terminated:once`）。
- `maxRuns=N`：投递满 N 次（成功+失败都算）后自动停用。
- 停用的任务可以 `enable` 恢复（会清除终止标记）。
- `missedWindow`（默认 `catch_up_one`）：pi 当时没开着导致错过窗口时，补跑一次；
  改成 `skip` 则过期就放弃（适合"过期就没意义"的轮询）。

## 边界

- 任务只在 **pi 进程存活期间**被调度（pi 关掉就不跑）。
- 需要扩展/技能的任务要 `loadExtensions:true`（默认关闭，执行更轻更确定）。
- 大量任务用 `tags` 分类，便于在面板里筛选。
