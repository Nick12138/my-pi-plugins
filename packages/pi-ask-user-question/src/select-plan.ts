/**
 * 标签去重与 `ui.select` 载荷构造 —— 与桌面宿主内置实现同源的 `ask-user-question-tool.ts`。
 */
import { BACK_ROW_LABEL, CUSTOM_ROW_LABEL, MAX_PREVIEW_LENGTH } from "./constants.js";
import type { AskUserQuestion } from "./schema.js";

export type QuestionOptionDetail = {
  id: string;
  description?: string;
  preview?: string;
};

/**
 * 每道题渲染成一次 `ui.select` 所需的载荷。
 *
 * `values` 是人可读的选项串（`ui.select` 只接受 string[] 且以选中串返回），
 * `byValue` 把该串映射回选项下标；`customValue` 是追加的哨兵行。三者必须由
 * 同一函数一次构造，避免标签去重后下标错位。
 */
export type SelectPlan = {
  values: string[];
  byValue: Map<string, number>;
  customValue: string;
  /** 回退哨兵串；未追加时为空串（选中值永远不可能是空串）。 */
  backValue: string;
  optionDetails: QuestionOptionDetail[];
};

export type SelectPlanOptions = {
  /** 是否追加自由输入哨兵行。宿主已声明 `allowFreeform` 时由调用方关掉。 */
  includeCustomRow?: boolean;
  /** 是否追加回退哨兵行（第 2 题起）。 */
  includeBackRow?: boolean;
};

/**
 * 重复标签会破坏「串 → 下标」的一一映射，追加序号消歧。
 *
 * `ui.select` 只回传被选中的字符串，所以两个同名选项无法区分；这里让展示串
 * 唯一。用户看到的标签保持原样（第一个不变），只有重复项带上 "(2)"。
 */
export function disambiguate(label: string, used: Set<string>): string {
  if (!used.has(label)) {
    used.add(label);
    return label;
  }
  let attempt = 2;
  let candidate = `${label} (${attempt})`;
  while (used.has(candidate)) {
    attempt += 1;
    candidate = `${label} (${attempt})`;
  }
  used.add(candidate);
  return candidate;
}

export function buildSelectPlan(
  question: AskUserQuestion,
  options: SelectPlanOptions = {},
): SelectPlan {
  const includeCustomRow = options.includeCustomRow ?? true;
  const includeBackRow = options.includeBackRow ?? false;
  const used = new Set<string>();
  const byValue = new Map<string, number>();
  const optionDetails: QuestionOptionDetail[] = [];
  const values = question.options.map((option, index) => {
    const value = disambiguate(option.label, used);
    byValue.set(value, index);
    optionDetails.push({
      id: value,
      description: option.description,
      ...(option.preview ? { preview: option.preview.slice(0, MAX_PREVIEW_LENGTH) } : {}),
    });
    return value;
  });
  let customValue = "";
  if (includeCustomRow) {
    customValue = disambiguate(CUSTOM_ROW_LABEL, used);
    values.push(customValue);
  }
  let backValue = "";
  if (includeBackRow) {
    backValue = disambiguate(BACK_ROW_LABEL, used);
    values.push(backValue);
  }
  return { values, byValue, customValue, backValue, optionDetails };
}
