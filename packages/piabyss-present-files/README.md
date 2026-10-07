# piabyss-present-files

把 PiAbyss 内置工具 `piabyss_present_files` 外移为 pi 插件。

## 功能

Agent 在回合结尾调用 `piabyss_present_files`，声明本轮真正交付给用户的结果
文件（报告、生成的文档、改过的 PDF/Word 等）。工具**纯声明式**：不落盘、
不改状态，声明随会话历史里的 tool 块一起持久化，会话重放后仍可还原。

参数结构：

```jsonc
{
  "files": [
    { "path": "reports/spec.docx", "label": "可选的短标题" }
  ] // minItems: 1，path 相对工作区根目录，禁止绝对路径与 file:// URL
}
```

执行时对每个路径做**软校验**（`stat`，相对 `ctx.sessionManager.getCwd()` 解析）：
缺失不阻断声明，只在确认文本里提示，由模型自行决定是否更正后重新声明。
`path` 规范化后为空则报错。

## 前端契约（不可破坏）

PiAbyss 桌面前端（`apps/desktop/src/features/chat/result-files.ts`）**按工具名
`piabyss_present_files`** 从会话历史的 tool 块里还原文件胶囊，并解析 `files`
参数中的 `{ path, label? }` 渲染。因此：

- **工具名绝对不能改** —— 改名后前端找不到对应 tool 块，文件胶囊功能即消失；
- **`files` 参数结构（`path` / 可选 `label`）绝对不能改**；
- PDF/Office 文档点击走系统默认程序打开，markdown 与代码文件在 PiAbyss
  右侧 Dock 内置预览打开。

## 来源

参考实现：`PiAbyss/packages/pi-host/src/present-files-tool.ts`（工具描述、
格式化函数与执行逻辑逐行照搬）。本包为纯外移，未改变任何行为。

## 测试

```sh
npx vitest run packages/piabyss-present-files
```
