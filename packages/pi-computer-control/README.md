# pi-computer-control

让 AI 直接看屏幕、操作真实桌面：截图、移动/点击/双击/拖拽鼠标、输入文字（含中文等 Unicode）、组合键、滚轮滚动。

**仅支持 Windows**（桌面交互会话）。零原生 npm 依赖：后端是一个持久化 PowerShell 子进程，内嵌 C#（user32 `SendInput` + GDI `CopyFromScreen`），Node 侧通过 stdio 一行一个 JSON 的 RPC 与其通信。

## 安装

本仓库（`my-pi-plugins`）注册表安装：

```text
{ "packages": [ { "source": "git:github.com/Nick12138/my-pi-plugins", "extensions": ["packages/pi-computer-control/extensions/**"] } ] }
```

或直接本地加载：

```bash
pi -e packages/pi-computer-control/extensions/pi-computer-control.ts
```

## 工具

| 工具 | 说明 |
| --- | --- |
| `computer_screenshot` | 截取整个虚拟屏幕或指定区域，图片直接返回给模型；默认按最长边缩到 1568px（JPEG），并在结果文本中注明与物理像素的换算比例 |
| `computer_action` | **批量**执行动作：`move` / `click`（含双击、右键、中键）/ `drag` / `scroll` / `type`（Unicode，含中文）/ `key`（如 `ctrl+c`、`alt+tab`、`f5`）/ `wait`；`screenshot: true` 时附送一张结果截图，省去额外一次截图往返 |
| `computer_info` | 虚拟屏幕尺寸（多显示器可为负原点）、当前光标位置、活动窗口标题；兼作后端健康检查 |

另有 `/computer-control` 命令显示后端状态。

## 典型用法

1. 先 `computer_screenshot` 看屏幕，拿到坐标；
2. 把依赖的步骤合并成一次 `computer_action`（点输入框 → type 打字 → key enter），`screenshot: true` 看结果；
3. 循环：看 → 操作 → 看。

## 坐标系

- 所有坐标是**物理像素**（后端启动时设置 `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`），与截图一致；
- 多显示器时虚拟屏幕原点可能为负数（如副屏在主屏左侧时原点为 `(-1920, 0)`）；
- 若截图结果被缩小，结果文本会给出比例，把图上读到的坐标乘以比例即可换算回物理像素。

## 实现说明

- 输入模拟全部走 `SendInput`（硬件级事件，走过的软件大多认）；中文等非 ASCII 文本用 `KEYEVENTF_UNICODE` 逐字符注入；
- 文本参数在 JSON-RPC 中以 base64(UTF-8) 传输，规避控制台代码页对 CJK 的破坏；
- 后端随首次工具调用惰性启动，`session_shutdown` 时关闭；进程崩溃后下次调用自动重启。

## 本地测试

```bash
node test-backend.mjs   # ping / screenInfo / 截图 / 光标移动（无破坏性操作）
```
