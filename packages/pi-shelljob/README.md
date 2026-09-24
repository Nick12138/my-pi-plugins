# pi-shelljob 后台 Shell

给 pi 加一个**后台可运行的 shell 任务**：可能跑很久的命令（构建、依赖安装、dev server、批量转换、大下载、全量测试）提交后台，立即返回不阻塞会话，完成/失败**自动通知**主 agent；短任务继续用同步 bash，各司其职。

## 工具

| 工具 | 说明 |
| --- | --- |
| `shelljob` | `submit`（默认）提交后台命令；`list` 列表；`log` 看输出尾部；`kill` 终止（杀整棵进程树） |
| `shell_wait` | 阻塞等待任务完成（单任务 / 本会话全部），支持超时与中止；超时后任务在后台继续 |

命令经由系统 shell 解释（Windows 为 cmd，Unix 为 sh），支持管道、重定向等一切 shell 语法。

## 使用边界（写进 promptGuidelines）

- **1-2 分钟内能结束**的任务（查文件、git 操作、装个小包、单测）→ 直接用**同步 bash**，不要提交后台。
- **可能跑很久**的任务（构建打包、完整依赖安装、dev server / 文件监听、批量转换、大下载、全量测试）→ 用 **shelljob 后台提交**。
- 判断不了时长时宁可用后台：提交立即返回，期间可继续其他工作，完成自动通知；只有确实需要结果才能继续下一步时才 `shell_wait` 阻塞等待。

## 特性

- **后台运行**：提交后立即返回，不阻塞会话；宿主正常退出任务继续跑（Windows 与终端窗口同生命周期，直接关窗口会终止任务，与 VS Code 任务行为一致）
- **完成自动通知**：终态按发起会话精准路由（多会话宿主安全），投递确认 + 批量合并 + 重启补发
- **全量落盘**：`~/.pi/shelljob/jobs/<id>/`（job.json / status.json / output.log），跨会话可查日志
- **实时落日志**：stdio 直接重定向到 output.log 文件句柄（非管道），长任务输出不会丢
- **进程树终止**：Windows `taskkill /T /F`；Unix 杀 detached 进程组（npm run 等派生的孙进程一并杀掉）
- **单任务超时**：`timeoutMs` 参数或全局默认，超时自动 kill 并标记 `failed/timedOut`
- **僵尸接管**：宿主重启后监控循环自动探测遗留任务，进程已消失的定 `interrupted`，超限的补杀
- **日志保护**：单任务 output.log 超过上限（默认 5MB）保护性 kill，防失控输出塞满磁盘

## 平台差异（重要）

| | Windows | Unix |
| --- | --- | --- |
| 进程模式 | 非 detached（CREATE_NEW_PROCESS_GROUP 下 cmd 不执行命令且静默返回 0，实测不可用） | `detached`（setsid 语义，完全脱离会话） |
| 日志采集 | stdio fd 重定向到 output.log | 同左 |
| 终止 | `taskkill /PID <pid> /T /F`（按进程树） | `kill(-pid, SIGKILL)` 杀整个进程组 |
| 宿主退出 | 正常退出不影响任务；直接关终端窗口会终止任务 | 不影响 |

日志为命令输出的原始字节（node/git 等为 UTF-8）。Windows 下 cmd 内置 `echo` 按控制台代码页（简体中文系统为 GBK）输出，中文会显示为乱码；需要用 `echo` 输出中文时请改用支持 UTF-8 的程序。

## 状态

`running` 运行中 / `succeeded` 已完成（exit 0）/ `failed` 失败（非零退出、启动失败、超时）/ `killed` 手动终止 / `interrupted` 已中断（宿主重启期间退出，退出码未知）。

## 配置（PiDeck 自动生成配置界面）

| 配置项 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| 默认单任务超时 | `SHELLJOB_DEFAULT_TIMEOUT_MS` | `0`（不限） | 未显式传 `timeoutMs` 时生效 |
| 单任务日志保护上限 | `SHELLJOB_MAX_LOG_BYTES` | `5242880`（5MB） | 超过后保护性 kill，防失控输出塞满磁盘 |

## PiAbyss Host 停止接口

扩展在首个会话启动时额外启动一个仅绑定 `127.0.0.1` 的窄权限 HTTP 控制面（默认 `18767`，可用 `SHELLJOB_CONTROL_PORT` 配置）。它只接受停止动作，内部走 `killShellJob()`，由既有 settle/Notifier 链路通知任务所属 Agent；Host 不应再发送 prompt/followUp。

```http
POST http://127.0.0.1:18767/api/jobs/stop
X-Pi-Shelljob-Token: <~/.pi/shelljob/token>
X-Pi-Session-Id: <当前 UI 会话对应的 Pi sessionId>
Content-Type: application/json

{"jobId":"job_..."}
```

响应状态：成功停止 `{ok:true,status:"killed",jobId}`；目标已结束 `{ok:true,status:"already_ended",jobId,state}`；缺失 `404 {ok:false,status:"not_found",jobId}`；任务不属于给定 session `403 {ok:false,status:"forbidden",jobId,error}`；杀进程失败仍运行 `500 {ok:false,status:"failed",jobId,error}`。请求体仅允许 `jobId`。认证失败为 401，Host 非回环为 403，格式错误为 400。

Token 首次生成到 `~/.pi/shelljob/token`（文件权限 0600），也可由 `SHELLJOB_CONTROL_TOKEN` 注入；写请求必须用 header。PiAbyss Host 必须保管该 bearer 凭据并仅向当前会话 UI 转发控制请求，同时以可信的当前 Pi sessionId 设置 `X-Pi-Session-Id`。端点在首个会话启动时开启、最后一个会话关闭时关闭，插件扩展重载时由进程级服务单例防重复监听。

## 命令

- `/shelljobs`：列出全部后台任务及状态
- `/shelljob-kill <jobId>`：手动终止某个任务

## 注意

- 任务进程以 `shell` 方式启动（Windows 下进程树根是 `cmd.exe`）：**命令自己把工作丢到后台**（如 `start /b`、`nohup ... &`、`&` 结尾）时，根进程会提前退出，此时任务会被当作已结束（`interrupted`/`succeeded`）而实际工作仍在跑，且 `kill` 也无法回收——需要真正的常驻服务请直接用相应命令正常前台运行。
- 任务退出码在宿主进程重启期间丢失的场景下不可知，此类任务标记为 `interrupted` 而非真实终态。
- 插件不重复内置 bash 的审批/沙箱能力，命令执行权限与会话同级。
