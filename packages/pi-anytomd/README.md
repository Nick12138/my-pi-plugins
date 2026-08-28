# AnyToMD (pi-anytomd)

一个工具读所有文档：图片 / docx / xlsx / pptx / doc 等冷门格式 / PDF（文字版+扫描件），统一转成 Markdown。

## 工具

### `anytomd`

按文件类型自动分流，全部产出 Markdown：

| 输入 | 主链路（wpscli） | 回退链路 |
|---|---|---|
| 图片 ×1 | `photo2word`（云端 OCR）→ pandoc 转 md | 百度 OCR → 视觉模型兜底（对话层） |
| 图片 ×N | `photo2pdf` 合并 → `pdf2word --scanned` → pandoc | 百度 OCR（并发）→ 同上 |
| docx/xlsx/pptx | `officecli view text` | pandoc（docx）→ wpscli 转 PDF → pdf2md |
| doc/xls/ppt/wps/et/dps | wpscli 转 PDF → `pdf2md` | — |
| PDF 文字版（自动判定） | `pdf2md` | 判错时按扫描件重试 → OCR |
| PDF 扫描件（自动判定） | `pdf2word --scanned --range` → pandoc | `pdf2photo` 渲染成图 → 百度 OCR 逐页 |
| txt / md | 直接读取 | — |

参数：

- `paths: string[]` — 一个或多个文件路径；多张图片会合并成一份结果，其他文件各自成节
- `method: "auto" | "wps" | "ocr"` — auto = WPS 优先、质量差自动切 OCR；ocr = 强制百度 OCR
- `accuracy: "standard" | "accurate"` — 百度 OCR 精度档
- `concurrency: number` — OCR 并发（默认 2，未付费百度账号 QPS=2）
- `range: string` — PDF 页码范围（如 `"1-5"`），默认全部页
- `outputPath: string` — 可选；结果在上下文返回的同时落盘为 .md 文件（已存在自动改名，不覆盖）。相对路径优先落到当前工作区的 `Agent临时工作/output/`，绝对路径按原样保存；未提供则不产生任何文件

质量闸门：提取结果为空/乱码（可读字符 < 10 或替换符占比过高）视为该链路失败，auto 模式自动降级。全部链路失败时结果会带 `fallback: see_image` 指示，由模型用视觉工具最后兜底。

## 文件落位

- 过程文件（photo2word/pdf2word/pdf2photo/pandoc 等中间产物）统一放在当前工作区的 `Agent临时工作/temporary/` 下，**每次运行结束自动清理**（含空的 temporary 目录）；进程被杀等异常中断情况可能残留，手动删除即可
- 落盘 md（`outputPath` 相对路径）放到当前工作区的 `Agent临时工作/output/`

### `anytomd_setup`

依赖体检 + 一键安装：

- `anytomd_setup()` — 只读体检：wpscli / officecli / pandoc / 百度 Key 状态表
- `anytomd_setup({ install: true })` — 自动安装缺失项：
  - pandoc → `winget install JohnMacFarlane.Pandoc`
  - officecli → 官方 PowerShell 安装脚本
  - wpscli 不安装（随 WPS Office 提供，自动定位 `WPSCLI_PATH` → PATH → WPS 安装目录最新版）
  - 百度 Key 仅配置（BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY，与 pi-ocr 共用）

插件加载时会静默自检缓存依赖状态，不安装任何东西。

## 依赖

| 依赖 | 必需 | 用途 |
|---|---|---|
| WPS Office（含 wpscli.exe）+ 会员 | 核心 | 图片/扫描件 OCR、PDF 转换（云端） |
| pandoc | 建议 | docx → Markdown |
| officecli | 建议 | Office 三件套直读 |
| 百度 OCR Key | 可选 | 第二识别通道 |

npm 零依赖（仅 Node 内置模块），安装插件后跑一次 `anytomd_setup({ install: true })` 即可。

## 配置（plugins.json）

- `BAIDU_OCR_API_KEY` / `BAIDU_OCR_SECRET_KEY`：百度 OCR（可选，留空则 OCR 回退禁用）
- `WPSCLI_PATH`：wpscli.exe 完整路径（可选，留空自动定位）
