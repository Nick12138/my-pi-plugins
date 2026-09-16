# pi-schedule

给 pi agent 的**定时任务**插件：cron / 周期 / 一次性 / 仅手动触发。

每次执行都在**一个独立的新会话**里跑完——不污染你当前的对话，
历史独立保存，且可以**在任意一次历史基础上 fork 续聊**（源记录只读不改）。

## 能力

| 能力 | 说明 |
|---|---|
| 触发方式 | `cron`（5 段表达式，支持时区与 DST）/ `interval`（30m、2h、1d）/ `once`（绝对时刻）/ `manual`（仅手动） |
| 独立会话 | 每次执行 = `sessions/<jobId>/<runId>.jsonl`，标准 pi 会话文件 |
| 历史与续聊 | run 记录 + 会话转录；`reply` 用 fork 语义继续（源文件不变） |
| 选模型 | 每个任务可指定 `provider/id:thinking`；不指定用宿主默认；指定但不可用则**失败**而不是静默换模型 |
| 按工作区 | 每个任务绑定 `cwd`（执行会话的工作目录） |
| 三档权限 | `read_only` / `write` / `full` → 结构性工具白名单（不是靠 prompt 措辞） |
| 有界执行 | `timeoutMs` 超时中止；`maxRuns` 到达上限自动停用；`once` 跑完即止 |
| 错过窗口 | `catch_up_one`（补一次）或 `skip`（过期放弃） |
| 单飞与并发 | 同任务单飞锁（不重复触发）；同进程并发上限 2 |
| 可靠性 | 原子写 + O_EXCL 锁 + 追加型台账 + 损坏文件隔离 + 幂等键 |
| 面板对接 | 文件即真相源 + 本地 HTTP 控制面（见 [docs/CONTRACT.md](docs/CONTRACT.md)） |

## 安装

```bash
pi install git:github.com/Nick12138/my-pi-plugins   # 整仓安装后再用 pi config 开关
# 或只装本插件（settings.json 对象形式 + 路径过滤）
# { "source": "git:github.com/Nick12138/my-pi-plugins",
#   "extensions": ["packages/pi-schedule/extensions/**"] }
```

## 快速使用（对 agent 说）

```
每天早上 9 点审查一次 src/ 的安全问题
每 5 分钟轮询一次 CI，失败就分析（要跑 gh 命令）
30 分钟后提醒我起身活动
```

agent 会调用 `schedule` 工具建任务；也可以直接调工具：

```text
schedule(action:"create", name:"安全审查", trigger:"cron", cron:"0 9 * * 1-5",
         cwd:"D:/proj/foo", permission:"read_only",
         prompt:"审查 src/ 的安全问题…无发现回复 No findings")

schedule(action:"list")
schedule(action:"run_now", id:"a1b2c3d4")
schedule(action:"history", id:"a1b2c3d4", limit:5)
schedule(action:"reply", runId:"2fa6a8c56cc8", text:"继续分析第 3 条")
```

## HTTP 控制面

`http://127.0.0.1:18766/api`（`PI_SCHEDULE_PORT` 可改）。

> 除 `GET /api/health` 外都需鉴权：token 在 `~/.pi/schedule/token`（首次启动自动生成），
> 通过 `X-Pi-Schedule-Token` 头传入。不下发 CORS 头（防跨源页面打本地端口）。

`/jobs`、`/jobs/:id/run_now`、`/runs/:runId/reply`、`/cron/validate` 等，
完整清单见 [docs/CONTRACT.md](docs/CONTRACT.md)。

## 数据目录

`~/.pi/schedule`（`PI_SCHEDULE_DIR` 可改）：

```
jobs.json                        任务定义（只由本插件写）
runs/<jobId>/<runId>.json        执行元数据
sessions/<jobId>/*.jsonl         执行会话（可 fork 续聊；文件名用 run 记录的 sessionPath）
runs.jsonl                       台账（保留最近 5000 行）
notify-queue.jsonl               通知队列（保留最近 500 条）
token                            控制面鉴权 token
locks/                           单飞锁 / 写锁
```

## 边界

- 只在 **pi 进程存活期间**调度（pi/PiAbyss 关闭就不跑）。
- 执行会话默认**不加载扩展/技能**（`loadExtensions:true` 可开），更轻、更确定。
- 需要跑命令（git/npm/gh/脚本）的任务必须 `permission:"full"`。

## 开发

```bash
node --test "packages/pi-schedule/test/*.test.ts"      # 单测（44 个，零 LLM 调用）
node packages/pi-schedule/test/smoke.e2e.mjs         # 端到端冒烟：真跑一次 + fork 续聊
node packages/pi-schedule/test/smoke.http.mjs        # HTTP 控制面冒烟（18 项）
```

冒烟脚本会用真实模型，需先配好可用 provider（可用 `PI_SCHEDULE_SMOKE_MODEL=provider/id` 指定）。

## 许可

MIT
