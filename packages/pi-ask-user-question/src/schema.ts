/**
 * TypeBox 参数 schema 与派生类型 —— 照搬自 PiAbyss `ask-user-question-tool.ts`。
 */
import { Type, type Static } from "typebox";
import {
  CUSTOM_ROW_LABEL,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
} from "./constants.js";

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: `≤${MAX_LABEL_LENGTH} 字符的选项标题（1-5 个词）。`,
  }),
  description: Type.String({
    description: "一句话说明该选项含义/取舍。",
  }),
  preview: Type.Optional(
    Type.String({
      description: "可选：markdown 预览（线框、ASCII 图、代码），并排等宽面板显示。",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description: "完整问句，以问号结尾；多选时措辞相应调整。",
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: `≤${MAX_HEADER_LENGTH} 字符的短标签（如「方案」「范围」）。`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `选项 ${MIN_OPTIONS}-${MAX_OPTIONS} 个；未开多选时互斥。「${CUSTOM_ROW_LABEL}」行自动追加，不要自己写。`,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: "允许多选。",
    }),
  ),
});

export const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: `要问的问题（1-${MAX_QUESTIONS}）。`,
  }),
});

export type AskUserQuestion = Static<typeof QuestionSchema>;
export type AskUserParams = Static<typeof QuestionParamsSchema>;

/** 模型可见的工具说明：只讲何时用/何时别用。 */
export const TOOL_DESCRIPTION =
  "需要用户在几个方案里做选择、否则只能猜时，一次性问结构化问题（1-4 题，每题 2-4 个选项）。不要用它确认你马上要执行的动作。";
