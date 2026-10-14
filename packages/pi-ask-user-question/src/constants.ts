/**
 * 常量与协议边界 —— 逐字节照搬自 PiAbyss `ask-user-question-tool.ts`。
 *
 * 与 rpiv 一致的边界，避免模型越界后被拒绝却无从下手。
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
/** 单个 preview 的字符上限（独立于协议上限，留出信封余量）。 */
export const MAX_PREVIEW_LENGTH = 6_000;

/** 追加到每道题的哨兵行标签，语义等价于 rpiv 的 “Type something.”。 */
export const CUSTOM_ROW_LABEL = "Type something.";

/**
 * 回退哨兵行标签（第 2 题起追加）。
 *
 * 以 `↩` 开头是**跨端契约**：PiAbyss 桌面卡片按这个前缀识别回退动作，把它从
 * 选项列表里摘出来，改渲染成卡片底部的「修改上一题」按钮；其它 host 则照常
 * 当普通选项渲染，选中即回退。因此前缀字符不能改，后缀文案可以本地化。
 */
export const BACK_ROW_LABEL = "↩ 修改上一题";

/** 桌面据此识别回退动作；与 `BACK_ROW_LABEL` 的前缀保持一致。 */
export const BACK_ROW_PREFIX = "↩";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
