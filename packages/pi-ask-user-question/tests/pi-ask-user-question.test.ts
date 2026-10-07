import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUSTOM_ROW_LABEL, MAX_PREVIEW_LENGTH } from "../src/constants.js";
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
    // (MAX_EXTENSION_UI_OPTION_PREVIEW_LENGTH = 16384 in PiAbyss), or the
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
    const selects: Array<{ title: string; values: string[]; piabyss: unknown }> = [];
    const inputs: string[] = [];
    return {
      selects,
      inputs,
      ctx: {
        ui: {
          select: async (title: string, values: string[], options?: { piabyss?: unknown }) => {
            selects.push({ title, values, piabyss: options?.piabyss });
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

  it("sends the piabyss option details with allowFreeform on every select", async () => {
    const { ctx, selects } = fakeContext("Top strip");
    await runQuestionnaire(ctx as never, { questions: [QUESTION] });
    expect(selects[0]!.values).toEqual([
      "Right drawer",
      "Centered modal",
      "Top strip",
      "Type something.",
    ]);
    expect(selects[0]!.piabyss).toEqual({
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
    });
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
