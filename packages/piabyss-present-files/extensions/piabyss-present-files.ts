/**
 * piabyss-present-files — PiAbyss 内置结果文件声明工具的外移插件。
 *
 * Agent 在回合结尾调用 `piabyss_present_files`，声明本轮真正交付给用户的
 * 结果文件（报告、生成的文档、改过的 PDF/Word 等）。桌面端据此在助手结尾
 * 报告下渲染可点击的文件胶囊：pdf / word / excel 走系统默认程序打开，
 * markdown 与代码文件在右侧 Dock 里以「一文件一标签」的内置预览打开。
 *
 * 纯声明式：不落盘、不改状态，声明随会话历史里的 tool 块一起持久化，会话
 * 重放后胶囊仍可还原。工具名与参数结构必须与 PiAbyss 内置实现保持一致，
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

const TOOL_NAME = "piabyss_present_files";

const ParamsSchema = Type.Object({
  files: Type.Array(
    Type.Object({
      path: Type.String({
        description:
          "Path of the delivered file, relative to the workspace root (e.g. `reports/spec.docx`). Never an absolute path and never a file:// URL.",
      }),
      label: Type.Optional(
        Type.String({ description: "Optional short caption shown on the file chip." }),
      ),
    }),
    {
      description:
        "The files this turn delivers to the user. Never include intermediate, scratch, cache or log files.",
      minItems: 1,
    },
  ),
});

type PresentFilesParams = Static<typeof ParamsSchema>;

const TOOL_DESCRIPTION = [
  "Declare the files this turn delivers to the user so PiAbyss can render them as clickable chips under your final report.",
  "Call it once, at the very end of the turn, just before your closing summary.",
  "Only real deliverables belong here — a finished report, a generated document, a PDF or Word file you edited. Never declare intermediate, scratch, cache, temp or log files.",
  "PDF and Office documents open with the system default app when clicked; markdown and code files open in the PiAbyss right dock preview.",
].join(" ");

export function buildPresentFilesTool(
  getCwd?: (ctx?: { sessionManager?: { getCwd(): string } }) => string | null,
) {
  return defineTool({
    name: TOOL_NAME,
    label: "PiAbyss delivered files",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "Declare the files you deliver so PiAbyss shows them as chips under your final report",
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
