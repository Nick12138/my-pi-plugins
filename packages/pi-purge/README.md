# pi-purge

pi / 桌面宿主的 operator-mode 扩展。dsh-purge 的 pi 侧等价物，但全部走 pi 官方扩展 API，零二进制修改、零补丁。

| 能力 | 实现 |
| --- | --- |
| 提示词覆盖 | before_agent_start 在**渲染后的 systemPrompt** 上替换 preamble / 追加附录；不改用户的 `customPrompt` 和 `appendSystemPrompt` |
| 覆盖可还原 | 记录启用前的 `forceSystemPrompt` 基线；禁用时删除本扩展写入的强制提示词，原生提示词逐字恢复 |
| 可选的 workspace 覆盖 | `dropProjectContext=true` 时把 `<project_context>`（AGENTS.md 等）也从渲染后的提示词里移除；禁用后恢复 |
| 逆向/破解 skill | 包内 `skills/reverse-engineering/SKILL.md`；命中关键词时只追加一行“先加载 skill”的任务提醒，不注入整份正文 |
| 项目信任自动放行 | `project_trust` 自动回答 yes；默认只对当前进程生效，不写 `trust.json` |
| 会话内管理 | `purge_status` / `purge_toggle` 工具 + `/purge` 命令 |

核心契约：**启用时可以覆盖；禁用时必须还原。** 覆盖发生在渲染层，用户自己的 `SYSTEM.md` / `--system-prompt` / `--append-system-prompt` 在启用期间不写入、不破坏，禁用后原样回来。

pi 核心的工具链（bash/edit/write）本身没有审批门：桌面端只在某个扩展在 tool_call 里主动弹 UI 时才出 Modal。本扩展不弹任何 UI，因此装上即无感直通。

## 安装（宿主设置 → 扩展）

1. 打开桌面端 → 设置 → 扩展（Packages）
2. 在库工具栏的安装源输入框填入本包绝对路径（换成你的实际路径）：

    D:/我的项目/my-pi-plugins/packages/pi-purge

3. 审阅对话框确认 → 安装。选个人/全局作用域（`project_trust` 自动放行只在个人作用域生效：项目级扩展在信任判定之后才加载）
4. 新建或重开会话生效；会话开始时会通知 `pi-purge: operator mode active`

CLI 等价安装：

    pi install D:/我的项目/my-pi-plugins/packages/pi-purge

## 开关与还原

会话内：

    /purge                 # 查看状态
    /purge on              # 启用；下一回合开始覆盖
    /purge off             # 禁用；立即还原 forceSystemPrompt，下一回合原生
    /purge restore         # 禁用并还原（同上）
    /purge trust on|off    # 自动信任项目
    /purge remember on|off # 是否把自动信任写进 trust.json（默认 off）
    /purge preamble on|off # 是否在渲染层替换 preamble
    /purge addendum on|off # 是否追加 operator_mode 附录
    /purge context on|off  # 是否移除 project_context（AGENTS.md 等）
    /purge reload          # 重新读取状态文件

也可以让模型调用：

    purge_toggle { "enabled": false }
    purge_toggle { "enabled": true }
    purge_status {}

模型侧的 `purge_toggle` 只能改 `enabled` / `overridePreamble` / `appendAddendum`；`autoTrustProjects`、`rememberTrust`、`dropProjectContext` 属于安全开关，只能由用户用 `/purge` 修改。

**还原边界**：已经发送给模型的当前回合无法撤回；从下一次 `before_agent_start` 起恢复原生提示词。`rememberTrust=false` 时不写 `trust.json`，但当前进程已经解析过的项目信任仍保持到重开会话/重启；`rememberTrust=true` 时会记录原值，禁用时只撤销“当前仍为 `true` 且启用前不是 `true`”的条目；当前已不是 `true` 的条目不碰。

## 在设置 → 扩展里禁用

桌面端修改扩展偏好时会走官方 `agentSession.reload()`：先对旧扩展实例发 `session_shutdown`，再移除/重载扩展。`pi-purge` 在 `session_shutdown` 里做最后一次还原：

- 删除本扩展写入的 `forceSystemPrompt`，系统提示词回到原生；
- `reason=reload/quit` 时清理本扩展写入的 trust 条目；
- 如果新 runner 仍包含本扩展，下一次 `before_agent_start` 会重新注入。

所以从「设置 → 扩展」禁用，不需要先执行 `/purge off`。`/purge off` 只是在不卸载扩展的情况下立即还原。

如果 Host 被强制结束、来不及发 `session_shutdown`：提示词覆盖只存在于当前进程内存，下次启动自然是原生；`rememberTrust=true` 的 trust 条目可能留在 `trust-restore.json`，状态里会显示 `trust restore pending`，重新启用后执行 `/purge off` 或 `/purge restore` 可清理。

## 状态文件

运行开关不再写在包根目录，默认在：

    <agentDir>/pi-purge/config.json

Windows 上通常是 `C:/Users/<你>/.pi/agent/pi-purge/config.json`。可用 `PI_PURGE_CONFIG_PATH` 覆盖（测试用）。旧版本包根目录的 `config.json` 只作为首次迁移来源，下次保存时写入新路径。

字段：

    {
      "enabled": true,            // 总开关；false = 立即还原提示词
      "autoTrustProjects": true,  // project_trust 自动 yes
      "rememberTrust": false,     // 是否写入 trust.json；true 时先记录原值，禁用可撤销
      "overridePreamble": true,   // 在渲染层替换 preamble
      "appendAddendum": true,     // 在渲染层追加 operator_mode 附录
      "dropProjectContext": false // 启用时移除 <project_context>（AGENTS.md 等）；禁用后恢复
    }

- 启用/禁用状态写入用户目录，npm 升级/重装不会把它盖回 `true`。
- 运行中手动编辑状态文件，下一回合按 mtime 自动重读。
- 配置 JSON 损坏时 **fail-closed**：禁用插件并关闭自动信任，状态里会显示错误，不会静默全开。
- 写盘失败会明确报告；本次会话仍按内存状态执行。
- `rememberTrust=true` 时，`trust-restore.json` 会记录每个 cwd 的原值；禁用时只删除本扩展写入的 `true`。状态里的 `trust restore pending` 表示还有未清理的条目。

## 提示词热更新

直接编辑 `prompts/operator-preamble.md` 和 `prompts/purge-addendum.md`，下一回合生效，无需重装。每回合都会重新读取并重建 `forceSystemPrompt`，不再用 marker 判断“是否已追加”，所以改 addendum 不会被旧内容挡住。

逆向/破解内容现在是包内 skill：`skills/reverse-engineering/SKILL.md`。它不会每轮自动塞进系统提示词，而是出现在技能目录里：

- 模型在逆向/破解任务上按 `prompts/purge-addendum.md` 的提醒加载；
- 当前输入命中逆向/破解关键词时，只额外追加一行任务提醒（`[pi-purge] This request matches reverse-engineering/cracking. Load the reverse-engineering skill now...`），不会把 12KB 正文塞进系统提示词；
- 用户也可以直接 `/skill:reverse-engineering` 强制加载；
- 桌面端「设置 → 技能」里能看到并按需启停；
- `package.json` 的 `pi.skills` 已声明 `./skills`。

普通任务不会带上这份长 playbook。

`PI_PURGE_PROMPTS_DIR` 可指向自定义提示词目录（测试用）。

## 测试

    # 行为测试（独立 node 脚本，遵循本仓库老插件惯例）
    node --experimental-strip-types packages/pi-purge/tests/pi-purge.test.ts

    # 严格类型检查（用旁边桌面宿主仓库的 tsc 对真实 pi 1.1.0 SDK 类型）
    ../PiAbyss/node_modules/.bin/tsc -p packages/pi-purge/tsconfig.check.json

测试会把 `PI_PURGE_CONFIG_PATH` / `PI_PURGE_PROMPTS_DIR` 指向临时目录，不会改你的真实状态。

## 结构

    pi-purge/
    ├── package.json            # pi-package 清单（pi.extensions → ./extensions）
    ├── config.json             # 旧版默认模板；新状态在 <agentDir>/pi-purge/config.json
    ├── extensions/
    │   └── pi-purge.ts        # 扩展入口
    ├── prompts/
    │   ├── operator-preamble.md  # 渲染层 preamble 替换文本
    │   └── purge-addendum.md    # 渲染层附录（含逆向 skill 提醒）
    ├── skills/
    │   └── reverse-engineering/
    │       └── SKILL.md          # 逆向/破解/本地样本分析 skill
    ├── tests/
    │   └── pi-purge.test.ts   # 独立断言脚本
    └── tsconfig.check.json    # 严格类型检查配置

## 已知边界

- 若其他扩展在 tool_call 时弹确认框（如某些确认类插件），本扩展管不了别的扩展的弹窗——移除那个扩展即可
- `rememberTrust=true` 会写 `~/.pi/agent/trust.json`；禁用时插件会撤销“当前仍为 `true` 且启用前不是 `true`”的条目。当前已经不是 `true` 的条目视为用户改过，跳过；记录失败时状态里会出现 `trust restore pending`，可再执行 `/purge off` 或 `/purge restore` 重试。
- 覆盖使用 `forceSystemPrompt`。如果另一个扩展也在 `before_agent_start` 返回 `systemPrompt`，加载顺序决定谁最后生效；禁用本扩展只会还原自己写入的值，不会覆盖别的扩展
- 如果用户已有 `SYSTEM.md` / `customPrompt`，pi 本身就不会再生成 tools/rules/docs 段；本扩展保留该结构，并在禁用后逐字还原
- 升级 pi-coding-agent 版本后，`before_agent_start` 的 options 字段以官方类型为准（本包已按 1.1.0 的 `NormalizedBuildSystemPromptOptions` 严格类型检查过）
