import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildTrendPresentationPrompt,
  finalizeTrendPresentation,
  hashTrendPresentationInput,
  TREND_PRESENTATION_PROMPT_VERSION,
  MAX_TREND_TITLE_CHARS,
  trendPresentationLengthProblems,
  type TrendPresentationPromptInput,
} from "./editorialTextGenerationPrompts.ts";
import { toJsonSchemaObject } from "./textGenerationUtils.ts";

const input: TrendPresentationPromptInput = {
  profile: { version: 2, hash: "sha256:profile", text: "Spanish channel on software and AI." },
  trend: {
    id: "sig_quantum",
    terms: ["quantum", "computing", "ibm"],
    items7d: 11,
    authors7d: 11,
    growth: 0.5,
    affinity: 0.608747,
    volumeRank: 4,
    scoreRank: 2,
    sourceCount: 1,
    coverage: [
      { source: "hn", daysComplete: 28, daysPartial: 0, daysUnavailable: 0 },
      { source: "github", daysComplete: 0, daysPartial: 28, daysUnavailable: 0 },
    ],
  },
  evidence: [
    {
      itemId: "itm_hn_1",
      source: "hn",
      title: "Google breaks open a bottleneck in quantum computing",
      excerpt: "",
      publishedAt: "2026-10-15T18:26:30.000Z",
      url: "https://news.ycombinator.com/item?id=1",
    },
    {
      itemId: "itm_hn_2",
      source: "hn",
      title: "Designing more efficient quantum circuits with Claude",
      excerpt: "Circuit search with a language model.",
      publishedAt: "2026-10-16T10:00:00.000Z",
      url: "https://news.ycombinator.com/item?id=2",
    },
  ],
};

const output = {
  title: "La computación cuántica gana herramientas abiertas",
  summary: {
    whatHappened: "Google e investigadores publicaron avances en circuitos cuánticos.",
    whyItMatters: "El canal cubre IA aplicada a software.",
    videoAngle: "Explicar qué cambia para un programador.",
  },
  citedItemIds: ["itm_hn_1", "itm_hn_2"],
};

describe("buildTrendPresentationPrompt", () => {
  it("frames the evidence as data and asks for cited ids in Spanish by default", () => {
    const { prompt } = buildTrendPresentationPrompt(input);

    expect(prompt).toContain("write title and summary in Spanish (es)");
    expect(prompt).toContain("Do not fill gaps with background knowledge.");
    expect(prompt).toContain(
      "A title mentioning Claude does not establish that Anthropic wrote or published the item.",
    );
    expect(prompt).toContain("Do not recommend prioritizing, deprioritizing, selecting");
    expect(prompt).toContain("place [itemId] immediately after each evidence-based factual claim");
    expect(prompt).toContain('<item id="itm_hn_2" source="hn"');
    expect(prompt).toContain("Excerpt: Circuit search with a language model.");
    expect(prompt).toContain("- github: 0 complete days, 28 partial");
    expect(prompt).not.toContain("Position by score");
    expect(prompt).not.toContain("Items in the last 7 days");
    expect(prompt).toContain("Never describe the collection process");
    expect(prompt).toContain("<coverage_data>");
    expect(prompt).not.toContain("previous answer was rejected");
    // Round 1 of the dossier v2: a first-person aside, an uncited calculator, a title about
    // the loudest item and a publication the headline never named.
    expect(prompt).toContain("Never use the first person, singular or plural.");
    expect(prompt).toContain("Any tool, product or article it names gets its [itemId]");
    expect(prompt).toContain("not the most striking single item");
    expect(prompt).toContain("Name a publication (Bloomberg, BleepingComputer…)");
    expect(prompt).toContain("do not add that it is open source");
    expect(prompt).toContain('never "vídeo"');
    // Round 2: Type and One Code merged into one purpose; a figure without its contrast.
    expect(prompt).toContain("Never merge the capabilities of two products");
    expect(prompt).toContain("does not run it");
    expect(prompt).toContain("Do not extend to several items what only one of them says.");
    expect(prompt).toContain("keep the contrast next to the figure");
    expect(buildTrendPresentationPrompt({ ...input, language: "en" }).prompt).not.toContain(
      "vídeo",
    );
  });

  it("names the problem of a rejected answer in the one retry", () => {
    const { prompt } = buildTrendPresentationPrompt({
      ...input,
      rejectedBecause: "it described how the data was collected (Qué pasó: «motor»)",
    });

    expect(prompt).toContain(
      "- Your previous answer was rejected because: it described how the data was collected (Qué pasó: «motor»). Rewrite it, keeping every claim cited.",
    );
    // The retry answers the same input: the stored row keeps its key.
    expect(hashTrendPresentationInput({ ...input, rejectedBecause: "x" })).toBe(
      hashTrendPresentationInput(input),
    );
  });

  it.effect("produces a strict JSON schema for the structured reply", () =>
    Effect.gen(function* () {
      const { outputSchema } = buildTrendPresentationPrompt({ ...input, language: "en" });
      const decoded = yield* Schema.decodeEffect(outputSchema)(output);

      expect(decoded).toEqual(output);
      expect(toJsonSchemaObject(outputSchema)).toMatchObject({
        type: "object",
        required: ["title", "summary", "citedItemIds"],
        additionalProperties: false,
      });
    }),
  );
});

describe("finalizeTrendPresentation", () => {
  it("keeps a valid reply unchanged and without warnings", () => {
    expect(finalizeTrendPresentation(input, output)).toEqual({ ...output, warnings: [] });
  });

  it("drops a citation to an id outside the evidence and warns", () => {
    const result = finalizeTrendPresentation(input, {
      ...output,
      citedItemIds: ["itm_hn_2", "itm_made_up", "itm_hn_2"],
    });

    expect(result.citedItemIds).toEqual(["itm_hn_2"]);
    expect(result.warnings).toEqual(['Dropped a citation to unknown evidence id "itm_made_up".']);
  });

  it("adds inline citations from the summary and keeps the text as written", () => {
    const summary = {
      whatHappened: "Un titular informa de un avance en circuitos cuánticos [itm_hn_2].",
      whyItMatters: "La relación con el canal no está clara.",
      videoAngle: "Un video podría explicar el titular [itm_hn_1] [itm_hn_2].",
    };
    const result = finalizeTrendPresentation(input, { ...output, summary, citedItemIds: [] });

    expect(result.summary).toEqual(summary);
    expect(result.citedItemIds).toEqual(["itm_hn_2", "itm_hn_1"]);
    expect(result.warnings).toEqual([]);
  });

  it("drops an inline citation to an unknown id and warns", () => {
    const summary = { ...output.summary, whatHappened: "Un titular informa algo [itm_made_up]." };
    const result = finalizeTrendPresentation(input, { ...output, summary });

    expect(result.summary.whatHappened).toBe("Un titular informa algo [itm_made_up].");
    expect(result.citedItemIds).toEqual(["itm_hn_1", "itm_hn_2"]);
    expect(result.warnings).toEqual(['Dropped a citation to unknown evidence id "itm_made_up".']);
  });

  it("moves known citation markers out of the title", () => {
    const result = finalizeTrendPresentation(input, {
      ...output,
      title: "Circuitos cuánticos diseñados con Claude [itm_hn_2] [RFC]",
      citedItemIds: [],
    });

    expect(result.title).toBe("Circuitos cuánticos diseñados con Claude [RFC]");
    expect(result.citedItemIds).toEqual(["itm_hn_2"]);
    expect(result.warnings).toEqual([]);
  });

  it("cuts a long title to one line within the limit", () => {
    const result = finalizeTrendPresentation(input, {
      ...output,
      title: `"${"Computación cuántica ".repeat(8)}."\nSegunda línea`,
    });

    expect(result.title.length).toBeLessThanOrEqual(MAX_TREND_TITLE_CHARS);
    expect(result.title).toMatch(/^Computación cuántica .*…$/);
    expect(result.warnings).toEqual([`The title was cut to ${MAX_TREND_TITLE_CHARS} characters.`]);
  });

  it("writes video, never vídeo, in Spanish", () => {
    const result = finalizeTrendPresentation(input, {
      ...output,
      title: "Un vídeo sobre circuitos",
      summary: {
        ...output.summary,
        videoAngle: "Vídeos cortos que comparen dos vídeos [itm_hn_1].",
      },
    });

    expect(result.title).toBe("Un video sobre circuitos");
    expect(result.summary.videoAngle).toBe("Videos cortos que comparen dos videos [itm_hn_1].");
  });

  it("keeps a part longer than asked, with a warning", () => {
    const whatHappened = `${"Un titular informa de un avance en circuitos cuánticos. ".repeat(9).trim()} [itm_hn_1]`;
    const result = finalizeTrendPresentation(input, {
      ...output,
      summary: { ...output.summary, whatHappened },
    });

    expect(result.summary.whatHappened).toBe(whatHappened);
    expect(result.warnings).toEqual([
      `whatHappened has ${whatHappened.length} characters; the prompt asks for at most 450.`,
    ]);
    expect(trendPresentationLengthProblems(result.summary)).toEqual([
      `whatHappened has ${whatHappened.length} characters and must have at most 450`,
    ]);
    expect(trendPresentationLengthProblems(output.summary)).toEqual([]);
  });

  it("falls back to the engine terms when the title is empty", () => {
    const result = finalizeTrendPresentation(input, { ...output, title: "  " });

    expect(result.title).toBe("quantum computing ibm");
    expect(result.warnings).toHaveLength(1);
  });
});

describe("hashTrendPresentationInput", () => {
  it("is stable across key order and changes with the evidence", () => {
    const reordered: TrendPresentationPromptInput = {
      language: "es",
      evidence: input.evidence,
      trend: input.trend,
      profile: { text: input.profile.text, hash: input.profile.hash, version: 2 },
    };

    expect(hashTrendPresentationInput(reordered)).toBe(hashTrendPresentationInput(input));
    expect(hashTrendPresentationInput({ ...input, evidence: input.evidence.slice(1) })).not.toBe(
      hashTrendPresentationInput(input),
    );
  });

  it("changes with the prompt version, so a corrected prompt invalidates stored text", () => {
    expect(hashTrendPresentationInput(input, "trend-presentation.v2")).not.toBe(
      hashTrendPresentationInput(input),
    );
    expect(hashTrendPresentationInput(input, TREND_PRESENTATION_PROMPT_VERSION)).toBe(
      hashTrendPresentationInput(input),
    );
  });
});
