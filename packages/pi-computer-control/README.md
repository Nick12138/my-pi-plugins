# pi-computer-control

让 AI 直接看屏幕、操作真实桌面：截图、鼠标键盘、窗口管理、后台窗口定向输入、UIA 元素级操作。

**仅支持 Windows**（桌面交互会话）。零原生 npm 依赖：后端是一个持久化 PowerShell 子进程，内嵌 C#（user32 `SendInput`/`PostMessage` + GDI 截图 + UIAutomation），Node 侧通过 stdio 一行一个 JSON 的 RPC 与其通信。

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
| `computer_window_screenshot` | 截取**单个窗口**（PrintWindow，窗口被遮挡时通常也能截到；最小化时不行） |
| `computer_action` | **批量**前台动作：`move` / `click`（含双击、右键、中键）/ `drag` / `scroll` / `type`（Unicode，含中文）/ `key`（如 `ctrl+c`、`alt+tab`、`f5`）/ `wait`；`screenshot: true` 时附送一张结果截图，省去额外一次截图往返 |
| `computer_bg_action` | **批量后台动作**：把 click / scroll / type / key 定向发送到指定窗口（PostMessage），**不移动鼠标、不抢键盘焦点**，用户可以继续干自己的事。坐标用窗口客户区坐标 |
| `computer_window` | 窗口管理：`list`（可按标题过滤）/ `info` / `activate` / `minimize` / `maximize` / `restore` / `hide` / `show` / `move`（移动+缩放）/ `close`（WM_CLOSE，应用可能弹确认） |
| `computer_find` | **UIA 元素查找**：按可见文本（name 子串）、automationId、控件类型在窗口里找控件，直接返回其边界中心坐标（可直接用于点击），免去"截图→猜坐标"的循环 |
| `computer_invoke` | **UIA 元素调用**：对找到的按钮/复选框/列表项执行 Invoke/Toggle/Select/Expand，找不到 pattern 时回退真实点击 |
| `computer_info` | 虚拟屏幕尺寸（多显示器可为负原点）、当前光标位置、活动窗口标题、后端版本；兼作后端健康检查 |
| `computer_help` | 详细用法指南（工作流建议、坐标系、后台输入兼容性、排错），按需加载，不占常驻上下文 |

另有 `/computer-control` 命令：显示后端状态，支持 `on` / `off` / `status` —— `off` 会在**本会话内**禁用所有桌面控制工具（安全开关）。

## 典型用法

**前台自动化**（鼠标键盘真实操作）：

1. 先 `computer_screenshot` 看屏幕，拿到坐标；
2. 把依赖的步骤合并成一次 `computer_action`（点输入框 → type 打字 → key enter），`screenshot: true` 看结果；
3. 循环：看 → 操作 → 看。

**后台自动化**（不抢用户焦点）：

1. `computer_window list` 找到目标窗口的 hwnd；
2. `computer_window_screenshot` 看窗口内容；
3. `computer_bg_action` 批量下发后台动作（注意坐标是**窗口客户区坐标**）；
4. 再次 `computer_window_screenshot` 验证。

**UIA 优先**（知道控件文字时最准）：

1. `computer_window list` → `computer_find`（如 `name: "确定"`, `controlType: "button"`）；
2. `computer_invoke` 直接按下，无需坐标；或用返回的 center 坐标做 `computer_action` 点击。

## 坐标系

- `computer_action` / `computer_find` / `computer_window`：**物理像素**（后端启动时设置 `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`），与截图一致；多显示器时虚拟屏幕原点可能为负数（如副屏在主屏左侧时原点为 `(-1920, 0)`）；若截图结果被缩小，结果文本会给出比例，把图上读到的坐标乘以比例即可换算回物理像素。
- `computer_bg_action`：**窗口客户区坐标**（相对于目标窗口左上角），与 `computer_window info` 返回的窗口位置换算。

## 后台输入兼容性

后台输入通过 PostMessage 实现，兼容性因应用而异：

- ✅ 通常可用：经典 Win32 控件（EDIT 等）、多数 WinForms/WPF 应用
- ❌ 常被忽略：Chromium/Electron 应用（浏览器、VS Code、Slack 等）、WinUI3/UWP 应用 —— 遇到时回退到前台 `computer_action`

## 实现说明

- 前台输入走 `SendInput`（硬件级事件，走过的软件大多认）；中文等非 ASCII 文本用 `KEYEVENTF_UNICODE` 逐字符注入；
- 后台键盘输入先定位窗口线程的焦点子控件（`GetGUIThreadInfo`），优先尝试 `EM_REPLACESEL`（跨进程写入 UTF-16 文本，无损），失败则回退 `WM_CHAR` / `WM_IME_CHAR`（ANSI 代码页，GBK 下支持中文但 emoji 等会变 `?`）；
- UIA 走 Windows UIAutomation（`UIAutomationClient`），按 `TreeScope.Descendants` 全树查找；
- 文本参数在 JSON-RPC 中以 base64(UTF-8) 传输，规避控制台代码页对 CJK 的破坏；
- 后端随首次工具调用惰性启动，`session_shutdown` 时关闭；进程崩溃后下次调用自动重启。

## 本地测试

```bash
node test-backend.mjs   # ping / screenInfo / listWindows / 截图 / UIA / 窗口截图（无破坏性操作）
```
