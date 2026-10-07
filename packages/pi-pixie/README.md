# pi-pixie

Pixie 委派/回调工具的插件侧壳：`pixie_dispatch`（常驻小精灵会话专用）与 `pixie_report`（被委派会话回调用）。**委派引擎本身仍在 PiAbyss Host 侧**——插件只把两个工具的执行转发到 Host 的环回 HTTP 控制面，参数 schema 与结果文案和 PiAbyss 内置实现（`packages/pi-host/src/pixie-tool.ts`）保持一致。

> 注意：下文的 3 个环回端点是本插件定义的**新契约**，需要 PiAbyss Host 侧配合实现（移除内置 customTools 注入、启动环回控制面、给常驻会话注入 `PIABYSS_PIXIE_RESIDENT=1`）。Host 未实现控制面时，本插件在任何环境下都只会返回降级错误文案，不影响其它功能。

## 功能

- **pixie_dispatch**（仅在常驻小精灵会话注册/激活）：委派任务到某个工作区的正式会话执行。填入目标工作区 `cwd` 与任务提示词 `task`，可选 `newSession` 强制新开会话；Host 解析目标会话（活跃 → 后台 → 空闲缓存 → 新建）并注入任务，目标会话忙时任务排队。成功后立即返回受理结果（`dispatchId` + 目标 `sessionId`），目标会话完成后再通过 `pixie_report` 回调。
- **pixie_report**（注册在每个非小精灵会话上，但默认保持休眠）：被委派的任务会话在完成任务后回调。参数与原实现一致 `{ result, success? }`——dispatchId 对模型透明，插件先查 dispatch-state 端点按当前会话解析出 dispatchId，再 POST `{ dispatchId, summary, success }`。
- 全部请求走 `node:http` **直连 `127.0.0.1`**（禁用全局 fetch：PiAbyss Host 注入的代理设置会拦截环回请求），单请求超时 3 秒。

## 激活门控安全语义

- `pixie_dispatch`：Host 在常驻小精灵会话注入环境变量 `PIABYSS_PIXIE_RESIDENT=1`，扩展入口仅在该会话注册此工具；普通会话完全不注册、不可见。
- `pixie_report`：注册在每个非小精灵会话上，但由激活扩展保持在 active tools 之外——扩展在每个 `before_agent_start` 调 `GET /api/pixie/dispatch-state?sessionId=<当前会话id>`，**仅当响应为 `{ armed: true }` 时才把工具加入 active tools**，否则剪除。因此普通工作区会话永远看不到该工具，工作区 agent 无法在无委派的情况下调用它。
- 门控查询的任何失败（端口缺失/非法、连接失败、3 秒超时、非 200、响应体不合法）一律**保守地视为未 armed**，且绝不抛错——不会让 agent 启动失败。armed 状态每轮重新评估：委派注入时工具加入，委派结束后工具重新剪除。查询**失败后有 30 秒退避**（退避期内不再重复查询，避免 Host 挂死时每轮阻塞 3 秒）；Host 健康时仍每轮实时评估。

## 环回 HTTP API 契约

Host 侧控制面监听 `127.0.0.1:<PIABYSS_PIXIE_HTTP_PORT>`，共 3 个端点：

### 1. `POST /api/pixie/dispatch`（pixie_dispatch 执行）

请求体：

```json
{ "cwd": "D:/我的项目/demo", "task": "…", "newSession": false }
```

成功（200）：

```json
{ "ok": true, "dispatchId": "…", "sessionId": "…", "sessionPath": "…", "queued": false }
```

工具文本（与原实现逐字节一致）：

```
已派发到工作区会话（sessionId: …，该会话当前忙，任务已排队）。等待其回调 pixie_report 后再向用户转述。
```

（`queued: false` 时无「，该会话当前忙，任务已排队」一段。）

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
