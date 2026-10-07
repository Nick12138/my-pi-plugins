/**
 * 答案模型、选中值解析与结果文本格式化 —— 照搬自 PiAbyss `ask-user-question-tool.ts`。
 */
import type { AskUserQuestion } from "./schema.js";

export type QuestionAnswer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
};

export type QuestionnaireResult = {
  answers: QuestionAnswer[];
  cancelled: boolean;
};

/**
 * 把 `ui.select` 的返回值翻译成一条答案。
 *
 * 三种来源必须区分：命中选项映射 → 选项答案；等于哨兵串 → 由调用方追问自由
 * 文本；其余任何串 → 桌面卡片自由输入框直接提交的文本（`allowFreeform`）。
 */
export function resolveSelection(
  plan: SelectPlanLike,
  question: AskUserQuestion,
  questionIndex: number,
  selected: string,
): { answer: QuestionAnswer } | { freeform: true } {
  const index = plan.byValue.get(selected);
  if (index !== undefined) {
    return {
      answer: {
        questionIndex,
        question: question.question,
        kind: "option",
        answer: question.options[index]!.label,
      },
    };
  }
  if (selected === plan.customValue) return { freeform: true };
  return {
    answer: { questionIndex, question: question.question, kind: "custom", answer: selected },
  };
}

/** 只依赖「串 → 下标」映射与哨兵行，避免测试与格式化路径耦合到载荷构造。 */
type SelectPlanLike = {
  byValue: Map<string, number>;
  customValue: string;
};

/** 多选编号输入的解析结果。 */
export type MultiSelection = { kind: "multi"; selected: string[] } | { kind: "custom"; answer: string };

/**
 * 解析多选题的 `ui.input` 返回值：空输入 = 空多选；纯编号 token（含尾点，
 * 如 "2."）按下标去重取标签；任何非编号 token 视为用户直接输入的自定义答案。
 */
export function parseMultiSelection(
  value: string,
  questionIndex: number,
  question: string,
  options: ReadonlyArray<{ label: string }>,
): MultiSelection {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "multi", selected: [] };
  const tokens = trimmed.split(/[,\s]+/).filter((token) => token.length > 0);
  const indices = tokens.map((token) => {
    if (!/^\d+\.?$/.test(token)) return null;
    const index = Number.parseInt(token, 10) - 1;
    return index >= 0 && index < options.length ? index : null;
  });
  if (indices.every((index): index is number => index !== null)) {
    const selected: string[] = [];
    for (const index of indices) {
      const label = options[index]!.label;
      if (!selected.includes(label)) selected.push(label);
    }
    return { kind: "multi", selected };
  }
  // 任何非下标 token 都视为用户直接输入的自定义答案，而不是静默丢弃。
  return { kind: "custom", answer: trimmed };
}

/** 面向模型的结果文本：逐题回显问题与答案。 */
export function formatAnswers(result: QuestionnaireResult): string {
  if (result.cancelled) {
    return result.answers.length === 0
      ? "The user cancelled the questionnaire without answering."
      : `The user cancelled the questionnaire after answering ${result.answers.length} of the questions.`;
  }
  return result.answers
    .map((answer) => {
      const value =
        answer.kind === "multi" ? (answer.selected ?? []).join(", ") : (answer.answer ?? "");
      return `${answer.question} -> ${value}`;
    })
    .join("\n");
}
