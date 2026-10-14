# pi-ask-user-question

给 pi 的结构化提问工具 `ask_user_question`：模型在你需要拍板（方案取舍、布局、确认偏好）时，
用一次调用抛出 1–4 道题，每题 2–4 个带描述/预览的选项，并自动附加一行
"Type something." 哨兵支持自由文本回答；第 2 题起还会附加一行 `↩ 修改上一题`
哨兵，可以退回上一题重答。

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
- 多选题（`multiSelect: true`）：原生 `ui.select` 只能单选，所以仍走 `ctx.ui.input`，
  但把选项以 `piabyss.optionDetails` + `multiSelect: true` **结构化**下发 ——
  PiAbyss 桌面据此渲染成复选框列表，确认时把勾选的 1-based 下标拼成 `"1,3"` 回传；
  不认这套元数据的宿主则退化成「编号列表 + 文本框」（编号列表放在 dialog 的
  message 里，桌面渲染复选框时会把 message 隐去）。空输入 = 空多选，
  任何非编号 token 视为用户输入的自定义答案。
- **回退重答**：第 2 题起，每题末尾追加一行 `↩ 修改上一题` 哨兵；选中它（多选题则在
  输入框里原样输入该标签）即退回上一题重新作答，上次的选择经 `piabyss.defaultValue`
  回传、由桌面端预选。循环在插件内完成 —— 宿主与插件之间只有 `ui.select` /
  `ui.input` 的单向返回值，协议没有「撤销上一次作答」的方法，答案一旦 return
  就已经交给模型，所以回滚只能发生在答案尚未交出的这一层。
- `piabyss` 元数据：`optionDetails` / `allowFreeform` / `questionIndex` /
  `questionCount` / `questionHeader` / `defaultValue`。前两者供桌面渲染下拉与输入框，
  后四个供桌面画题号进度、渲染 header chip，并在回退重问时预选上次答案。
- 取消语义：任何一题取消即整体 `cancelled: true`，已作答的题目保留在结果里
  （回退后再取消，不会带上用户已经退回去的那几题）。

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
