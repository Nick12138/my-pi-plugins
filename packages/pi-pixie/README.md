# pi-pixie

Pixie 委派/回调工具的插件侧壳：`pixie_dispatch`（常驻小精灵会话专用）与 `pixie_report`（被委派会话回调用）。**委派引擎本身仍在 PiAbyss Host 侧**——插件只把两个工具的执行转发到 Host 的环回 HTTP 控制面，参数 schema 与结果文案和 PiAbyss 内置实现（`packages/pi-host/src/pixie-tool.ts`）保持一致。

> 注意：下文的 3 个环回端点是本插件定义的**新契约**，需要 PiAbyss Host 侧配合实现（移除内置 customTools 注入、启动环回控制面、给常驻会话注入 `PIABYSS_PIXIE_RESIDENT=1`）。Host 未实现控制面时，本插件在任何环境下都只会返回降级错误文案，不影响其它功能。

## 功能

- **pixie_dispatch**（仅在小精灵工作区会话注册/激活）：委派任务到某个工作区的正式会话执行。填入目标工作区 `cwd` 与任务提示词 `task`。
  **落点规则（v4.3 会话归属）**：默认只复用**小精灵自己创建的**会话（没有就自动新开一个）；用户自己在 UI 里创建的会话**不会被自动复用**——除非用户在对话中明确给出该会话 id，此时用 `sessionId` 参数指定（找不到会直接报错，不会改落到别的会话）。`newSession: true` 强制新开。受理回执会写明落点是「复用了小精灵自己的会话」还是「新开了干净会话」。
  **命名（v0.5）**：每条新任务带 `taskName`（短名），本次要新开会话时再带 `sessionName`（新会话名）——前端的委派列表按工作区分组显示这两个名字 + 状态，不再显示完整提示词。
- **pixie_sessions**（小精灵会话专用）：读会话缓存（`GET /api/pixie/sessions`），列出小精灵自己创建的会话（可自动复用）与用户会话（仅显式给出 id 时可委托），含所属工作区、会话简介与最近结果。
- 其余指挥台工具：`pixie_report`（被委派会话回调）/ `pixie_ask`（询问用户）/ `pixie_rest`（打盹换段）/ `pixie_dispatch_status`（查岗）/ `pixie_interject`（插话）/ `pixie_stop`（叫停）/ `pixie_retry`（续跑或重派）。
- **每日自动打盹**（Host 侧行为，插件设置里只有一个开关）：新的一天自动换一个干净会话段，但**不按钟点**判定——以上次活动跨过本地日界、且静默达到阈值（默认 3h，随历史静默间隔上抬但不超过 12h）为准；封段会带一份规则拼出的交接摘要（上段尾巴 + 未回音委派 + 备忘录未完成）。Host 重启后由"今天第一条消息之前"的懒兜底判定补偿。阈值内置不开放调整：自适应已经按用户作息在调它。
- **pixie_report**（注册在每个非小精灵会话上，但默认保持休眠）：被委派的任务会话在完成任务后回调。参数与原实现一致 `{ result, success? }`——dispatchId 对模型透明，插件先查 dispatch-state 端点按当前会话解析出 dispatchId，再 POST `{ dispatchId, summary, success }`。
- 全部请求走 `node:http` **直连 `127.0.0.1`**（禁用全局 fetch：PiAbyss Host 注入的代理设置会拦截环回请求），单请求超时默认 3 秒；`POST /api/pixie/dispatch` 单独放宽到 **15 秒**（受理要先打开目标工作区的后台图，实测 0.9–3.3 秒，3 秒预算会让已受理的委派被误报为失败并诱发重复派单）。

## 激活门控安全语义

- `pixie_dispatch`：Host 在常驻小精灵会话注入环境变量 `PIABYSS_PIXIE_RESIDENT=1`，扩展入口仅在该会话注册此工具；普通会话完全不注册、不可见。
- `pixie_report`：注册在每个非小精灵会话上，但由激活扩展保持在 active tools 之外——扩展在每个 `before_agent_start` 调 `GET /api/pixie/dispatch-state?sessionId=<当前会话id>`，**仅当响应为 `{ armed: true }` 时才把工具加入 active tools**，否则剪除。因此普通工作区会话永远看不到该工具，工作区 agent 无法在无委派的情况下调用它。
- 门控查询的任何失败（端口缺失/非法、连接失败、3 秒超时、非 200、响应体不合法）一律**保守地视为未 armed**，且绝不抛错——不会让 agent 启动失败。armed 状态每轮重新评估：委派注入时工具加入，委派结束后工具重新剪除。查询**失败后有 30 秒退避**（退避期内不再重复查询，避免 Host 挂死时每轮阻塞 3 秒）；Host 健康时仍每轮实时评估。

## 环回 HTTP API 契约

Host 侧控制面监听 `127.0.0.1:<PIABYSS_PIXIE_HTTP_PORT>`，共 3 个端点：

### 1. `POST /api/pixie/dispatch`（pixie_dispatch 执行）

请求体：

```json
{
  "cwd": "D:/我的项目/demo",
  "task": "…",
  "taskName": "对账任务",
  "sessionName": "门店数据整理",
  "newSession": true
}
```

（`sessionId` 仅在用户明确给出会话 id 时传；`newSession`/`sessionId` 都省略 = 自动落点：复用小精灵自己创建的会话，没有就新建。）

**命名参数（v0.5 新增，需 Host 侧落库）**：`taskName` 是这条委派的短名，`sessionName` 是新会话的名字。前端的委派列表按「工作区 → 会话 → 任务」分组，只显示这两个名字 + 状态，不显示完整 `task`。

- `taskName`：写入委派记录。每次派发都是一条新任务——**复用既有会话时不得用它覆盖会话名**（两个语义分开）。
- `sessionName`：只在本次**真的新建会话**时采用；复用既有会话时忽略，会话沿用原名。
- 缺省兜底由 Host 做：截 `task` 前约 20 字（新开会话同样兜底，界面上不再出现「新会话」）。
- 插件侧只保证非空（全空白按未传处理，绝不发出空串），**不做截断**——长度口径统一归 Host。

成功（200）：

```json
{ "ok": true, "dispatchId": "…", "sessionId": "…", "sessionPath": "…", "queued": false, "reused": true }
```

（`reused: true` = 复用了小精灵自己创建的既有会话；`false` = 新开会话。旧 Host 不给该字段时回执不标落点。）

工具文本（与原实现逐字节一致）：

```
已派发到工作区会话（sessionId: …，该会话当前忙，任务已排队）。等待其回调 pixie_report 后再向用户转述。
```

（`queued: false` 时无「，该会话当前忙，任务已排队」一段。）

**同请求去重（Host v4.5）**：环回超时不代表 Host 没受理，小精灵按「失败」原样重试会造成同一任务跑两遍。Host 侧对重复提交两层拦截：

- 上一条**已经受理**（同 `cwd` + 逐字相同的 `task`，30 秒内仍有活跃记录）→ 仍回 200 + `queued: true`，`dispatchId`/`sessionId` 是**原来那条**，`queuedNote` 写明「本次没有重复派发」；工具文本 `已受理（dispatchId: …）。同一个任务在 N 秒前已经受理…`。
- 上一条**还在受理中**（请求还没返回，多半在后台打开目标工作区）→ `{ "ok": false, "error": "同一个任务正在受理中…" }`，文本明确提示不要重复派发、改用 `pixie_dispatch_status` 查岗。

`pixie_retry` 的重派（Host 内部 `retryOf`）是有意重跑，不受这两条约束；插件侧无法通过请求体传入 `retryOf`。

失败（`{ "ok": false, "error": "…" }`、非 200、或传输错误）→ `isError` 结果，文本 `委派失败：{error}`。

### 2. `POST /api/pixie/report`（pixie_report 执行）

执行前插件先 `GET /api/pixie/dispatch-state?sessionId=<当前会话id>` 解析 `dispatchId`（对应原实现的 `findDispatch`：未 armed / 无记录 → `Error: 当前会话没有进行中的小精灵委派。`）。

请求体：

```json
{ "dispatchId": "…", "summary": "…", "success": true }
```

成功（200）：`{ "ok": true }` → 文本 `已回调小精灵。用户会在小精灵对话里看到你的结果转述；本会话可以继续接受新任务。`

失败 → `isError` 结果，文本 `Error: {error}`。

### 3. `GET /api/pixie/dispatch-state?sessionId=…`（激活门控 + report 的 dispatchId 解析）

成功（200）：`{ "armed": true | false, "dispatchId": "…" }`。`armed: true` 时应携带该会话进行中委派的 `dispatchId`（report 回填用）；缺失时 report 按无委派处理。非 200 / 解析失败 / 缺字段一律按未 armed 处理。

### 4. `GET /api/pixie/sessions[?cwd=…]`（pixie_sessions 执行，v4.3）

成功（200）：

```json
{ "ok": true, "sessions": [ { "sessionId": "…", "sessionPath": "…", "cwd": "D:/ws",
  "owner": "pixie", "role": "delegated", "summary": "…", "result": "…",
  "createdAt": 0, "lastActiveAt": 0, "dispatchIds": ["…"], "reuseCount": 1 } ] }
```

数据源是 Host 的 `sessions-cache.json`（只存简洁摘要，不存消息正文与工具调用）。`owner: "pixie"` 才可被自动复用；`owner: "user"` 仅当用户明确给出 sessionId 时才能委托。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PIABYSS_PIXIE_HTTP_PORT` | Host 环回控制面端口。缺失或非法（非整数、≤0、>65535）时：工具执行返回可读的失败结果；门控查询直接视为未 armed。 |
| `PIABYSS_PIXIE_RESIDENT` | Host 在常驻小精灵会话注入 `=1`，扩展据此只注册 `pixie_dispatch`；其余值或不设置 = 普通会话，只注册 `pixie_report` + 激活门控。 |

## 测试

```bash
npx vitest run packages/pi-pixie
```

测试用 `node:http` 在 `127.0.0.1` 随机端口起 mock 环回服务，覆盖成功/失败/排队文案的逐字节对照、超时与非 200 映射、armed 门控与扩展入口注册语义。
