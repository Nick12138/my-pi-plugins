/**
 * 问卷执行流程：依次询问每道题，任何一题取消即整体取消。
 *
 * 照搬自 PiAbyss `ask-user-question-tool.ts` 的 `runQuestionnaire` /
 * `askMultiSelect`（解析纯函数拆至 `answers.ts`，行为逐字节一致）。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionAnswer, QuestionnaireResult } from "./answers.js";
import { parseMultiSelection, resolveSelection } from "./answers.js";
import { buildSelectPlan } from "./select-plan.js";
import type { AskUserParams, AskUserQuestion } from "./schema.js";

/** 多选：原生 select 无多选能力，用数字输入承载，语义与 rpiv 一致。 */
export async function askMultiSelect(
  ctx: ExtensionContext,
  question: AskUserQuestion,
  questionIndex: number,
  header: string,
): Promise<QuestionAnswer | undefined> {
  const list = question.options
    .map((option, index) => `${index + 1}. ${option.label} — ${option.description}`)
    .join("\n");
  const value = await ctx.ui.input(
    `${header}${question.question}\n\n${list}\n\nEnter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer.`,
    "1,3",
  );
  if (value === undefined) return undefined;
  const parsed = parseMultiSelection(value, questionIndex, question.question, question.options);
  if (parsed.kind === "multi") {
    return {
      questionIndex,
      question: question.question,
      kind: "multi",
      answer: null,
      selected: parsed.selected,
    };
  }
  return { questionIndex, question: question.question, kind: "custom", answer: parsed.answer };
}

/**
 * 依次询问每道题。任何一次取消都会终止整份问卷（与 rpiv 的 Esc 语义一致），
 * 已作答的部分保留在结果里。
 */
export async function runQuestionnaire(
  ctx: ExtensionContext,
  params: AskUserParams,
): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex += 1) {
    const question = params.questions[questionIndex]!;
    const header = question.header ? `[${question.header}] ` : "";

    if (question.multiSelect) {
      const answer = await askMultiSelect(ctx, question, questionIndex, header);
      if (!answer) return { answers, cancelled: true };
      answers.push(answer);
      continue;
    }

    const plan = buildSelectPlan(question);
    const selected = await ctx.ui.select(`${header}${question.question}`, plan.values, {
      piabyss: {
        optionDetails: plan.optionDetails,
        allowFreeform: true,
      },
    });
    if (selected === undefined) return { answers, cancelled: true };

    const resolved = resolveSelection(plan, question, questionIndex, selected);
    if ("answer" in resolved) {
      answers.push(resolved.answer);
      continue;
    }
    const typed = await ctx.ui.input(`${header}${question.question}`, "");
    if (typed === undefined) return { answers, cancelled: true };
    answers.push({
      questionIndex,
      question: question.question,
      kind: "custom",
      answer: typed,
    });
  }
  return { answers, cancelled: false };
}
