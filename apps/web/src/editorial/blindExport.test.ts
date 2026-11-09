import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { blindCards, blindCardsMarkdown } from "./blindExport";

const RUN_ID = EditorialRunId.make("run_v3_20261013_secret");

const trend = (id: string, position: number): EditorialTrendSummary => ({
  dossierId: EditorialDossierId.make(id),
  runId: RUN_ID,
  label: `label ${position}`,
  terms: [],
  subtitle: null,
  presentation: {
    title: `Title ${position}`,
    summary: { whatHappened: "a", whyItMatters: "b", videoAngle: "c" },
    citedItemIds: [],
    provider: "claudeAgent",
    model: "claude-haiku-5-5",
    promptVersion: "trend-presentation.v3",
    generatedAt: "2026-10-14T00:00:00.000Z",
  },
  stage: "growing",
  corroboration: "single_source",
  items7d: 9,
  items28d: 9,
  authors7d: 9,
  volumeRank: position,
  scoreRank: position,
  score: 42.4242,
  growth: 1.2345,
  affinity: 0.7777,
  sourceCount: 1,
  sources: ["hn"],
  sparkline: [],
  isNew: true,
  trendKey: EditorialTrendKey.make(`sig_${id}`),
  card: {
    origin: "v3",
    section: "moving",
    position,
    movement: "strong",
    since: "2026-10-09",
    perennial: false,
    curve: [{ source: "hn", status: "comparable", weeks: [0, 1, 2, 9] }],
    sourceCount: 1,
    firstSource: { source: "hn", day: "2026-10-01" },
    secondSource: null,
    fit: { topic: "AI coding agents and agent harnesses for developers", terms: ["agent"] },
    saturated: false,
    headlines: [],
    evidence: [
      {
        itemId: "itm_hn_1",
        source: "hn",
        title: "Item",
        day: "2026-10-10",
        url: "https://a.example/1",
      },
    ],
    incompleteSources: [],
    decision: {
      threadId: "thread-secret",
      action: "reject",
      utility: 2,
      reason: "OPERATOR-REASON",
      decidedAt: "2026-10-14T00:00:00.000Z",
    },
    priorDecision: null,
  },
});

describe("blind export", () => {
  const exported = blindCards({ cutoffAt: "2026-10-13T00:00:00.000Z" }, [
    trend("dos_a", 1),
    trend("dos_b", 2),
    trend("dos_c", 3),
  ]);
  const markdown = blindCardsMarkdown(exported);
  const json = JSON.stringify(exported);

  it("keeps the card's text and its cited evidence", () => {
    expect(exported.cards).toHaveLength(3);
    expect(exported.cards[0]?.movement).toBe("señal fuerte, desde hace 4 días");
    expect(exported.cards[0]?.curve).toBe("hn 0→1→2→9 · 1 fuente · apareció en hn hace 12 días");
    expect(markdown).toContain("[itm_hn_1] Item · hn · 2026-10-10 · https://a.example/1");
  });

  it("carries no judge, arm, position, score or provenance field", () => {
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(exported);
    for (const key of keys) {
      expect(key).not.toMatch(
        /judge|utility|arm|position|rank|score|decision|origin|run|dossier|trend|model|provider/i,
      );
    }
    const values = [
      "42.4242",
      "1.2345",
      "0.7777",
      "run_v3_20261013_secret",
      "dos_a",
      "sig_dos_a",
      "claude",
      "trend-presentation",
      "thread-secret",
      "OPERATOR-REASON",
      "rechaz",
    ];
    for (const value of values) {
      expect(json).not.toContain(value);
      expect(markdown).not.toContain(value);
    }
    for (const card of exported.cards) {
      expect(Object.keys(card).toSorted()).toEqual([
        "coverage",
        "curve",
        "evidence",
        "fit",
        "movement",
        "ref",
        "section",
        "title",
      ]);
    }
  });

  it("orders cards by an opaque reference, not by the engine's position", () => {
    const refs = exported.cards.map((card) => card.ref);
    expect(refs).toEqual(refs.toSorted());
    expect(refs.every((ref) => /^t-[0-9a-f]{8}$/.test(ref))).toBe(true);
  });
});
