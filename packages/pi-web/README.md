# 🔍 pi-web

极简联网搜索插件。只暴露一个工具 `web_search`，两个引擎，零脏活儿。

## 引擎选择

```
auto（默认）
  ├─ 配了 TAVILY_API_KEY → Tavily ──失败──→ 自动回退 Exa MCP
  └─ 没配                → Exa MCP（免费托管端点，无需注册）
```

显式传 `provider="tavily"` / `provider="exa"` 可强制指定（不再回退，便于排查）。

## 工具

```
web_search({ query, numResults?, provider? })
```

| 参数 | 说明 |
| --- | --- |
| `query` | 搜索词（必填） |
| `numResults` | 1–10，默认 5 |
| `provider` | `"auto"` / `"tavily"` / `"exa"`，默认 auto |

## 配置（环境变量）

| 环境变量 | 控件类型 | 说明 |
| --- | --- | --- |
| `TAVILY_API_KEY` | text（secret） | 填上使用 Tavily；留空走免费 Exa MCP |
| `PI_WEB_PROVIDER` | select | `auto` / `tavily` / `exa`，默认 auto；工具参数优先于它 |

配置项与仓库根目录 [plugins.json](../../plugins.json) 中的 `config` 声明一一对应。

## 注意

与 `pi-web-access` 都注册了 `web_search`，**不要同时启用**。
