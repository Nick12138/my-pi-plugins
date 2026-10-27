/**
 * Agents-Anywhere（AA）结构化标记。
 *
 * 为什么需要它：pi 的 RPC 模式里 `ui.input(title, placeholder, opts)` 只把
 * `title / placeholder / timeout` 发给宿主，**第三个参数（桌面宿主的
 * `askUserQuestion` / 遗留 `piabyss` 元数据）被直接丢弃**（见 pi `rpc-mode.js` 的 `input`）。所以多选
 * 在 AA 一侧只剩一段纯文本，宿主无法知道「这是多选、有哪些选项」，只能给一个
 * 空文本框。
 *
 * 这里把多选的结构化信息编码成**一行** JSON、追加到 placeholder 末尾：
 * - AA connector 解析它 → 渲染成真正的勾选框（`multiple: true` + options），
 *   回答时把选中项换算回 1-based 序号串（`parseMultiSelection` 只认序号）；
 * - 桌面端端读的是第三个参数里的 `optionDetails`，并且在多选卡片上隐去
 *   `message`，因此看不到这一行（`ExtensionUiRequestContent` 的 `!isMultiSelect`）；
 * - pi 自己的 TUI 不做标记（只有 `ctx.mode === "rpc"` 才追加），避免终端里
 *   出现一串 JSON。
 *
 * 标记是**单向附加信息**：不认识的宿主忽略它，多选仍按原样退化成「选项列表 +
 * 文本框」，与加标记前完全一致。
 */

/** 标记行前缀。AA connector 侧用同一个常量语义（`_AA_MARKER_PREFIX`）。 */
export const AA_MARKER_PREFIX = "#aa-ask:";

/** 标记版本；结构变更时递增，connector 只接受认识的版本。 */
export const AA_MARKER_VERSION = 1;

export type AaMarkerOption = {
  label: string;
  description?: string;
  preview?: string;
};

export type AaMultiSelectMarker = {
  v: typeof AA_MARKER_VERSION;
  kind: "multiSelect";
  /** 题干（不含 `[header] ` 前缀）。 */
  prompt: string;
  header?: string;
  questionIndex: number;
  questionCount: number;
  /** 多选允许「自定义答案」（与 `parseMultiSelection` 的非编号分支一致）。 */
  allowCustom: true;
  allowBack: boolean;
  /** 选中即回退上一题的值；AA 用它渲染「上一题」按钮。 */
  backValue: string;
  options: AaMarkerOption[];
};

/**
 * 序列化成单行标记。
 *
 * JSON 里不含换行（`JSON.stringify` 会转义），所以整条标记永远只占一行 ——
 * connector 只需按行查找，不会误伤多行 placeholder。
 */
export function buildAaMultiSelectMarker(marker: AaMultiSelectMarker): string {
  return `${AA_MARKER_PREFIX}${JSON.stringify(marker)}`;
}

/** 从多行文本里摘掉标记行，返回剩余文本（给需要展示原文的宿主用）。 */
export function stripAaMarker(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith(AA_MARKER_PREFIX))
    .join("\n");
}
