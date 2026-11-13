import type { EditorialEvidenceItem, EditorialVideoState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DECIDED, JUST_CREATED, WRITING } from "../videoThread.fixture";
import {
  fullDateTime,
  inlineTokens,
  nextEvidenceOffset,
  stopDays,
  numberSources,
  openStageTime,
  scriptNotices,
  scriptSource,
  stageSumNote,
  stepperModel,
  stopTimeIso,
  summarySegments,
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
    const restart = stepperModel({ video: stopped, parts: DRAFTED, agentWorking: false });
    expect(restart.now.action).toBe("restart");
    // It restarts in the step on screen, and says which.
    expect(restart.current).toBe("write");
    expect(restart.now.text).toContain("«Escribir y revisar»");

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
    expect(sources[0]?.occurrences.map((occurrence) => occurrence.line)).toEqual([3, 5, 9, 11]);
  });

  it("reads abbreviated markers as the parser does and keeps each marker apart", () => {
    const script =
      "# Hook\n\nOne claim here, cited twice. [hn:1] Another one, same source. [itm_hn_1]\n";
    const [source] = numberSources(script, [item("itm_hn_1")]);
    // Two markers in one paragraph: two citations, one paragraph.
    expect(source).toEqual(
      expect.objectContaining({ id: "itm_hn_1", number: 1, uses: 2, paragraphs: 1 }),
    );
    const keys = source?.occurrences.map((occurrence) => occurrence.key) ?? [];
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // The keys are the ones the rendered script gives its numbers.
    const offsets = inlineTokens(
      "One claim here, cited twice. [hn:1] Another one, same source. [itm_hn_1]",
    )
      .filter((token) => token.kind === "cite")
      .map((token) => `3:${token.offset}:itm_hn_1`);
    expect(offsets).toEqual(keys);
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

describe("inlineTokens", () => {
  it("splits prose into text, blanks and normalized citations", () => {
    expect(inlineTokens("Did it work? {{yes/no}}. [hn:1, itm_gh_2]")).toEqual([
      { kind: "text", text: "Did it work? ", offset: 0 },
      { kind: "hole", text: "{{yes/no}}", offset: 13 },
      { kind: "text", text: ". ", offset: 23 },
      { kind: "cite", ids: ["itm_hn_1", "itm_gh_2"], offset: 25 },
    ]);
    // A bracket that is not a citation stays as text.
    expect(inlineTokens("See [the docs] here.")).toEqual([
      { kind: "text", text: "See [the docs] here.", offset: 0 },
    ]);
  });
});

describe("summarySegments", () => {
  it("numbers the topic with the script's numbers, even past a source missing from the dossier", () => {
    const sources = numberSources(SCRIPT, [item("itm_hn_2")]);
    const numbers = new Map(sources.map((source) => [source.id, source.number]));
    // The script cites itm_hn_1 and itm_hn_3, absent here: itm_hn_2 is still number 3.
    expect(summarySegments("A trend [itm_hn_2] and an unknown one [itm_hn_9].", numbers)).toEqual([
      { kind: "text", text: "A trend" },
      { kind: "cite", id: "itm_hn_2", number: 3 },
      { kind: "text", text: " and an unknown one [itm_hn_9]." },
    ]);
  });
});

describe("scriptSource", () => {
  it("never stands the working file in for a decided version that was not saved", () => {
    expect(scriptSource(WRITING)).toEqual({ kind: "live" });
    expect(scriptSource(DECIDED)).toEqual({ kind: "decided", hash: "9f2c1ab07d3e4c55aa10" });
    expect(
      scriptSource({ ...DECIDED, decision: { ...DECIDED.decision!, scriptVersionHash: null } }),
    ).toEqual({ kind: "none" });
  });
});

describe("stopTimeIso", () => {
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 10, day, hour, minute).toISOString();
  const interval = { startedAt: at(9, 23, 41), recoveredAt: at(10, 0, 20) };

  it("saves exactly the day and the time the operator picked, inside the open segment", () => {
    expect(stopTimeIso("2026-11-09", "23:52", interval)).toBe(at(9, 23, 52));
    expect(stopTimeIso("2026-11-10", "0:05", interval)).toBe(at(10, 0, 5));
    expect(stopTimeIso("2026-11-09", "23.55", interval)).toBe(at(9, 23, 55));
    // The minute the segment started is allowed; the saved time is not before the start.
    expect(stopTimeIso("2026-11-09", "23:41", interval)).toBe(interval.startedAt);
  });

  it("lets a segment of several days end on any of them", () => {
    const long = { startedAt: at(9, 18, 0), recoveredAt: at(11, 19, 0) };
    expect(stopTimeIso("2026-11-09", "18:30", long)).toBe(at(9, 18, 30));
    expect(stopTimeIso("2026-11-10", "18:30", long)).toBe(at(10, 18, 30));
    expect(stopTimeIso("2026-11-11", "18:30", long)).toBe(at(11, 18, 30));
    expect(stopTimeIso("2026-11-11", "19:30", long)).toBeNull();
    expect(stopDays(long, new Date(2026, 10, 12)).map((day) => day.value)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
    ]);
    // A segment longer than a month offers every day, its last one included.
    const offered = stopDays(
      { startedAt: new Date(2026, 9, 1, 9, 0).toISOString(), recoveredAt: at(12, 9, 0) },
      new Date(2026, 10, 13),
    );
    expect(offered).toHaveLength(43);
    expect(offered.at(-1)?.value).toBe("2026-11-12");
    expect(stopDays(interval, new Date(2026, 10, 12)).map((day) => day.label)).toEqual([
      "lunes 9 de nov",
      "martes 10 de nov",
    ]);
  });

  it("refuses what is not a time inside the segment", () => {
    expect(stopTimeIso("2026-11-09", "23:30", interval)).toBeNull();
    expect(stopTimeIso("2026-11-10", "1:00", interval)).toBeNull();
    expect(stopTimeIso("2026-11-09", "25:00", interval)).toBeNull();
    expect(stopTimeIso("2026-11-09", "mañana", interval)).toBeNull();
    expect(stopTimeIso("2026-11-12", "0:10", interval)).toBeNull();
  });

  it("names the moment it will save in full", () => {
    expect(fullDateTime(at(10, 0, 5))).toBe("martes 10 de noviembre de 2026 a las 00:05");
  });
});

describe("openStageTime", () => {
  it("says what was measured without a misleading zero", () => {
    expect(openStageTime(0)).toBe("sin medir");
    expect(openStageTime(666_000)).toBe("al menos 11:06");
  });
});

describe("nextEvidenceOffset", () => {
  it("asks for the next page until every source of the dossier is loaded", () => {
    expect(nextEvidenceOffset({ evidenceTotal: 120, pageLength: 50 }, 0)).toBe(50);
    expect(nextEvidenceOffset({ evidenceTotal: 120, pageLength: 50 }, 50)).toBe(100);
    expect(nextEvidenceOffset({ evidenceTotal: 120, pageLength: 20 }, 100)).toBeNull();
    expect(nextEvidenceOffset({ evidenceTotal: 10, pageLength: 10 }, 0)).toBeNull();
    // An empty page never loops.
    expect(nextEvidenceOffset({ evidenceTotal: 120, pageLength: 0 }, 50)).toBeNull();
  });
});
