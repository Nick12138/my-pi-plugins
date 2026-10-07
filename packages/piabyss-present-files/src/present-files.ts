/**
 * Pure path / formatting logic for `piabyss_present_files`.
 *
 * Extracted verbatim from the PiAbyss host implementation so the extension
 * stays declarative and the behaviour stays unit-testable.
 */

/** 面向确认文本的单条文件行。 */
export function formatFile(file: { path: string; label?: string }): string {
  return file.label ? `- ${file.path} (${file.label})` : `- ${file.path}`;
}

/** 规范化一条声明：去空白；label 为空视为未提供。 */
export function normalizeDeclaredFile(file: { path: string; label?: string }): {
  path: string;
  label?: string;
} {
  return {
    path: file.path.trim(),
    label: file.label?.trim() || undefined,
  };
}

/** 收集声明里的空路径（规范化后仍为空即视为非法）。 */
export function findEmptyPaths(
  files: Array<{ path: string; label?: string }>,
): Array<{ path: string; label?: string }> {
  return files.filter((file) => !file.path.trim());
}

/** 确认文本（不含缺失提示时）。 */
export function formatRecordedLines(files: Array<{ path: string; label?: string }>): string[] {
  return [`Recorded ${files.length} delivered file(s):`, ...files.map(formatFile)];
}

/** 缺失路径提示行（与原实现逐字一致）。 */
export function formatMissingWarning(missing: string[]): string {
  return `Warning: these paths do not exist right now: ${missing.join(", ")}. Re-declare with corrected paths if that was a mistake.`;
}
