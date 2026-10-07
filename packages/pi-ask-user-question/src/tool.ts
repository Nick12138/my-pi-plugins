/**
 * `ask_user_question` 工具定义 —— 照搬自 PiAbyss `ask-user-question-tool.ts`。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatAnswers } from "./answers.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
} from "./constants.js";
import { runQuestionnaire } from "./questionnaire.js";
import type { AskUserParams } from "./schema.js";
import { QuestionParamsSchema, TOOL_DESCRIPTION } from "./schema.js";

export function buildAskUserQuestionTool(): ToolDefinition {
  return defineTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask user question",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Ask the user a structured question with typed options",
    parameters: QuestionParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runQuestionnaire(ctx, params);
      return {
        content: [{ type: "text" as const, text: formatAnswers(result) }],
        details: result,
      };
    },
  });
}
