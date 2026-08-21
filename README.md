# my-pi-plugins

我的 pi coding agent 插件集合仓库。一个仓库装所有插件，一次安装全部加载；
只想要其中某个插件时，可在 `settings.json` 里按路径过滤（见下文[按需加载](#按需加载)）。

## 插件一览

| 插件 | 文件 | 说明 |
| --- | --- | --- |
| **pi-web** | [extensions/pi-web.ts](extensions/pi-web.ts) | 极简联网搜索：Tavily（需 key）+ Exa MCP（免费免 key），自动选择、失败自动回退 |

## 安装

```bash
pi install git:github.com/Nick12138/my-pi-plugins
```

更新：

```bash
pi update
```

### 按需加载

在 `~/.pi/agent/settings.json`（或项目 `.pi/settings.json`）中用对象形式只启用指定插件：

```json
{
  "packages": [
    {
      "source": "git:github.com/Nick12138/my-pi-plugins",
      "extensions": ["extensions/pi-web.ts"]
    }
  ]
}
```

也可以正常全装，然后用 `pi config` 交互式开关单个插件。

---

## pi-web

一个文件、零依赖的联网搜索插件。只暴露一个工具 `web_search`：

```
web_search({ query, numResults?, provider? })
```

| 参数 | 说明 |
| --- | --- |
| `query` | 搜索词（必填） |
| `numResults` | 返回条数，1–10，默认 5 |
| `provider` | `"auto"`（默认）/ `"tavily"` / `"exa"` |

### 引擎选择逻辑

```
auto 模式：
  配置了 TAVILY_API_KEY → 用 Tavily
    └─ Tavily 失败 → 自动回退 Exa MCP
  没配置 → 直接用 Exa MCP（免费，无需注册）
```

- **Exa MCP**（`https://mcp.exa.ai/mcp`）：Exa 官方的免费托管 MCP 端点，完全不用配置。
- **Tavily**：质量更高的商业搜索 API，有免费额度；配置环境变量即自动启用。

注意：**显式指定 `provider="tavily"` 时不会回退**，失败会直接报 Tavily 的错误——方便排查 key 是否配置正确。

### 配置 Tavily

```bash
# Bash / WSL
export TAVILY_API_KEY=tvly-...

# Windows PowerShell（当前会话）
$env:TAVILY_API_KEY = "tvly-..."

# Windows（永久写入用户环境变量）
setx TAVILY_API_KEY "tvly-..."
```

不配就能用——会走免费的 Exa MCP。

### 与 pi-web-access 的冲突

本插件和 `pi-web-access` 都注册名为 `web_search` 的工具，**不要同时启用**。如果装过 pi-web-access，请从 settings.json 的 `packages` 中移除 `npm:pi-web-access`。

---

## 添加新插件

在 `extensions/` 下新增一个 `.ts` 文件（默认导出 `ExtensionAPI` 工厂函数）即会被自动加载：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ /* ... */ });
}
```

参考官方文档：[extensions.md](https://github.com/earendil-works/pi-coding-agent) · [packages.md](https://github.com/earendil-works/pi-coding-agent)

## License

MIT
