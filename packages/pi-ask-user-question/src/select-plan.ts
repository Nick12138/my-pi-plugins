/**
 * 标签去重与 `ui.select` 载荷构造 —— 照搬自 PiAbyss `ask-user-question-tool.ts`。
 */
import { CUSTOM_ROW_LABEL, MAX_PREVIEW_LENGTH } from "./constants.js";
import type { AskUserQuestion } from "./schema.js";

export type PiAbyssOptionDetail = {
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
  optionDetails: PiAbyssOptionDetail[];
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

export function buildSelectPlan(question: AskUserQuestion): SelectPlan {
  const used = new Set<string>();
  const byValue = new Map<string, number>();
  const optionDetails: PiAbyssOptionDetail[] = [];
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
  const customValue = disambiguate(CUSTOM_ROW_LABEL, used);
  values.push(customValue);
  return { values, byValue, customValue, optionDetails };
}
