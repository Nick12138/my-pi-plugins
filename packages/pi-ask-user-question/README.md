# pi-ask-user-question

给 pi 的结构化提问工具 `ask_user_question`：模型在你需要拍板（方案取舍、布局、确认偏好）时，
用一次调用抛出 1–4 道题，每题 2–4 个带描述/预览的选项，并自动附加一行
"Type something." 哨兵支持自由文本回答。

**来源**：逐字节外移自 PiAbyss 内置工具
（`PiAbyss/packages/pi-host/src/ask-user-question-tool.ts`），返回信封保持
`{ answers, cancelled }` 形状，桌面端的卡片串联、队列整合与过期处理无需改动。

## 行为

- 单选题：每道题压成一次 `ctx.ui.select(title, values, { piabyss: { optionDetails, allowFreeform: true } })`，
  选项的 `description` / `preview` 经 `piabyss.optionDetails` 元数据一并送出，
  桌面端复用内联/弹窗卡片渲染等宽预览面板。
  注意：`piabyss` 元数据是 PiAbyss 定制扩展，仅在 PiAbyss Host 下生效；
  纯 pi 运行时会静默忽略（下拉可用，但 optionDetails/预览与 allowFreeform 不生效）。
- 重复标签自动去重追加 `(2)`，保证「选项串 → 下标」映射唯一。
- 选中哨兵行 `Type something.` 会追问一次自由文本 `ctx.ui.input`；
  桌面端 `allowFreeform` 直接提交的自定义文本也按自定义答案处理。
- 多选题（`multiSelect: true`）：走编号 `ctx.ui.input`（`"1,3"` 格式），
  空输入 = 空多选，任何非编号 token 视为用户输入的自定义答案。
- 取消语义：任何一题取消即整体 `cancelled: true`，已作答的题目保留在结果里。

## 开关

读取 `<agentDir>/settings.json` 的 `askUserQuestionEnabled`（缺省为开，
仅显式 `false` 关闭；文件不存在或读失败都按开处理）。开关在每轮
`before_agent_start` 生效，改完无需重建会话。不走任何 SettingsManager。

## 目录

- `extensions/pi-ask-user-question.ts` — 扩展入口：注册工具 + 激活钩子
- `src/constants.ts` / `schema.ts` — 边界常量与 TypeBox 参数 schema
- `src/select-plan.ts` — 标签去重与 `ui.select` 载荷构造
- `src/answers.ts` — 答案模型、选中值/多选输入解析、结果文本格式化
- `src/questionnaire.ts` — 问卷执行流程
- `src/tool.ts` / `src/activation.ts` — 工具定义与 settings.json 开关
- `tests/` — vitest 单测（stub `ctx.ui.select` / `ctx.ui.input`）

## 测试

```sh
npx vitest run packages/pi-ask-user-question
```
