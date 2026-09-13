# 👁 pi-vision

视觉能力插件：给**没有识图功能的模型**一个"看图"工具。暴露三个工具：`see_image`（单图）、
`see_images`（多图批量，单次上限可配，默认 5 张）与 `see_job`（异步看图任务队列，大批量后台分析）——
把图片发给你配置的视觉模型，把分析结果作为工具结果返回给主模型。
截图、报错弹窗、UI 界面、图表、照片都能让它看懂。

模型路由带**自动首选 + 全量回退**能力。自动模式首次从"已配置且非 OAuth"的视觉模型中随机选择一个并保持；该模型失败后按其他已配置视觉模型继续尝试，新的成功模型会成为下一次自动调用的首选。**自动模式绝不会选中你没配置过的模型**（例如 openrouter、anthropic 等 OAuth 登录的内置目录模型会被排除）。

## 模型路由

```
see_image 调用
  ├─ 传了 model 参数        → 用它（仅本次生效，优先级最高）
  ├─ 配了 PI_VISION_MODEL   → 默认视觉模型
  └─ 都没配                 → auto：从“已配置且非 OAuth”、支持 image 输入的模型中随机选一个
        ↓ 失败
  自动模式：按注册表顺序尝试其他已配置视觉模型；成功模型提升为下一次自动首选
  显式配置默认模型：PI_VISION_FALLBACK_MODELS 按逗号顺序逐个回退
```

auto 模式的候选范围只认**用户已配置**的模型：provider 有可用认证（models.json / auth.json / 运行时 key / 环境变量），且不是 OAuth 登录的 provider。这样自动选择不会随机挑中你根本没配置过的 OAuth / 内置目录模型（如 openrouter 的 `nex-agi/nex-n2-mini`、amazon-bedrock 的 `us.anthropic.claude-opus-4-8`）。显式配置（PI_VISION_MODEL、回退列表、model 参数）不受此限制，仍按填写内容解析。

## 工具

```
see_image({ image, prompt, model? })                      单图
see_images({ images[], prompt, model? })                  多图批量（上限 PI_VISION_MAX_BATCH，默认 5）
see_job({ action, tasks[]?... })                          异步任务队列：submit / status / wait / cancel / list
```

### see_image

| 参数 | 说明 |
| --- | --- |
| `image` | 本地文件路径（相对路径按 cwd 解析）或 `data:image/...;base64,...` 的 data URL |
| `prompt` | 想让视觉模型分析/提取什么。越具体越好："逐字提取图中文字" / "这个报错是什么意思" / "描述页面布局" |
| `model` | 可选，临时指定视觉模型 `provider/modelId`，仅本次调用生效 |

### see_images

| 参数 | 说明 |
| --- | --- |
| `images` | 图片位置列表（路径或 data URL），按传入顺序编号；重复路径自动去重，上限 `PI_VISION_MAX_BATCH`（默认 5），超出整体拒绝并提示拆分 |
| `prompt` | 对所有图片的同一个分析要求，可用"第 N 张"指代具体图片，例如："对比两张截图，列出 UI 差异" |
| `model` | 可选，同 see_image |

多图在**同一次视觉调用**中一起送入模型（而非逐张调用），适合跨图对比与成组审查；
任一图片读不了会整体失败并指出第几张，避免模型对着缺图作答。模型选择/回退与 see_image 完全一致。

### 图片读取失败与诊断

图片在调视觉模型之前就会做校验，失败时返回带 `reason` 的 `image_read_error`，并在错误文案里附四行诊断：

```
无法读取图片 "D:/proj/../../Users/liu/AppData/.../README.md"：文件不存在（ENOENT）
  传入: D:/proj/../../Users/liu/AppData/.../README.md
  解析: D:\Users\liu\AppData\...\README.md   ← ../.. 被 Windows 词法吸收，盘符已变
  cwd:  D:\proj
  原因: 文件不存在（ENOENT）
```

`reason` 取值：

| reason | 含义 |
| --- | --- |
| `not_found` | 路径不存在（最常见：模型自己拼接 / 猜测的路径） |
| `is_directory` | 传进来的是目录 |
| `unsupported_format` | 扩展名不是受支持的图片格式（如 `.md` / `.pdf`），提示改用 anytomd |
| `too_large` | 超过 `PI_VISION_MAX_IMAGE_MB`（默认 20MB） |
| `empty_file` | 0 字节文件 |
| `read_failed` | 其它 IO / 权限错误 |
| `unsupported_url` | 传了 http(s) 链接（需先下载为本地文件） |
| `empty_ref` | 路径为空 |

插件不会自动修正或改写路径（不做跨盘探测、不猜同名文件）；诊断只用于让调用方一眼看出差异并自行纠正。

### see_job（异步任务队列，对标 pi-anytomd 的 anyjob）

大批量图片分析（批量 OCR、证书信息提取、逐页审阅）不想阻塞当前回合时使用。
submit 创建后台任务立即返回 job-id；任务记录与结果持久化到 `~/.pi/vision-jobs/jobs/<id>/`，
跨会话可查（status / wait / cancel / list）。

```ts
// 批量提交：每个任务 = 独立的图片组 + 独立的 prompt（一次最多 50 个）
see_job({ action: "submit", tasks: [
  { image: "./cert1.png", prompt: "提取姓名、证书编号、有效期" },
  { image: "./cert2.png", prompt: "提取姓名、证书编号、有效期" },
  { images: ["./p1.png", "./p2.png"], prompt: "对比两张截图的差异", model: "openai/gpt-4o" },
]})

// 单任务快捷方式；wait=true 则阻塞等本批全部到终态并内联返回分析全文
see_job({ action: "submit", image: "./a.png", prompt: "...", wait: true, timeoutSec: 600 })

see_job({ action: "status", id: "seejob_..." })   // 状态 + 结果预览（前 2000 字）
see_job({ action: "wait",   id: "seejob_..." })   // 阻塞到终态，成功直接返回分析全文
see_job({ action: "cancel", id: "seejob_..." })   // 取消（运行中的任务触发中断）
see_job({ action: "list", limit: 20, statusFilter: "failed" })  // 历史
```

| 特性 | 说明 |
| --- | --- |
| 并发 | `PI_VISION_MAX_CONCURRENT`（默认 2，1-8），超限自动排队 |
| 产物 | `<jobDir>/result.md`（分析全文）+ `details.json`（模型/回退尝试记录） |
| stale 检测 | 读任务时发现排队/运行中的任务 pid 与当前进程不一致（即上个 pi 进程遗留），自动标记 failed |
| data URL 隐私 | 任务元数据里的 data URL 不落盘（只存 `data:<mime>;base64,<长度>` 标记），原件只在提交进程内存中 |
| 与 anyjob 的差异 | anyjob 是 detached 独立进程（跨会话继续跑）；see_job 在 pi 进程内运行（依赖模型注册表），pi 退出后排队/运行中任务视为失败，已落盘结果跨会话仍可查 |

模型路由/回退与 see_image 完全一致；成功模型同样会提升为下一次自动调用首选。
**提交前会做一次前置检查**：如果存在未指定模型的任务而默认路由上没有任何可用视觉模型，会直接拒绝提交。

## 工具可见性：有视觉的模型默认走视觉

本插件的定位是“给**自身不能看图**的模型一个看图工具”。因此：

| 当前会话模型 | see_image / see_images / see_job |
| --- | --- |
| 不能看图（或模型未知） | **开启**（这才是插件的核心场景） |
| 自己能看图 | **关闭**：工具从活跃集移除，模型直接看原图，不会把截图转交出去 |

### 为什么不看配置里的 `input`

`models.json` 里的 `input: ["text","image"]` 只是**声明**。实测存在“配置写了 `image`、实际调用调不通图片”的模型，所以声明不代表能力。

插件改用**真实探针**判定：发现模型声明了 `image` 时，发一个 1×1 PNG 真实调一次，按 `provider/model` 缓存 7 天（默认写到 `~/.pi/vision-jobs/model-capabilities.json`，可用 `PI_VISION_CAPABILITY_FILE` 覆盖）：

- 探针调用成功 → 认定为能看图 → 关闭 `see_*` 工具；
- 报错且错误明确是“不支持图片” → 认定为不能看图 → 保持开启，并弹一次提示说明“配置声明与实际不符，已以实际为准”；
- 拿不准（无认证 / 网络失败 / 超时）→ **保守按“不能看图”处理**，工具保持开启（宁可多给工具，也不把用户卡死）。

成本：声明了 `image` 的模型每个只多一次探针调用（1×1 PNG + 1 token 输出 + 20s 超时）；声明纯文本的模型不探测。

**已知局限**：探针只能验证“接口不报错”，检测不出“接受图片但静默忽略”的假阳性模型（这类模型会被判为能看图，
导致 `see_*` 被关闭）。若碰到这种情况，用 `/vision tools on` 强制开启即可。探针结论缓存在
`~/.pi/vision-jobs/model-capabilities.json`（按 `provider/model` 缓存 7 天），删掉文件或该条目即可重探。

### 手动覆盖

```
/vision tools          # 查看当前判定（模型、声明 vs 实测、覆盖设置）
/vision tools auto      # 默认：按实测能力自动决定
/vision tools on        # 总是开启 see_*（即使模型自己能看图）
/vision tools off       # 总是关闭 see_*
```

设为 `on`/`off` 后不再探测模型，也不再弹“声明与实际不符”的提醒（以用户意愿为准）。

## 配置（环境变量）

| 环境变量 | 控件类型 | 说明 |
| --- | --- | --- |
| `PI_VISION_MODEL` | select（视觉模型动态单选） | 默认视觉模型；选“自动选择”则由插件从已配置且非 OAuth 的识图模型中随机选择并保持，失败后自动切换到其他已配置模型 |
| `PI_VISION_FALLBACK_MODELS` | text | 显式配置默认模型时使用的回退视觉模型列表，英文逗号分隔，按顺序尝试；自动模式会自动尝试其他已配置视觉模型 |
| `PI_VISION_MAX_BATCH` | text | `see_images` 单次调用最多分析的图片数量，默认 5（至少 1）；超出会整体拒绝并提示拆分 |
| `PI_VISION_MAX_IMAGE_MB` | text | 单张图片体积上限（MB，按解码前字节数），默认 20；超限直接拒绝 |
| `PI_VISION_MAX_CONCURRENT` | text | `see_job` 后台分析并发数，默认 2（1-8），超限自动排队 |

另有三个**仅供高级用户**的环境变量（不在配置界面显示，留空走内置默认值）：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_VISION_MAX_TOKENS` | 4096 | 单次视觉调用最大输出 token 数 |
| `PI_VISION_TIMEOUT_MS` | 90000 | 单次视觉调用超时毫秒数，超时后自动回退下一个模型 |
| `PI_VISION_JOBS_DIR` | `~/.pi/vision-jobs` | `see_job` 任务库目录（可覆盖，主要给测试隔离使用） |
| `PI_VISION_CAPABILITY_FILE` | `<JOBS_DIR>/model-capabilities.json` | 模型看图能力探针的结果缓存文件 |

配置界面的选项与仓库根目录 [plugins.json](../../plugins.json) 中的 `config` 声明一一对应。
工具调用的 `model` 参数优先级高于环境变量。

模型需在 pi 的模型注册表中已配置（`~/.pi/agent/models.json`），且 `input` 数组包含 `"image"`。

## 命令 / 状态栏

- `/vision` — 查看当前配置与候选模型解析结果（含不可用原因）
- 状态栏 — 配置了可用视觉模型时显示 `👁 <模型id>`，调用期间闪烁当前使用的模型

## 参考实现

调研自 pi.dev 插件目录：

- [`pi-vision-tool`](https://pi.dev/packages/pi-vision-tool) — `describe_image` 工具形态（本插件采用）
- [`pi-image-fallback`](https://pi.dev/packages/pi-image-fallback) — 通过 modelRegistry 解析模型、统一走 pi-ai 调用
- [`pi-vision-handoff`](https://pi.dev/packages/pi-vision-handoff) — 把图片描述注入上下文的自动管线（更激进，本插件未采用）
