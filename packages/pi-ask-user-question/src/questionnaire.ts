/**
 * 问卷执行流程：依次询问每道题，任何一题取消即整体取消。
 *
 * 与桌面宿主内置实现同源的 `ask-user-question-tool.ts` 的 `runQuestionnaire` /
 * `askMultiSelect`（解析纯函数拆至 `answers.ts`，行为逐字节一致），并在此之上
 * 增加**回退重答**：第 2 题起，每题追加一行回退哨兵（`↩ 修改上一题`），选中它
 * 即退回答上一题、带着上次的选择重新问一次。
 *
 * 为什么必须在这一层做：宿主与插件之间只有 `ui.select` / `ui.input` 的单向
 * 返回值，协议没有「撤销上一次作答」的方法。答案一旦 `return` 出去就已经交给
 * 模型了，所以回滚只能在答案尚未交出的地方发生 —— 也就是这个循环里。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAaMultiSelectMarker } from "./aa-marker.js";
import type { QuestionAnswer, QuestionnaireResult } from "./answers.js";
import { parseMultiSelection, resolveSelection } from "./answers.js";
import { BACK_ROW_LABEL, BACK_ROW_PREFIX } from "./constants.js";
import { buildSelectPlan } from "./select-plan.js";
import type { AskUserParams, AskUserQuestion } from "./schema.js";

const MULTI_SELECT_INSTRUCTIONS =
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer.';

/** 单题的结局：作答、回退上一题、或取消整份问卷。 */
type AskOutcome =
  | { kind: "answer"; answer: QuestionAnswer; rawValue: string }
  | { kind: "back" }
  | { kind: "cancelled" };

type StepContext = {
  question: AskUserQuestion;
  /** 0 起的题目下标。 */
  questionIndex: number;
  questionCount: number;
  /** 拼进标题的 `[header] ` 前缀。 */
  header: string;
  /** 第一题没有上一题可回退。 */
  allowBack: boolean;
  /** 上一次这道题的原始作答串，回退后据此预填。 */
  previous?: string;
};

/**
 * 随 `ui.select` / `ui.input` 一起下发的桌面宿主扩展元数据。
 *
 * 元数据同时挂在两个键下：通用键 `askUserQuestion` 是本插件的正式命名；
 * 旧键 `piabyss` 是早期桌面宿主的遗留读取键，保留是为了让旧版桌面端
 * 继续渲染选项列表/复选框/回退预选。两个键的内容完全一致，宿主取其一即可。
 *
 * `questionIndex` / `questionCount` / `questionHeader` 让桌面卡片能画出题号进度
 * 并把 header 渲染成 chip，而不是把它硬拼进标题；`defaultValue` 让回退重问时
 * 预选上一次的答案。三者都是提示，宿主不认识就忽略。
 */
function questionMeta(step: StepContext, extra: Record<string, unknown>): Record<string, unknown> {
  const meta = {
    questionIndex: step.questionIndex + 1,
    questionCount: step.questionCount,
    ...(step.question.header ? { questionHeader: step.question.header } : {}),
    ...(step.previous !== undefined && step.previous !== ""
      ? { defaultValue: step.previous }
      : {}),
    ...extra,
  };
  // 双键下发：`askUserQuestion`（通用）+ `piabyss`（遗留桌面端兼容，见上）。
  return { askUserQuestion: meta, piabyss: meta };
}

/**
 * 多选：原生 `ui.select` 只能单选，所以仍走 `ui.input`，但把选项以
 * `askUserQuestion.optionDetails`（旧桌面端读遗留键 `piabyss.optionDetails`，两者同内容）
 * + `multiSelect: true` 结构化下发。
 *
 * 桌面端据此渲染成**复选框列表**，确认时把勾选的 1-based 下标拼成
 * `"1,3"` 回传 —— 与下面的 `parseMultiSelection` 完全对齐，解析逻辑不用改。
 * 不认这套元数据的宿主则退化成「选项列表 + 一个文本框」，因此选项列表放在
 * dialog 的 message 里（不是拼进标题），桌面渲染复选框时会把 message 隐去。
 */
export async function askMultiSelect(
  ctx: ExtensionContext,
  step: StepContext,
): Promise<AskOutcome> {
  const { question, header } = step;
  const plan = buildSelectPlan(question, { includeCustomRow: false, includeBackRow: false });
  const list = question.options
    .map((option, index) => `${index + 1}. ${option.label} — ${option.description}`)
    .join("\n");
  const backHint = step.allowBack
    ? `\n\n${BACK_ROW_LABEL} = go back and change the previous answer`
    : "";
  // 只有 RPC 宿主（Agents-Anywhere / 桌面宿主）需要这行结构化标记：它们拿不到
  // `ui.input` 的第三个参数，否则多选只能退化成空文本框。pi 自己的 TUI 走不到
  // 这里（ctx.mode === "tui"），placeholder 保持纯人读文本不变。
  const marker =
    ctx.mode === "rpc"
      ? `\n${buildAaMultiSelectMarker({
          v: 1,
          kind: "multiSelect",
          prompt: question.question,
          ...(question.header ? { header: question.header } : {}),
          questionIndex: step.questionIndex + 1,
          questionCount: step.questionCount,
          allowCustom: true,
          allowBack: step.allowBack,
          ...(step.allowBack ? { backValue: BACK_ROW_LABEL } : {}),
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        })}`
      : "";
  const value = await ctx.ui.input(
    `${header}${question.question}`,
    `${list}\n\n${MULTI_SELECT_INSTRUCTIONS}${backHint}${marker}`,
    questionMeta(step, {
      optionDetails: plan.optionDetails,
      multiSelect: true,
      allowFreeform: true,
      allowBack: step.allowBack,
    }),
  );
  if (value === undefined) return { kind: "cancelled" };
  // 桌面的「修改上一题」按钮回传的是同一个 `↩` 前缀值；按前缀匹配，后缀可本地化。
  if (step.allowBack && value.trim().startsWith(BACK_ROW_PREFIX)) return { kind: "back" };
  const parsed = parseMultiSelection(value, step.questionIndex, question.question, question.options);
  if (parsed.kind === "multi") {
    return {
      kind: "answer",
      rawValue: value,
      answer: {
        questionIndex: step.questionIndex,
        question: question.question,
        kind: "multi",
        answer: null,
        selected: parsed.selected,
      },
    };
  }
  return {
    kind: "answer",
    rawValue: value,
    answer: {
      questionIndex: step.questionIndex,
      question: question.question,
      kind: "custom",
      answer: parsed.answer,
    },
  };
}

/** 单选：一次 `ui.select`，命中自由输入哨兵时再补一次 `ui.input`。 */
async function askSingleSelect(ctx: ExtensionContext, step: StepContext): Promise<AskOutcome> {
  const { question, header } = step;
  const plan = buildSelectPlan(question, {
    // 自由输入哨兵照旧追加：桌面已声明 allowFreeform 时会把它吸收进自由输入
    // 框，不认识的宿主则仍能靠这一行拿到自由输入。
    includeCustomRow: true,
    includeBackRow: step.allowBack,
  });
  const selected = await ctx.ui.select(
    `${header}${question.question}`,
    plan.values,
    questionMeta(step, { optionDetails: plan.optionDetails, allowFreeform: true }),
  );
  if (selected === undefined) return { kind: "cancelled" };

  const resolved = resolveSelection(plan, question, step.questionIndex, selected);
  if ("back" in resolved) return { kind: "back" };
  if ("answer" in resolved) return { kind: "answer", answer: resolved.answer, rawValue: selected };

  const typed = await ctx.ui.input(
    `${header}${question.question}`,
    "",
    questionMeta(step, { allowFreeform: true, allowBack: step.allowBack }),
  );
  if (typed === undefined) return { kind: "cancelled" };
  return {
    kind: "answer",
    rawValue: typed,
    answer: {
      questionIndex: step.questionIndex,
      question: question.question,
      kind: "custom",
      answer: typed,
    },
  };
}

/** 只保留用户真正走过的题目的答案（回退后再取消时，不带上「未来」的答案）。 */
function settledAnswers(
  answers: ReadonlyArray<QuestionAnswer | undefined>,
  upto: number,
): QuestionAnswer[] {
  const out: QuestionAnswer[] = [];
  for (let index = 0; index < upto; index += 1) {
    const answer = answers[index];
    if (answer) out.push(answer);
  }
  return out;
}

/**
 * 依次询问每道题，支持回退重答。任何一次取消都会终止整份问卷（与 rpiv 的 Esc
 * 语义一致），已作答的部分保留在结果里。
 */
export async function runQuestionnaire(
  ctx: ExtensionContext,
  params: AskUserParams,
): Promise<QuestionnaireResult> {
  const questionCount = params.questions.length;
  const answers: Array<QuestionAnswer | undefined> = new Array(questionCount).fill(undefined);
  const rawValues: Array<string | undefined> = new Array(questionCount).fill(undefined);
  let questionIndex = 0;

  while (questionIndex < questionCount) {
    const question = params.questions[questionIndex]!;
    const step: StepContext = {
      question,
      questionIndex,
      questionCount,
      header: question.header ? `[${question.header}] ` : "",
      allowBack: questionIndex > 0,
      previous: rawValues[questionIndex],
    };

    const outcome = question.multiSelect
      ? await askMultiSelect(ctx, step)
      : await askSingleSelect(ctx, step);

    if (outcome.kind === "cancelled") {
      return { answers: settledAnswers(answers, questionIndex), cancelled: true };
    }
    if (outcome.kind === "back") {
      questionIndex = Math.max(0, questionIndex - 1);
      continue;
    }
    answers[questionIndex] = outcome.answer;
    rawValues[questionIndex] = outcome.rawValue;
    questionIndex += 1;
  }

  return { answers: settledAnswers(answers, questionCount), cancelled: false };
}
