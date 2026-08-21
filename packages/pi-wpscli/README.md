# WPS-CLI — pi 插件

把本地 WPS 命令行工具 `wpscli` 封装成 pi 工具集（移植自 `wps-pdf-to-word` Claude 技能）。无需 API 密钥，但**依赖本机安装 WPS Office 并登录**（OCR/转换能力通常需要会员）。

## 工具一览（9 个）

| 工具 | 包装命令 | 说明 |
| --- | --- | --- |
| `wps_pdfinfo` | `pdfinfo` | 查看 PDF 元数据/页数/是否扫描件的方向提示 |
| `wps_pdf2word` | `pdf2word` | PDF → 可编辑 Word；`scanned=true` 走 WPS OCR（**必须配 `range`**），`aiFix=true` 自动旋转修版 |
| `wps_to_pdf` | `word2pdf` / `excel2pdf` / `ppt2pdf` / `txt2pdf` | Office/TXT → PDF，按扩展名自动选子命令 |
| `wps_pdfcompress` | `pdfcompress` | 压缩 PDF（`low`/`medium`/`high`） |
| `wps_pdfwatermark` | `pdfwatermark` | 文本水印（文字/透明度/角度） |
| `wps_photo2pdf` | `photo2pdf` | 图片 → PDF |
| `wps_pdf2imgpdf` | `pdf2imgpdf` | PDF → 图片版 PDF（无文字层） |
| `wps_pdf2photo` | `pdf2photo` | PDF 页面 → 图片（自动建输出目录并返回文件清单） |
| `wps_pdf2md` | `pdf2md` | PDF → Markdown |

## 关键设计（沿用技能的经验教训）

- **全部加 `--json`**，退出码翻译成中文人话：`100` = 未登录、`101` = 权限不足（会员）、`211` = 输出目录不存在
- **先探后转**：未知 PDF 先 `wps_pdfinfo`；`scanned=true` 却不给 `range` 会直接拒绝并提示
- **图片转可编辑 Word 两步走**：`wps_photo2pdf` → `wps_pdf2word(scanned=true, range="1")`，绝不把图片塞进 Word 冒充 OCR
- 输出目录自动创建；默认输出文件名带中文后缀（`_WPS转换.docx`、`_压缩.pdf`、`_水印.pdf`、`_pages/`…）
- 默认超时 300 秒（CLI 侧 `--timeout`），每个工具可用 `timeoutSec` 覆盖

## wpscli 定位顺序

1. 环境变量 `WPSCLI_PATH`
2. `PATH`（`where wpscli`）
3. `%LOCALAPPDATA%\Kingsoft\WPS Office\<版本>\clitool\wpscli.exe`（取版本号最新者）
4. `C:\Program Files\WPS Office\<版本>\clitool\wpscli.exe`

## 配置（可选）

| 环境变量 | 说明 | 必填 |
| --- | --- | --- |
| `WPSCLI_PATH` | wpscli.exe 的完整路径，自动定位失败时手动指定 | - |

## 注意

- OCR 结果可能把相近汉字、数字、日期、证照编号识别错，正式材料交付前需人工核对
- 原技能中的"核验转换结果"步骤（python-docx 读段落数）没有封装进来——pi 里直接用 read/python 即可
- 未封装的功能：`pdfsplit`/`pdfmerge`/`pdfencrypt`/`pdfremovewatermark`/`pdf2excel`/`pdf2ppt`/`pdf2txt`/`cad2pdf`/`caj2pdf`/`pdf2cad`（如需要直接跑命令即可）
