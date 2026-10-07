/**
 * pi-ask-user-question —— 把 PiAbyss 内置 `ask_user_question` 工具外移为插件。
 *
 * 注册问卷工具，并挂一个内联激活扩展：每轮开始前读
 * `<agentDir>/settings.json` 的 `askUserQuestionEnabled`（缺省为开，仅显式
 * `false` 关闭），据此把它加入/移出活跃工具集。不走任何 SettingsManager。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createAskUserQuestionActivationExtension,
  isAskUserQuestionEnabled,
} from "../src/activation.js";
import { buildAskUserQuestionTool } from "../src/tool.js";

export default function (pi: ExtensionAPI): void {
  pi.registerTool(buildAskUserQuestionTool());
  createAskUserQuestionActivationExtension(() => isAskUserQuestionEnabled(getAgentDir()))(pi);
}
