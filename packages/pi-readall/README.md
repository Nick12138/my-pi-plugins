# 📄 pi-readall

统一读取层插件：**OCR 主力 + 视觉兜底，Anything In / Text Out**。
合并并替代 pi-vision（视觉看图）与 pi-anytomd（任意转 MD）的核心能力，针对「合同内容识别、证照识别、大批量图片型 PDF 转文字」场景优化。

> 设计原则：**尽量使用 OCR**。WPS 扫描识别快、零模型调用成本、整本一次转完；
> 视觉模型只在 WPS 缺位 / 失败 / 质量不合格时登场兜底。

## 单工具 readall（按 action 分发）

```
readall({ action: "read", paths: [...] })      同步读取（默认），OCR 主力 + 视觉兜底
readall({ action: "submit" | "status" | "wait" | "cancel" | "list", ... })   异步任务队列
readall({ action: "setup" [, install: true] }) 依赖体检 / 自动安装
```

## 路由表

| 输入 | 主力链路 | 兜底链路 |
| --- | --- | --- |
| 扫描件 PDF（几十页合同） | `pdf2word(scanned)` WPS 整本 OCR → docx → 纯文字；**超过 20 页自动分批**（`【第 a-b 页】` 分段，单批失败不拖累其它批） | 失败批用 `pdf2photo --range` 只切失败页 → 视觉模型并发识别（成功批不重跑） |
| 批量图片（一堆证照） | `photo2word` 分张 OCR（`-o <dir>/`，一张一个 docx，按原文件名分段） | `photo2pdf` 合并 → `pdf2word(scanned)` → 仍失败则视觉模型并发逐张 |
| 单张图片 | `photo2word` | 视觉模型识别 |
| 文字版 PDF | `pdf2md` | 为空时按扫描件重试 → 视觉兜底 |
| docx / xlsx / pptx | officecli / pandoc（gfm，保留表格结构） | WPS 转 PDF 链路 |
| doc / xls / ppt / wps / et / dps | WPS 转 PDF → `pdf2md` | — |
| odt / epub / rtf / csv / tsv | pandoc 原生 | — |
| 加密文档 | `password` 参数透传解密 | — |

OCR 链路统一用 `pandoc -t plain --wrap=none`，并剥掉 docx 带出的 `<img>` 标签与空图片占位，
只留可核对的纯文字；用户主动提交的 Office 文档仍走 gfm 以保留标题/表格。
`officecli view text` 输出里每行前缀的 XPath 定位（`[/body/p[3]] `）会被剥除。
多文件混传时**输出顺序与输入顺序一致**（连续图片合并成一次 photo2word 批次）。

`method` 参数可强制通道：`auto`（默认，WPS 优先失败兜底）/ `wps`（只走 WPS）/ `vision`（强制视觉模型）。

## 上下文保护

识别结果超过内联阈值（`PI_READALL_INLINE_CHARS`，默认 20000 字符）时自动全文落盘
（`outputPath` 或 `Agent临时工作/output/`），上下文里只返回**大纲 + 开头节选 + 文件路径**，
Agent 后续用 read 按需翻页。100 页合同转出的 markdown 不再一次性灌进对话。

## 确定性校验（识别置信度）

`checks.mjs` 对输出文本做与模型无关的硬校验：扫描疑似统一社会信用代码（91/92/93 开头 18 位），
用 GB 32100-2015 校验位验证。校验不通过 = 100% 识别错字，会在正文末尾追加警告：

```
> ⚠️ 统一社会信用代码校验位不通过（GB 32100 校验算法），以下号码 100% 存在识别错字，请对照原件核对：
> - `91510100MA6CQ54398`
```

实测价值：同一张营业执照，WPS OCR 给 `915101000806054398`（校验通过），
视觉模型给 `91510100MA6CQ54398`（校验不通过）——可以直接判断该采信哪个。
18 位身份证 / 银行卡号不会被误判（只认 9[123] 开头）。

## 视觉兜底通道

移植自 pi-vision 的模型路由引擎：

- 自动模式只从「用户已配置且非 OAuth」的视觉模型中选择，成功模型本进程内提升为首选
- 显式指定 `PI_VISION_MODEL` 时按 `PI_VISION_FALLBACK_MODELS` 顺序回退
- 兜底时逐张并发识别（`PI_READALL_VISION_CONCURRENCY`，默认 2），单张失败不拖累整批
- 系统 prompt 面向 OCR 特化：逐字提取、数字证号金额禁止改写、无法辨认标注 `(无法辨认)`

## 异步任务队列

分离进程运行、跨会话存活，落盘 `~/.pi/readall-jobs/`；提交时自动回收旧任务
（终态且超 7 天或超 50 条，运行中的任务不动）。已终态的任务 `cancel` 会直接报错，不会把
succeeded 覆写成 cancelled。
**注意：分离进程无法访问 pi 的模型注册表，因此后台任务没有视觉兜底**——
WPS 失败即任务失败并提示改用同步 read 分批执行。

## 依赖

- **wpscli**（OCR 主力）：WPS Office 自带，无需密钥；OCR 能力通常需要 WPS 会员
- pandoc / officecli（可选，docx 与 odt/epub 等格式的快速读取）：`readall({ action: "setup", install: true })` 自动安装
  - pandoc 走 winget 签名包，可直接装
  - **officecli 官方安装方式是从网络拉脚本直接执行**（`irm https://d.officecli.ai/install.ps1 | iex`），
    默认**不自动运行**；确认来源可信后手动执行，或设 `READALL_ALLOW_REMOTE_INSTALL=1` 再跑 setup
- 视觉兜底：本机已配置的任一支持图片输入的模型

## 配置（环境变量，PiDeck 配置界面注入）

| 变量 | 说明 |
| --- | --- |
| `PI_VISION_MODEL` | 兜底视觉模型（留空 = auto 自动选择） |
| `PI_VISION_FALLBACK_MODELS` | 回退视觉模型列表，逗号分隔 |
| `PI_READALL_VISION_CONCURRENCY` | 视觉兜底逐张并发数（1-8，默认 2） |
| `PI_READALL_INLINE_CHARS` | 结果内联阈值字符数（默认 20000） |
| `READALL_OCR_PAGE_CHUNK` | 扫描件 PDF 分批 OCR 的每批页数（默认 20，0 = 不分批） |
| `READALL_SYNC_TIMEOUT_SEC` | 同步 `read` 单次转换超时秒数（默认 1800；分批大文件可调大） |
| `READALL_MAX_CONCURRENT` / `READALL_JOB_DEADLINE_SEC` | 异步队列并发数（默认 **6**，WPS 云端 OCR 不宜高并发）/ 单任务总时限秒（默认 1800） |
| `READALL_JOBS_KEEP_DAYS` / `READALL_JOBS_KEEP_MAX` | 任务目录保留天数（默认 7）/ 最多条数（默认 50），超出自动回收 |
| `READALL_ALLOW_REMOTE_INSTALL` | 设为 `1` 才允许 `setup install:true` 执行 officecli 的远程安装脚本（默认跳过） |
| `WPSCLI_PATH` | wpscli.exe 路径（留空自动定位） |
| `PI_VISION_MAX_TOKENS` / `PI_VISION_TIMEOUT_MS` / `PI_VISION_MAX_IMAGE_MB` | 视觉调用参数（继承 pi-vision 默认值） |

## 与旧插件的关系

| 旧插件 | 处置建议 |
| --- | --- |
| pi-vision | 能力已并入（视觉兜底通道 + 并发队列）；等 pi-readall 稳定后可下架 |
| pi-anytomd | 能力已并入（WPS 链路、pandoc、异步队列、密码解密）；百度 OCR 通道已移除 |
| pi-ocr | 百度 OCR 已整体移除（证照结构化提取由视觉兜底的 prompt 承担）；可下架 |

## 已知边界

- OCR 结果中相近汉字、数字、日期、证号可能识别错；正式材料交付前需人工核对关键数字
  （实测：`叁佰万元整`→`参佰万元整`、`四川宏德慧成`→`四用宏德慧成`，WPS 云 OCR 引擎本身的问题，换管线无效）
- **分批 OCR 是「按页切段」而非「按内容切段」**：一个跨页的表格/段落可能被切在两批之间；
  需要完整版面时调大 `READALL_OCR_PAGE_CHUNK` 或设 0 不分批
- 异步任务总时限 `READALL_JOB_DEADLINE_SEC`（默认 1800s）与分批数相乘时会先到上限——
  超长文档建议拆多次 `submit`
- `pdf2word --ai-fix true`（在线 AI 修复）实测无收益且耗时翻倍，插件默认不开
- `pdf2md` / `pdf2txt` 不支持 `--scanned`（只有 `pdf2word` 支持，且必须配 `--range`），
  所以扫描件绕不过 docx 中转
- `pdf2photo`（wpscli 1.1.0）会把多页**竖向拼成一张超长图**（20 页 = 1122x31740），
  视觉模型降采样后无法识别；且不传 `--range` 时直接 exit 214。因此插件按页逐张渲染
  （`page-0001.jpg` …），一本 44 页的 PDF 切页约 40s
- 校验位只能覆盖统一社会信用代码；法定代表人、金额、住所等字段无法自动验证，仍需人工核对
- 后台异步任务无视觉兜底（进程隔离所致），需要兜底的批量任务用同步 read 分批
- 视觉兜底的 data URL / http 链接不支持（只接受本地文件路径）
