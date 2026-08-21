# my-pi-plugins

我的 pi coding agent 插件集合仓库，同时也是 **PiDeck 插件库**的数据源：
仓库根目录的 [`plugins.json`](plugins.json) 是机器可读的注册清单，
PiDeck 前端直接读取它渲染卡片、执行安装/启用/禁用、自动生成配置界面。

## 目录结构

```
my-pi-plugins/
├── plugins.json            # 👈 插件注册清单（卡片元数据 + 安装源 + 配置规范）
├── packages/
│   └── pi-web/             # 一个插件 = packages/ 下的一个目录（标准 pi package）
│       ├── package.json    # pi manifest（pi.extensions 指向 ./extensions）
│       ├── extensions/
│       │   └── pi-web.ts   # 插件实现
│       └── README.md
├── package.json            # 仓库级 pi manifest（glob 加载所有插件，供最简安装）
└── README.md
```

## 插件一览

| 插件 | 说明 |
| --- | --- |
| **🔍 [pi-web](packages/pi-web)** | 极简联网搜索：Tavily（需 key）优先、免费 Exa MCP 兜底，自动回退 |

## 手动安装（不走 PiDeck 时）

整个仓库一次装全（随后可用 `pi config` 开关单个插件）：

```bash
pi install git:github.com/Nick12138/my-pi-plugins
```

只装某个插件（`~/.pi/agent/settings.json` 对象形式 + 过滤路径，**PiDeck 的单插件安装就是生成这段**）：

```json
{
  "packages": [
    {
      "source": "git:github.com/Nick12138/my-pi-plugins",
      "extensions": ["packages/pi-web/extensions/**"]
    }
  ]
}
```

---

## 插件库规范（plugins.json）

新增插件唯一的"注册动作"：在 `plugins.json` 的 `plugins` 数组里加一条。
前端不需要为任何插件写专属代码。

### 插件条目字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✓ | 唯一标识，小写字母/数字/连字符，如 `pi-web` |
| `name` | string | ✓ | 卡片标题 |
| `description` | string | ✓ | 卡片描述（一两句话） |
| `icon` | string | ✓ | 卡片图标：emoji（如 `"🔍"`）或本仓库图片相对路径 |
| `version` | string | ✓ | 展示用版本号 |
| `author` | string | - | 作者 |
| `tags` | string[] | - | 分类标签 |
| `install` | object | ✓ | 安装源，见下 |
| `config` | ConfigItem[] | - | **省略 = 该插件无需配置** |

### 安装源（install）

```jsonc
// 代码在本仓库内（最常用）
{ "type": "repo", "path": "packages/pi-web" }

// npm 包
{ "type": "npm", "source": "npm:xxx" }

// git 仓库
{ "type": "git", "source": "git:github.com/user/repo" }
```

- `type: "repo"`：`path` 指向本仓库内一个标准 pi package 目录。安装 = 把本仓库以
  git 源加入 `settings.json`，并用对象形式把 `extensions` 过滤到该 path（见上面的示例）。
- `type: "npm" / "git"`：`source` 原样写入 `settings.json` 的 `packages`。
- 启用/禁用 = 在 `settings.json` 中增删/调过滤条目（或调 `pi config` 等价逻辑）。

### 配置规范（config）

**只有两种控件：`text`（填内容）和 `select`（单选）。**
配置值由前端持久化、启动 pi 时以**环境变量**注入（`env` 字段决定变量名），
插件代码内一律 `process.env[<env>]` 读取——插件之间零耦合。

每项字段：

| 字段 | 适用 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | 全部 | ✓ | 表单字段唯一键（插件内唯一） |
| `type` | 全部 | ✓ | `"text"` 或 `"select"` |
| `label` | 全部 | ✓ | 控件显示名 |
| `env` | 全部 | ✓ | 注入用的环境变量名 |
| `secret` | text | - | `true` = 密码样式输入框，界面不回显明文 |
| `required` | 全部 | - | 是否必填（默认 false） |
| `placeholder` | text | - | 输入框占位 |
| `default` | 全部 | - | 默认值（select 请填某个 option 的 value） |
| `options` | select | ✓ | `[{ "value": "...", "label": "..." }]` |
| `description` | 全部 | - | 控件下方的帮助文字 |

### 新增插件 checklist

1. `packages/<id>/` 里写插件（必须有 `package.json` 带 `pi` manifest）
2. `plugins.json` 加一条条目（需要配置就填 `config`）
3. 插件代码用 `process.env[...]` 读配置；参数入参的优先级应高于环境变量（用户临时覆盖）
4. 提交推送——前端拉取清单即生效，以及仓库级 `pi update` 也能拿到

## License

MIT
