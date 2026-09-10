# pi-anytomd (AnyToMD)

本地任意文档转 Markdown，对标并超越 `myagents-anydoc`。

提供两个核心工具：
1. **`anytomd`**：同步文档读取，自动根据扩展名分流处理。
2. **`anyjob`**：跨会话持久异步任务队列（提交/查状态/等待/取消/列表），后台独立进程运行。
3. **`anytomd_setup`**：依赖体检与一键自动安装（pandoc / officecli）。

---

## 一、支持的格式

| 格式分类 | 支持扩展名 | 主链路 | 降级/备用链路 |
|---|---|---|---|
| **Office（新）** | `.docx`, `.xlsx`, `.pptx` | officecli view text | pandoc (`.docx`) / WPS *2pdf → pdf2md |
| **Office（老）** | `.doc`, `.xls`, `.ppt`, `.wps`, `.et`, `.dps` | WPS *2pdf → pdf2md | - |
| **ODF / 电子书 / 表格** | `.odt`, `.epub`, `.rtf`, `.csv`, `.tsv` | **pandoc 原生** | - |
| **PDF（文字版）** | `.pdf` | WPS pdf2md | - |
| **PDF（扫描件）** | `.pdf` (自动探测) | WPS pdf2word (`--scanned`) | 百度 OCR (`pdf2photo` 逐页切图) |
| **单张图片** | `.jpg`, `.jpeg`, `.png`, `.bmp`, `.gif` 等 | WPS photo2word | 百度 OCR（单图直传） |
| **多张图片** | 任意多张图片一次传入 | WPS photo2pdf 合并 → 扫描 OCR | 百度 OCR 并发识别 |
| **加密文档** | 带密码的 PDF、Word、Excel、PPT | 传入 `password` 透传解密 | - |

---

## 二、工具速查

### 1. `anytomd` — 同步转换

```ts
// 普通读取
anytomd({ paths: ["./方案.docx"] })

// 批量多图合并
anytomd({ paths: ["./p1.png", "./p2.png", "./p3.png"] })

// 读取加密 PDF（密码不落盘）
anytomd({ paths: ["./secret.pdf"], password: "123" })

// 读取 ODT / EPUB / RTF / CSV
anytomd({ paths: ["./data.csv"] })

// 强制百度高精度 OCR
anytomd({ paths: ["./模糊扫描.pdf"], method: "ocr", accuracy: "accurate" })

// 结果落盘
anytomd({ paths: ["./doc.pdf"], outputPath: "my-result.md" })
```

### 2. `anyjob` — 异步任务队列（对标 myagents-anydoc）

任务持久化保存在 `~/.pi/anytomd-jobs/jobs/<id>/`，后台独立进程执行，主 pi 退出或跨会话仍继续运行。

```ts
// 提交后台任务（立即返回 job-id）
anyjob({ action: "submit", file: "./big.pdf" })

// 提交并阻塞等待完成（wait=true 模式）
anyjob({ action: "submit", file: "./scan.pdf", wait: true, timeoutSec: 120 })

// 查看任务详情与进度（含 stale 检测：崩溃自动标 failed）
anyjob({ action: "status", id: "job_20260910_..." })

// 等待某个任务完成
anyjob({ action: "wait", id: "job_20260910_...", timeoutSec: 600 })

// 取消运行中/排队中的任务（强杀关联进程树）
anyjob({ action: "cancel", id: "job_20260910_..." })

// 列出最近历史任务
anyjob({ action: "list", limit: 20 })
```

### 3. `anytomd_setup` — 依赖管理

```ts
// 体检报告（只读）
anytomd_setup({})

// 一键自动安装缺失依赖（winget 装 pandoc、脚本装 officecli）
anytomd_setup({ install: true })
```

---

## 三、架构特点

1. **单核实现**：所有转换流在 `worker.mjs`（纯 Node，无外部运行时依赖）中统一定义，同步 `anytomd` 与异步 `anyjob` 共用同一套转换逻辑与格式分发，行为 100% 一致。
2. **密码安全**：文档密码仅在内存中临时流转（经由独立子进程环境变量透传），绝不写入 `job.json`、日志或产物文件，与 myagents-anydoc 安全策略一致。
3. **自调节并发控制**：worker 自身维持最大 16 并发槽（可通过 `ANYTOMD_MAX_CONCURRENT` 调节），超限自动在后台排队轮询。
4. **Stale 容错**：worker 定时上报心跳（`heartbeat` 文件），`status` 与 `countActiveJobs` 遇到心跳失联 + 进程消亡时自动标记为 `failed`，避免假 dead-lock。
