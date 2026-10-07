/**
 * 开关与激活钩子 —— 照搬自 PiAbyss `ask-user-question-tool.ts`。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME } from "./constants.js";

/**
 * `settings.json` 里的开关。缺省为开；只有显式 `false` 才关闭。
 *
 * 直接读文件而不是走 SettingsManager：开关变化后不需要重建会话，下一次
 * `before_agent_start` 读到的就是新值。
 */
export function isAskUserQuestionEnabled(agentDir: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
    return (raw as Record<string, unknown>).askUserQuestionEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * 激活/停用钩子。
 *
 * 工具的注册与它的激活是两件事：用户 `settings.json` 通常显式列出
 * `defaultTools` 且不含本工具，所以注册之后它仍可能处于未激活状态。这个内联
 * 扩展在每轮开始前按开关把它加回或移除，模型因此既看不到被关掉的工具，也不会
 * 因为显式 `defaultTools` 而丢失它。
 */
export function createAskUserQuestionActivationExtension(
  isEnabled: () => boolean,
): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", () => {
      const active = pi.getActiveTools();
      const hasTool = active.includes(ASK_USER_QUESTION_TOOL_NAME);
      if (!isEnabled()) {
        if (hasTool)
          pi.setActiveTools(active.filter((name) => name !== ASK_USER_QUESTION_TOOL_NAME));
        return;
      }
      if (!hasTool) pi.setActiveTools([...active, ASK_USER_QUESTION_TOOL_NAME]);
    });
  };
}
