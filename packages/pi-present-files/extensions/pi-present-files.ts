/**
 * pi-present-files — 桌面宿主内置结果文件声明工具的外移插件。
 *
 * Agent 在回合结尾调用 `present_files`，声明本轮真正交付给用户的
 * 结果文件（报告、生成的文档、改过的 PDF/Word 等）。桌面端据此在助手结尾
 * 报告下渲染可点击的文件胶囊：pdf / word / excel 走系统默认程序打开，
 * markdown 与代码文件在右侧 Dock 里以「一文件一标签」的内置预览打开。
 *
 * 纯声明式：不落盘、不改状态，声明随会话历史里的 tool 块一起持久化，会话
 * 重放后胶囊仍可还原。工具名与参数结构必须与桌面宿主内置实现保持一致，
 * 否则桌面前端无法从会话历史还原文件胶囊。
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  findEmptyPaths,
  formatMissingWarning,
  formatRecordedLines,
  normalizeDeclaredFile,
} from "../src/present-files.js";

const TOOL_NAME = "present_files";

const ParamsSchema = Type.Object({
  files: Type.Array(
    Type.Object({
      path: Type.String({
        description: "相对工作区根的路径（如 reports/spec.docx），不要绝对路径或 file://。",
      }),
      label: Type.Optional(
        Type.String({ description: "可选短标签。" }),
      ),
    }),
    {
      description: "本轮交付的文件清单（≥1），只放真实交付物。",
      minItems: 1,
    },
  ),
});

type PresentFilesParams = Static<typeof ParamsSchema>;

const TOOL_DESCRIPTION =
  "把本轮交付给用户的文件登记成 报告下方的文件芯片（一轮一次，放在收尾前）。只登记真实交付物，不登记中间文件、临时文件或日志。PDF/Office 点击后用系统默认应用打开，md/代码在右侧预览打开。";

export function buildPresentFilesTool(
  getCwd?: (ctx?: { sessionManager?: { getCwd(): string } }) => string | null,
) {
  return defineTool({
    name: TOOL_NAME,
    label: "Delivered files",
    description: TOOL_DESCRIPTION,
    promptSnippet: "登记本轮交付文件（文件芯片）",
    parameters: ParamsSchema,
    async execute(_toolCallId, params: PresentFilesParams, _signal, _onUpdate, ctx) {
      try {
        const files = params.files.map(normalizeDeclaredFile);
        const invalid = findEmptyPaths(files);
        if (invalid.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: every declared file needs a non-empty `path`.",
              },
            ],
            details: undefined,
            isError: true,
          };
        }

        // 软校验：声明时文件应已存在。缺失不阻断声明，只在确认里提示，
        // 由模型自行决定是否更正后重新声明。
        const cwd = getCwd?.(ctx) ?? null;
        const missing: string[] = [];
        if (cwd) {
          for (const file of files) {
            try {
              await stat(resolve(cwd, file.path));
            } catch {
              missing.push(file.path);
            }
          }
        }

        const lines = formatRecordedLines(files);
        if (missing.length > 0) {
          lines.push(formatMissingWarning(missing));
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  // cwd 来自执行上下文：相对路径一律按当前会话工作区解析。
  pi.registerTool(buildPresentFilesTool((ctx) => ctx?.sessionManager?.getCwd() ?? null));
}
