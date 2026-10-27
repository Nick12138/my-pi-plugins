import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACK_ROW_LABEL, CUSTOM_ROW_LABEL, MAX_PREVIEW_LENGTH } from "../src/constants.js";
import {
  buildSelectPlan,
  disambiguate,
} from "../src/select-plan.js";
import {
  formatAnswers,
  parseMultiSelection,
  resolveSelection,
  type QuestionnaireResult,
} from "../src/answers.js";
import { runQuestionnaire } from "../src/questionnaire.js";
import {
  isAskUserQuestionEnabled,
  createAskUserQuestionActivationExtension,
} from "../src/activation.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/constants.js";
import { buildAskUserQuestionTool } from "../src/tool.js";
import type { AskUserParams, AskUserQuestion } from "../src/schema.js";

const QUESTION: AskUserQuestion = {
  question: "Which container shape should the session tree take?",
  header: "Layout",
  options: [
    {
      label: "Right drawer",
      description: "Slide the tree in from the right.",
      preview: "┌─ chat ────┐ ┌─ tree ──┐\n│ user: ... │ │ B ←     │\n└───────────┘ └─────────┘",
    },
    { label: "Centered modal", description: "Keep the modal, polish it." },
    { label: "Top strip", description: "Collapse into a strip above the chat." },
  ],
};

afterEach(() => {
  delete process.env.PI_ASK_USER_TEST_DIR;
});

describe("buildSelectPlan", () => {
  it("maps every select value back to its option index", () => {
    const plan = buildSelectPlan(QUESTION);
    expect(plan.values).toHaveLength(QUESTION.options.length + 1);
    expect(plan.values.at(-1)).toBe(CUSTOM_ROW_LABEL);
    for (const [index, option] of QUESTION.options.entries()) {
      expect(plan.byValue.get(option.label)).toBe(index);
    }
    expect(plan.byValue.has(CUSTOM_ROW_LABEL)).toBe(false);
  });

  it("carries description and preview through piabyss option details", () => {
    const plan = buildSelectPlan(QUESTION);
    expect(plan.optionDetails[0]).toEqual({
      id: "Right drawer",
      description: "Slide the tree in from the right.",
      preview: QUESTION.options[0]!.preview,
    });
    // Preview-less options omit the key entirely rather than sending undefined.
    expect("preview" in plan.optionDetails[1]!).toBe(false);
    expect(plan.optionDetails).toHaveLength(QUESTION.options.length);
  });

  it("keeps duplicate labels distinct so selection stays unambiguous", () => {
    const duplicated: AskUserQuestion = {
      ...QUESTION,
      options: [
        { label: "Same", description: "first" },
        { label: "Same", description: "second" },
      ],
    };
    const plan = buildSelectPlan(duplicated);
    expect(new Set(plan.values).size).toBe(plan.values.length);
    expect(plan.byValue.get("Same")).toBe(0);
    expect(plan.byValue.get("Same (2)")).toBe(1);
  });

  it("appends ever-growing suffixes through disambiguate, keeping the first label untouched", () => {
    const used = new Set<string>();
    expect(disambiguate("Same", used)).toBe("Same");
    expect(disambiguate("Same", used)).toBe("Same (2)");
    expect(disambiguate("Same", used)).toBe("Same (3)");
    expect(disambiguate("Type something.", used)).toBe(CUSTOM_ROW_LABEL);
    expect(disambiguate(CUSTOM_ROW_LABEL, used)).toBe(`${CUSTOM_ROW_LABEL} (2)`);
  });

  it("bounds previews to the tool's own cap, below the protocol ceiling", () => {
    const huge: AskUserQuestion = {
      ...QUESTION,
      options: [
        {
          label: "Big",
          description: "d",
          preview: "x".repeat(MAX_PREVIEW_LENGTH + 50),
        },
        { label: "Small", description: "d" },
      ],
    };
    const plan = buildSelectPlan(huge);
    expect(plan.optionDetails[0]!.preview).toHaveLength(MAX_PREVIEW_LENGTH);
    // The trusted tool cap must never exceed the protocol's hard ceiling
    // (MAX_EXTENSION_UI_OPTION_PREVIEW_LENGTH = 16384 in 桌面宿主), or the
    // request would be rejected by the Desktop-side validator.
    expect(MAX_PREVIEW_LENGTH).toBeLessThanOrEqual(16384);
  });
});

describe("resolveSelection", () => {
  const plan = buildSelectPlan(QUESTION);

  it("resolves an option label to an option answer", () => {
    const result = resolveSelection(plan, QUESTION, 0, "Centered modal");
    expect(result).toEqual({
      answer: {
        questionIndex: 0,
        question: QUESTION.question,
        kind: "option",
        answer: "Centered modal",
      },
    });
  });

  it("routes the sentinel row to the freeform follow-up", () => {
    expect(resolveSelection(plan, QUESTION, 0, CUSTOM_ROW_LABEL)).toEqual({ freeform: true });
  });

  it("treats an unrecognized value as the user's typed answer", () => {
    const result = resolveSelection(plan, QUESTION, 2, "do it my way");
    expect(result).toEqual({
      answer: {
        questionIndex: 2,
        question: QUESTION.question,
        kind: "custom",
        answer: "do it my way",
      },
    });
  });
});

describe("parseMultiSelection", () => {
  it("maps to option objects, not raw labels", () => {
    expect(QUESTION.options[0]).toHaveProperty("label");
  });

  it("parses comma-separated numeric tokens into deduplicated labels", () => {
    expect(parseMultiSelection("1,3", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "multi",
      selected: ["Right drawer", "Top strip"],
    });
    expect(parseMultiSelection("2 3", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "multi",
      selected: ["Centered modal", "Top strip"],
    });
    expect(parseMultiSelection("1, 1", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "multi",
      selected: ["Right drawer"],
    });
  });

  it("accepts trailing-dot numeric tokens and rejects out-of-range indexes", () => {
    expect(parseMultiSelection("2.", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "multi",
      selected: ["Centered modal"],
    });
    // Out of range → the whole token list is a custom answer, not a partial pick.
    expect(parseMultiSelection("9", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "custom",
      answer: "9",
    });
  });

  it("treats an empty input as an empty multi selection", () => {
    expect(parseMultiSelection("   ", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "multi",
      selected: [],
    });
  });

  it("preserves a typed non-numeric answer verbatim", () => {
    expect(parseMultiSelection("none of the above", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "custom",
      answer: "none of the above",
    });
    // Mixed tokens: one bad token poisons the whole list on purpose.
    expect(parseMultiSelection("1, whatever", 0, QUESTION.question, QUESTION.options)).toEqual({
      kind: "custom",
      answer: "1, whatever",
    });
  });
});

describe("formatAnswers", () => {
  it("formats answered questions as one `question -> answer` line each", () => {
    const result: QuestionnaireResult = {
      answers: [
        { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" },
        { questionIndex: 1, question: "Q2?", kind: "custom", answer: "typed" },
        { questionIndex: 2, question: "Q3?", kind: "multi", answer: null, selected: ["X", "Y"] },
      ],
      cancelled: false,
    };
    expect(formatAnswers(result)).toBe("Q1? -> A\nQ2? -> typed\nQ3? -> X, Y");
  });

  it("words cancellations depending on whether any answer survived", () => {
    expect(formatAnswers({ answers: [], cancelled: true })).toBe(
      "The user cancelled the questionnaire without answering.",
    );
    expect(
      formatAnswers({
        answers: [{ questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
        cancelled: true,
      }),
    ).toBe("The user cancelled the questionnaire after answering 1 of the questions.");
  });
});

describe("ask_user_question tool", () => {
  function fakeContext(selectResult: string | undefined, inputResult?: string) {
    const selects: Array<{ title: string; values: string[]; piabyss: unknown; askUserQuestion?: unknown }> = [];
    const inputs: string[] = [];
    return {
      selects,
      inputs,
      ctx: {
        ui: {
          select: async (
            title: string,
            values: string[],
            options?: { piabyss?: unknown; askUserQuestion?: unknown },
          ) => {
            selects.push({
              title,
              values,
              piabyss: options?.piabyss,
              askUserQuestion: options?.askUserQuestion,
            });
            return selectResult;
          },
          input: async (title: string) => {
            inputs.push(title);
            return inputResult;
          },
        },
      },
    };
  }

  it("returns the option answer and echoes the question", async () => {
    const { ctx, selects } = fakeContext("Top strip");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-1",
      { questions: [QUESTION] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]!.title).toBe(`[Layout] ${QUESTION.question}`);
    // details envelope keeps the { answers, cancelled } shape the Desktop relies on.
    expect(result.details).toEqual({
      answers: [
        {
          questionIndex: 0,
          question: QUESTION.question,
          kind: "option",
          answer: "Top strip",
        },
      ],
      cancelled: false,
    });
    // Model-visible text echoes one `question -> answer` line.
    expect(result.content).toEqual([
      { type: "text", text: "Which container shape should the session tree take? -> Top strip" },
    ]);
  });

  it("sends the host metadata under both the generic and legacy keys", async () => {
    const { ctx, selects } = fakeContext("Top strip");
    await runQuestionnaire(ctx as never, { questions: [QUESTION] });
    expect(selects[0]!.values).toEqual([
      "Right drawer",
      "Centered modal",
      "Top strip",
      "Type something.",
    ]);
    const expected = {
      questionIndex: 1,
      questionCount: 1,
      questionHeader: "Layout",
      optionDetails: [
        {
          id: "Right drawer",
          description: "Slide the tree in from the right.",
          preview: QUESTION.options[0]!.preview,
        },
        { id: "Centered modal", description: "Keep the modal, polish it." },
        { id: "Top strip", description: "Collapse into a strip above the chat." },
      ],
      allowFreeform: true,
    };
    // 通用键 `askUserQuestion` 与遗留键 `piabyss`（旧版桌面端读取）内容一致。
    expect(selects[0]!.piabyss).toEqual(expected);
    expect(selects[0]!.askUserQuestion).toEqual(expected);
  });

  it("asks a follow-up input for the sentinel row", async () => {
    const { ctx, inputs } = fakeContext(CUSTOM_ROW_LABEL, "something else");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-2",
      { questions: [QUESTION] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(inputs).toHaveLength(1);
    expect(result.details).toMatchObject({
      cancelled: false,
      answers: [expect.objectContaining({ kind: "custom", answer: "something else" })],
    });
  });

  it("treats a dismissed dialog as cancelled and keeps prior answers", async () => {
    const { ctx } = fakeContext(undefined);
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-3",
      { questions: [QUESTION] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(result.details).toEqual({ answers: [], cancelled: true });
    expect(result.content).toEqual([
      { type: "text", text: "The user cancelled the questionnaire without answering." },
    ]);
  });

  it("keeps answered questions when a later question is cancelled", async () => {
    const selects = ["Top strip", undefined];
    const { ctx, inputs } = {
      ctx: {
        ui: {
          select: async () => selects.shift(),
          input: async (title: string) => {
            inputs.push(title);
            return undefined;
          },
        },
      },
      inputs: [] as string[],
    };
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-3b",
      { questions: [QUESTION, QUESTION] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(result.details).toEqual({
      answers: [
        {
          questionIndex: 0,
          question: QUESTION.question,
          kind: "option",
          answer: "Top strip",
        },
      ],
      cancelled: true,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "The user cancelled the questionnaire after answering 1 of the questions.",
      },
    ]);
  });

  it("walks multi-select questions through the numeric input primitive", async () => {
    const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };
    const { ctx, selects, inputs } = fakeContext(undefined, "1,3");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-4",
      { questions: [multi] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    // Multi-select never opens the select dialog.
    expect(selects).toHaveLength(0);
    expect(inputs).toHaveLength(1);
    expect(result.details).toMatchObject({
      cancelled: false,
      answers: [
        expect.objectContaining({ kind: "multi", selected: ["Right drawer", "Top strip"] }),
      ],
    });
  });

  it("hands multi-select options to the host as structured metadata", async () => {
    const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };
    const inputs: Array<{
      title: string;
      placeholder?: string;
      piabyss: Record<string, unknown>;
    }> = [];
    const ctx = {
      ui: {
        select: async () => undefined,
        input: async (title: string, placeholder?: string, options?: { piabyss?: unknown }) => {
          inputs.push({
            title,
            placeholder,
            piabyss: (options?.piabyss ?? {}) as Record<string, unknown>,
          });
          return "1,3";
        },
      },
    };
    await runQuestionnaire(ctx as never, { questions: [multi] });

    expect(inputs).toHaveLength(1);
    // The question stays in the title; the numbered list travels as the dialog
    // message so a host that renders checkboxes can hide it.
    expect(inputs[0]!.title).toBe(`[Layout] ${QUESTION.question}`);
    expect(inputs[0]!.placeholder).toContain("1. Right drawer — Slide the tree in from the right.");
    expect(inputs[0]!.piabyss).toMatchObject({
      multiSelect: true,
      questionIndex: 1,
      questionCount: 1,
      questionHeader: "Layout",
    });
    expect(inputs[0]!.piabyss.optionDetails).toEqual([
      {
        id: "Right drawer",
        description: "Slide the tree in from the right.",
        preview: QUESTION.options[0]!.preview,
      },
      { id: "Centered modal", description: "Keep the modal, polish it." },
      { id: "Top strip", description: "Collapse into a strip above the chat." },
    ]);
  });

  it("preserves a typed non-numeric multi-select answer verbatim", async () => {
    const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };
    const { ctx } = fakeContext(undefined, "none of the above");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-5",
      { questions: [multi] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(result.details).toMatchObject({
      answers: [expect.objectContaining({ kind: "custom", answer: "none of the above" })],
    });
  });
});

describe("questionnaire rollback", () => {
  type SeenSelect = { title: string; values: string[]; piabyss: Record<string, unknown> };

  /** 按脚本依次返回 select / input 结果，并记录每次下发的载荷。 */
  function scriptedContext(
    selects: Array<string | undefined>,
    inputs: Array<string | undefined> = [],
  ) {
    const seen: SeenSelect[] = [];
    /** 每次 `ui.input` 的标题与 piabyss 元数据（多选题走这条路径）。 */
    const inputCalls: SeenSelect[] = [];
    return {
      seen,
      inputCalls,
      ctx: {
        ui: {
          select: async (title: string, values: string[], options?: { piabyss?: unknown }) => {
            seen.push({ title, values, piabyss: (options?.piabyss ?? {}) as Record<string, unknown> });
            return selects.shift();
          },
          input: async (title: string, _placeholder?: string, options?: { piabyss?: unknown }) => {
            inputCalls.push({
              title,
              values: [],
              piabyss: (options?.piabyss ?? {}) as Record<string, unknown>,
            });
            return inputs.shift();
          },
        },
      },
    };
  }

  const TWO = { questions: [QUESTION, QUESTION] } satisfies AskUserParams;

  it("offers the back row only from the second question on", async () => {
    const { ctx, seen } = scriptedContext(["Top strip", "Centered modal"]);
    await runQuestionnaire(ctx as never, TWO);

    expect(seen[0]!.values).not.toContain(BACK_ROW_LABEL);
    expect(seen[1]!.values).toContain(BACK_ROW_LABEL);
    expect(seen[1]!.piabyss.questionIndex).toBe(2);
    expect(seen[1]!.piabyss.questionCount).toBe(2);
  });

  it("rewinds to the previous question and re-asks it", async () => {
    const { ctx, seen } = scriptedContext([
      "Top strip",
      BACK_ROW_LABEL,
      "Centered modal",
      "Top strip",
    ]);
    const result = await runQuestionnaire(ctx as never, TWO);

    // Q1 → Q2 → 回退 → Q1 重问 → Q2 重答。
    expect(seen.map((entry) => entry.piabyss.questionIndex)).toEqual([1, 2, 1, 2]);
    expect(result).toEqual({
      cancelled: false,
      answers: [
        { questionIndex: 0, question: QUESTION.question, kind: "option", answer: "Centered modal" },
        { questionIndex: 1, question: QUESTION.question, kind: "option", answer: "Top strip" },
      ],
    });
  });

  it("pre-selects the previous answer through piabyss.defaultValue on re-ask", async () => {
    const { ctx, seen } = scriptedContext([
      "Top strip",
      BACK_ROW_LABEL,
      "Centered modal",
      "Top strip",
    ]);
    await runQuestionnaire(ctx as never, TWO);

    // 首次问 Q1 没有可预填的值；回退后重问 Q1 时带上上次的选择。
    expect(seen[0]!.piabyss.defaultValue).toBeUndefined();
    expect(seen[2]!.piabyss.defaultValue).toBe("Top strip");
  });

  it("re-asks each question with its own answer when rewinding twice", async () => {
    const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };
    const { ctx, seen, inputCalls } = scriptedContext(
      // Q1 → Q3 → 回退 Q2 → Q3 → 回退 Q2 → 回退 Q1 → 重答 Q1 → Q2 → Q3。
      ["Top strip", BACK_ROW_LABEL, BACK_ROW_LABEL, "Centered modal", "Top strip"],
      // Q2 首次作答 → 重答 → 再回退（把回退值打到多选的 input 上）→ 最后重答。
      ["1,3", "1", BACK_ROW_LABEL, "1,3"],
    );
    const result = await runQuestionnaire(ctx as never, { questions: [QUESTION, multi, QUESTION] });

    // 首次问 Q2 没有可预填的值；从 Q3 回退重问时带的是 **Q2 自己的**答案串。
    expect(inputCalls[0]!.piabyss.defaultValue).toBeUndefined();
    expect(inputCalls[1]!.piabyss.defaultValue).toBe("1,3");
    // 再退一层仍取该题最新一次作答，不会错位成邻居题的值。
    expect(inputCalls[2]!.piabyss.defaultValue).toBe("1");
    // 从 Q2 回退重问 Q1：带的是 Q1 自己的答案。
    expect(seen[3]!.piabyss.defaultValue).toBe("Top strip");
    // Q1 重答前提到的那层重问的题号也要对得上。
    expect(inputCalls.map((call) => call.piabyss.questionIndex)).toEqual([2, 2, 2, 2]);
    expect(seen.map((entry) => entry.piabyss.questionIndex)).toEqual([1, 3, 3, 1, 3]);
    expect(result).toEqual({
      cancelled: false,
      answers: [
        { questionIndex: 0, question: QUESTION.question, kind: "option", answer: "Centered modal" },
        {
          questionIndex: 1,
          question: QUESTION.question,
          kind: "multi",
          answer: null,
          selected: ["Right drawer", "Top strip"],
        },
        { questionIndex: 2, question: QUESTION.question, kind: "option", answer: "Top strip" },
      ],
    });
  });

  it("drops answers the user had not reached when cancelling after a rewind", async () => {
    const { ctx } = scriptedContext(["Top strip", BACK_ROW_LABEL, undefined]);
    const result = await runQuestionnaire(ctx as never, TWO);

    // 回退到 Q1 后取消：Q2 虽然答过，但用户已经退回去了，不应出现在结果里。
    expect(result).toEqual({ answers: [], cancelled: true });
  });

  it("rewinds from a multi-select question when the back label is typed", async () => {
    const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };
    const { ctx } = scriptedContext(["Top strip", "Centered modal"], [BACK_ROW_LABEL, "1,3"]);
    const result = await runQuestionnaire(ctx as never, { questions: [QUESTION, multi] });

    expect(result).toEqual({
      cancelled: false,
      answers: [
        { questionIndex: 0, question: QUESTION.question, kind: "option", answer: "Centered modal" },
        {
          questionIndex: 1,
          question: QUESTION.question,
          kind: "multi",
          answer: null,
          selected: ["Right drawer", "Top strip"],
        },
      ],
    });
  });
});

describe("ask_user_question activation", () => {
  function fakePi(active: string[]) {
    const calls: string[][] = [];
    const handlers: Array<() => void> = [];
    return {
      calls,
      handlers,
      pi: {
        getActiveTools: () => [...active],
        setActiveTools: (next: string[]) => {
          active = [...next];
          calls.push([...next]);
        },
        on: (_event: string, handler: () => void) => {
          handlers.push(handler);
        },
      },
    };
  }

  it("adds the tool before every turn when enabled", () => {
    const { pi, handlers, calls } = fakePi(["read"]);
    createAskUserQuestionActivationExtension(() => true)(pi as never);
    handlers[0]!();
    expect(calls.at(-1)).toEqual(["read", ASK_USER_QUESTION_TOOL_NAME]);
  });

  it("removes the tool when disabled", () => {
    const { pi, handlers, calls } = fakePi(["read", ASK_USER_QUESTION_TOOL_NAME]);
    createAskUserQuestionActivationExtension(() => false)(pi as never);
    handlers[0]!();
    expect(calls.at(-1)).toEqual(["read"]);
  });

  it("leaves the active set untouched when already in the target state", () => {
    const { pi, handlers, calls } = fakePi(["read", ASK_USER_QUESTION_TOOL_NAME]);
    createAskUserQuestionActivationExtension(() => true)(pi as never);
    handlers[0]!();
    expect(calls).toEqual([]);
  });

  it("reads the setting from settings.json, defaulting to enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ask-user-"));
    try {
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ askUserQuestionEnabled: false }));
      expect(isAskUserQuestionEnabled(dir)).toBe(false);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ askUserQuestionEnabled: true }));
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
      writeFileSync(join(dir, "settings.json"), "{ not json");
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ other: false }));
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to enabled when settings.json does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ask-user-empty-"));
    try {
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension registration", () => {
  it("registers the tool and the before_agent_start hook", async () => {
    const extension = (await import("../extensions/pi-ask-user-question.js")).default;
    const registered: unknown[] = [];
    const events: string[] = [];
    extension({
      registerTool: (tool: unknown) => registered.push(tool),
      on: (event: string) => events.push(event),
    } as never);
    expect(registered).toHaveLength(1);
    expect((registered[0] as { name: string }).name).toBe(ASK_USER_QUESTION_TOOL_NAME);
    expect((registered[0] as { label: string }).label).toBe("Ask user question");
    expect(events).toEqual(["before_agent_start"]);
  });
});

describe("AA multi-select marker", () => {
  const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };

  function markerContext(mode: "rpc" | "tui") {
    const inputs: Array<{ title: string; placeholder?: string }> = [];
    return {
      inputs,
      ctx: {
        mode,
        ui: {
          select: async () => undefined,
          input: async (title: string, placeholder?: string) => {
            inputs.push({ title, placeholder });
            return "1,3";
          },
        },
      },
    };
  }

  function parseMarker(placeholder: string): Record<string, unknown> {
    const line = placeholder.split("\n").find((item) => item.startsWith("#aa-ask:"));
    expect(line).toBeDefined();
    return JSON.parse(line!.slice("#aa-ask:".length)) as Record<string, unknown>;
  }

  it("appends a machine-readable marker for RPC hosts", async () => {
    const { ctx, inputs } = markerContext("rpc");
    await runQuestionnaire(ctx as never, { questions: [multi, { ...multi, header: undefined }] });

    expect(inputs).toHaveLength(2);
    const first = inputs[0]!.placeholder!;
    // 人读的清单照旧在前，标记是最后一行
    expect(first.split("\n")[0]).toBe("1. Right drawer — Slide the tree in from the right.");
    expect(first.trimEnd().split("\n").at(-1)!.startsWith("#aa-ask:")).toBe(true);

    expect(parseMarker(first)).toMatchObject({
      v: 1,
      kind: "multiSelect",
      prompt: QUESTION.question,
      header: "Layout",
      questionIndex: 1,
      questionCount: 2,
      allowCustom: true,
      // 第一题没有上一题可回退
      allowBack: false,
      options: [
        { label: "Right drawer", description: "Slide the tree in from the right." },
        { label: "Centered modal", description: "Keep the modal, polish it." },
        { label: "Top strip", description: "Collapse into a strip above the chat." },
      ],
    });

    // 第二题可以回退上一题，AA 据此渲染「上一题」按钮
    expect(parseMarker(inputs[1]!.placeholder!)).toMatchObject({
      questionIndex: 2,
      allowBack: true,
      backValue: "↩ 修改上一题",
    });
  });

  it("keeps the placeholder human-only in TUI mode", async () => {
    const { ctx, inputs } = markerContext("tui");
    await runQuestionnaire(ctx as never, { questions: [multi] });
    expect(inputs[0]!.placeholder).not.toContain("#aa-ask:");
  });
});
