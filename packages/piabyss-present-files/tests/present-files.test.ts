import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findEmptyPaths,
  formatFile,
  formatMissingWarning,
  formatRecordedLines,
  normalizeDeclaredFile,
} from "../src/present-files.js";
import { buildPresentFilesTool } from "../extensions/piabyss-present-files.js";

const root = await mkdtemp(join(tmpdir(), "piabyss-present-files-"));
const existing = join(root, "report.md");

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("pure path / formatting helpers", () => {
  it("normalizes paths and treats blank labels as absent", () => {
    expect(normalizeDeclaredFile({ path: "  docs/a.pdf  ", label: "  " })).toEqual({
      path: "docs/a.pdf",
      label: undefined,
    });
    expect(normalizeDeclaredFile({ path: "a.md", label: "Read me" })).toEqual({
      path: "a.md",
      label: "Read me",
    });
  });

  it("formats a line with and without a label", () => {
    expect(formatFile({ path: "docs/spec.docx" })).toBe("- docs/spec.docx");
    expect(formatFile({ path: "docs/spec.docx", label: "Spec" })).toBe("- docs/spec.docx (Spec)");
  });

  it("detects empty paths after normalization", () => {
    expect(findEmptyPaths([{ path: "   " }, { path: "a.md" }])).toEqual([{ path: "   " }]);
    expect(findEmptyPaths([{ path: "a.md" }])).toEqual([]);
  });

  it("formats the confirmation and missing warning verbatim", () => {
    expect(formatRecordedLines([{ path: "a.md" }, { path: "b.md", label: "B" }])).toEqual([
      "Recorded 2 delivered file(s):",
      "- a.md",
      "- b.md (B)",
    ]);
    expect(formatMissingWarning(["x.md"])).toBe(
      "Warning: these paths do not exist right now: x.md. Re-declare with corrected paths if that was a mistake.",
    );
  });
});

describe("piabyss_present_files tool", () => {
  const signal = () => new AbortController().signal;

  it("records delivered files and echoes them back", async () => {
    const tool = buildPresentFilesTool();
    const result = await tool.execute(
      "call-1",
      { files: [{ path: "docs/spec.docx" }, { path: "README.md", label: "README" }] },
      signal(),
      () => undefined,
      {} as never,
    );
    expect((result.content[0] as { text: string }).text).toContain("Recorded 2 delivered file(s)");
    expect((result.content[0] as { text: string }).text).toContain("- docs/spec.docx");
    expect((result.content[0] as { text: string }).text).toContain("- README.md (README)");
    expect(result.details).toBeUndefined();
  });

  it("resolves relative paths against the workspace cwd", async () => {
    await writeFile(existing, "# report\n", "utf8");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "spec.docx"), "doc", "utf8");

    const tool = buildPresentFilesTool(() => root);
    const result = await tool.execute(
      "call-2",
      { files: [{ path: "report.md" }, { path: "docs/spec.docx" }] },
      signal(),
      () => undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Recorded 2 delivered file(s)");
    expect(text).not.toContain("Warning:");
    expect(result.isError).toBeUndefined();
  });

  it("warns about declared paths that do not exist yet", async () => {
    await writeFile(existing, "# report\n", "utf8");
    const tool = buildPresentFilesTool(() => root);
    const result = await tool.execute(
      "call-3",
      { files: [{ path: "report.md" }, { path: "missing.md" }] },
      signal(),
      () => undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("missing.md");
    expect(text).toContain("Warning: these paths do not exist right now: missing.md.");
    expect(text).not.toContain("report.md, missing.md");
  });

  it("rejects an empty path without touching the filesystem", async () => {
    const tool = buildPresentFilesTool(() => root);
    const result = await tool.execute(
      "call-4",
      { files: [{ path: "   " }] },
      signal(),
      () => undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("non-empty `path`"),
    });
  });

  it("skips existence checks entirely when no cwd is available", async () => {
    const tool = buildPresentFilesTool(() => null);
    const result = await tool.execute(
      "call-5",
      { files: [{ path: "no/such/file.md" }] },
      signal(),
      () => undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Recorded 1 delivered file(s)");
    expect(text).not.toContain("Warning:");
  });
});
