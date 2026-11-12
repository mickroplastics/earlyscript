import type { EditorialEvidenceItem, EditorialVideoState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DECIDED, JUST_CREATED, WRITING } from "../videoThread.fixture";
import {
  numberSources,
  scriptNotices,
  stageSumNote,
  stepperModel,
  timeOfDay,
  uncitedSentences,
} from "./videoWorkspace.logic";

const EMPTY = { done: 0, total: 3 };
const DRAFTED = { done: 6, total: 6 };

const statuses = (video: EditorialVideoState, parts = DRAFTED, agentWorking = false) =>
  stepperModel({ video, parts, agentWorking }).steps.map((step) => step.status);

describe("stepperModel", () => {
  it("follows the clock's stage, not the script, while the clock runs", () => {
    expect(statuses(JUST_CREATED, EMPTY)).toEqual(["active", "pending", "pending"]);
    expect(stepperModel({ video: JUST_CREATED, parts: EMPTY, agentWorking: false }).now).toEqual(
      expect.objectContaining({ tone: "now", action: null }),
    );
    // Writing with a draft: the only action is to move on to deciding.
    const writing = stepperModel({ video: WRITING, parts: DRAFTED, agentWorking: false });
    expect(writing.current).toBe("write");
    expect(writing.steps.map((step) => step.status)).toEqual(["done", "active", "pending"]);
    expect(writing.now.action).toBe("decide");
    // While the agent works there is nothing to press.
    expect(stepperModel({ video: WRITING, parts: EMPTY, agentWorking: true }).now.action).toBe(
      null,
    );
    // Back from Decidir to Escribir: Decidir keeps its time but is ahead again.
    const deciding: EditorialVideoState = {
      ...WRITING,
      clock: {
        ...WRITING.clock,
        state: { _tag: "running", stage: "decide", since: WRITING.clock.asOf },
      },
    };
    expect(statuses(deciding)).toEqual(["done", "done", "active"]);
    expect(stepperModel({ video: deciding, parts: DRAFTED, agentWorking: false }).now.action).toBe(
      "back-to-write",
    );
  });

  it("puts a pause, a stopped clock and an open segment before anything else", () => {
    const paused: EditorialVideoState = {
      ...WRITING,
      clock: {
        ...WRITING.clock,
        state: { _tag: "paused", stage: "write", since: WRITING.clock.asOf },
      },
    };
    expect(statuses(paused)).toEqual(["done", "paused", "pending"]);
    expect(stepperModel({ video: paused, parts: DRAFTED, agentWorking: false }).now).toEqual(
      expect.objectContaining({ tone: "pause", action: "resume" }),
    );

    // A stopped clock with a draft stands in Escribir and offers to restart.
    const stopped: EditorialVideoState = {
      ...WRITING,
      clock: { ...WRITING.clock, state: { _tag: "idle" } },
    };
    expect(statuses(stopped)).toEqual(["done", "paused", "pending"]);
    expect(stepperModel({ video: stopped, parts: DRAFTED, agentWorking: false }).now.action).toBe(
      "restart",
    );

    const open: EditorialVideoState = {
      ...WRITING,
      clock: {
        ...WRITING.clock,
        state: { _tag: "running", stage: "decide", since: WRITING.clock.asOf },
        unresolved: [
          {
            intervalId: "i-1",
            stage: "write",
            startedAt: "2026-10-31T13:05:00.000Z",
            recoveredAt: "2026-10-31T13:20:00.000Z",
          },
        ],
        definitive: false,
      },
    };
    const model = stepperModel({ video: open, parts: DRAFTED, agentWorking: false });
    expect(model.steps.map((step) => step.status)).toEqual(["done", "open", "active"]);
    expect(model.now).toEqual(expect.objectContaining({ tone: "open", action: "resolve" }));
  });

  it("marks every step done once decided, naming the decision", () => {
    const model = stepperModel({ video: DECIDED, parts: DRAFTED, agentWorking: false });
    expect(model.current).toBeNull();
    expect(model.steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
    expect(model.steps[2]?.detail).toBe("Hecho · editado");
    expect(model.now.tone).toBe("done");
  });
});

describe("timeOfDay", () => {
  it("says the day unless it is today", () => {
    const at = new Date(2026, 10, 9, 23, 41);
    expect(timeOfDay(at.toISOString(), new Date(2026, 10, 9, 23, 50))).toBe("23:41 de hoy");
    expect(timeOfDay(at.toISOString(), new Date(2026, 10, 12))).toBe("23:41 del 9 de nov");
  });
});

const SCRIPT = `# Hook

Claude Code is about to run something on your machine. Do you know what it is? [itm_hn_1]

Other people posted add-ons for Claude Code and Codex that same week. [itm_hn_1] [itm_hn_3]

# Block 1

<!-- OPERATOR: on screen, the install. Repo linked from [itm_hn_1]: https://example.com -->

Did Intent-lens show the plan before Claude Code acted? {{yes/no}}. [itm_hn_1]

The task I gave it: {{one plain sentence}} and {{another}}.

This was a single test on my machine, so it's one result.

# Close

Which of these would you try first? Tell me in the comments.

# Sources

- [itm_hn_1] https://news.ycombinator.com/item?id=1
`;

describe("scriptNotices", () => {
  it("lists blanks and operator notes in document order, outside Sources", () => {
    expect(scriptNotices(SCRIPT)).toEqual([
      {
        kind: "operator",
        line: 9,
        text: "on screen, the install. Repo linked from [itm_hn_1]: https://example.com",
      },
      { kind: "hole", line: 11, text: "yes/no" },
      { kind: "hole", line: 13, text: "one plain sentence" },
      { kind: "hole", line: 13, text: "another" },
    ]);
    expect(scriptNotices("# Hook\n\n# Block 1\n\n# Close\n\n# Sources\n")).toEqual([]);
  });

  it("keeps the verifier's count apart, as the server counts it", () => {
    const { uncited } = uncitedSentences(SCRIPT);
    expect(uncited.map((claim) => claim.line)).toContain(15);
    expect(uncited.some((claim) => claim.text.startsWith("Other people"))).toBe(false);
  });
});

const item = (itemId: string): EditorialEvidenceItem => ({
  itemId,
  source: "hn",
  title: itemId,
  excerpt: "",
  author: null,
  publishedAt: "2026-11-02T00:00:00.000Z",
  permalink: `https://news.ycombinator.com/item?id=${itemId}`,
  externalUrl: null,
});

describe("numberSources", () => {
  it("numbers the script's sources first, then the rest of the dossier", () => {
    const sources = numberSources(SCRIPT, [item("itm_hn_2"), item("itm_hn_3"), item("itm_hn_1")]);
    expect(sources.map((source) => [source.id, source.number, source.uses])).toEqual([
      ["itm_hn_1", 1, 4],
      ["itm_hn_3", 2, 1],
      ["itm_hn_2", 3, 0],
    ]);
    expect(sources[0]?.sections).toEqual(["Hook", "Block 1"]);
    // One entry per marker: the Hook's second paragraph cites it once, the operator note once.
    expect(sources[0]?.occurrences).toEqual([3, 5, 9, 11]);
  });

  it("keeps a cited id missing from the dossier, without its evidence", () => {
    expect(numberSources(SCRIPT, [])[1]).toEqual(
      expect.objectContaining({ id: "itm_hn_3", number: 2, evidence: null }),
    );
  });
});

describe("stageSumNote", () => {
  it("explains a visible sum under the total, and stays quiet when they match", () => {
    expect(stageSumNote([17_400, 666_700, 28_900], 712_000)).toBe(
      "Cada paso se redondea al segundo por separado; por eso la suma visible da 11:51.",
    );
    expect(stageSumNote([17_000, 666_000, 28_000], 711_000)).toBeNull();
    expect(stageSumNote([null, 1_000], null)).toBeNull();
  });
});
