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

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
