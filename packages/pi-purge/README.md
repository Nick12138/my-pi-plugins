# pi-purge

pi / PiAbyss 的 operator-mode 扩展。dsh-purge 的 pi 侧等价物，但全部走 pi 官方扩展 API，零二进制修改、零补丁。

| 能力 | 实现 |
| --- | --- |
| 系统提示词前缀替换 | before_agent_start 将 prompts/operator-preamble.md 写入 customPrompt |
| instruction-authority 附录 | before_agent_start 将 prompts/purge-addendum.md 追加到 appendSystemPrompt（幂等） |
| 项目信任自动放行 | project_trust 事件自动回答 yes + remember，免弹窗 |
| 会话内管理 | purge_status / purge_toggle 工具 + /purge 命令 |

pi 核心的工具链（bash/edit/write）本身没有审批门：PiAbyss 只在某个扩展在 tool_call 里主动弹 UI 时才出 Modal。本扩展不弹任何 UI，因此装上即无感直通。

## 安装（PiAbyss 设置 → 扩展）

1. 打开 PiAbyss → 设置 → 扩展（Packages）
2. 在库工具栏的安装源输入框填入本包绝对路径：

    C:/Users/liu/Documents/我的项目/my-pi-plugins/packages/pi-purge

3. 审阅对话框确认 → 安装。选个人/全局作用域（project_trust 自动放行只在个人作用域生效：项目级扩展在信任判定之后才加载）
4. 新建或重开会话生效；会话开始时会通知 pi-purge: operator mode active

CLI 等价安装：

    pi install C:/Users/liu/Documents/我的项目/my-pi-plugins/packages/pi-purge

## 开关

- 会话内：让模型调 purge_toggle { "enabled": false }，或输入 /purge off（/purge 查看状态，/purge on|off，/purge trust on|off）
- 手动：编辑包根目录 config.json（四个布尔开关），下一回合生效
- 改提示词：直接编辑 prompts/*.md，无需重装，新回合生效

config.json 字段：

    {
      "enabled": true,            // 总开关，false = 完全旁路，恢复原生行为
      "autoTrustProjects": true,  // project_trust 自动 yes
      "overridePreamble": true,   // 替换默认系统提示词前缀
      "appendAddendum": true     // 追加 operator_mode 附录
    }

## 测试

    # 行为测试（独立 node 脚本，遵循本仓库老插件惯例）
    node --experimental-strip-types packages/pi-purge/tests/pi-purge.test.ts

    # 严格类型检查（用 PiAbyss 的 tsc 对真实 pi SDK 类型）
    PiAbyss/node_modules/.bin/tsc -p packages/pi-purge/tsconfig.check.json

## 结构

    pi-purge/
    ├── package.json            # pi-package 清单（pi.extensions → ./extensions）
    ├── config.json            # 运行开关（在线可改，自动持久化）
    ├── extensions/
    │   └── pi-purge.ts        # 扩展入口
    ├── prompts/
    │   ├── operator-preamble.md  # customPrompt 替换文本
    │   └── purge-addendum.md    # appendSystemPrompt 附录
    ├── tests/
    │   └── pi-purge.test.ts   # 独立断言脚本
    └── tsconfig.check.json    # 严格类型检查配置

## 已知边界

- 若其他扩展在 tool_call 时弹确认框（如某些确认类插件），本扩展管不了别的扩展的弹窗——移除那个扩展即可
- purge_toggle 的持久化依赖包目录可写；本地路径安装（不复制）必然可写，npm 安装时静默降级为内存态
- 升级 pi-coding-agent 版本后，before_agent_start 的 options 字段以官方类型为准（本包已按 1.1.0 的 NormalizedBuildSystemPromptOptions 严格类型检查过）

