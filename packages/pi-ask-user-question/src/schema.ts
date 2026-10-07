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
    description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS. Concise (1-5 words) display text for this choice.`,
  }),
  description: Type.String({
    description:
      "One-line explanation of what this option means or its trade-offs. Shown under the label.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional markdown preview for this option: mockups, ASCII layouts, code snippets, diagrams. Rendered in a monospace panel beside the options. Prefer fenced code blocks for ASCII art so alignment is preserved.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      "The complete question to ask. Clear, specific, ending with a question mark. If multiSelect is true, phrase it accordingly.",
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS. Very short chip shown next to the question, e.g. "Auth method", "Layout".`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `The available choices (${MIN_OPTIONS}-${MAX_OPTIONS}). Mutually exclusive unless multiSelect is set. A "${CUSTOM_ROW_LABEL}" row is appended automatically — do NOT author it.`,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Allow selecting several options instead of one.",
    }),
  ),
});

export const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: `Questions to ask the user (1-${MAX_QUESTIONS}).`,
  }),
});

export type AskUserQuestion = Static<typeof QuestionSchema>;
export type AskUserParams = Static<typeof QuestionParamsSchema>;

/** 模型可见的工具说明：保留 rpiv 的关键引导，但更短。 */
export const TOOL_DESCRIPTION = [
  "Ask the user a structured question when you would otherwise have to guess.",
  "",
  `- Provide 1-${MAX_QUESTIONS} questions, each with ${MIN_OPTIONS}-${MAX_OPTIONS} options.`,
  "- Each option needs a concise label (1-5 words) and a one-line description.",
  "- Use multiSelect: true when several answers may apply.",
  "- Use options[].preview for mockups, ASCII layouts, code snippets or diagrams that help compare choices. Prefer fenced code blocks for ASCII art.",
  `- A "${CUSTOM_ROW_LABEL}" row is appended to every question automatically; do NOT author "Other" or "${CUSTOM_ROW_LABEL}" yourself.`,
  "- Do not use this tool to ask for confirmation of an action you are about to take; just take it.",
].join("\n");
