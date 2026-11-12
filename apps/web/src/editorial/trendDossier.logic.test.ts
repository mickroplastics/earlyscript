import type {
  EditorialCardCurveRow,
  EditorialCardDecision,
  EditorialEvidenceItem,
  EditorialTrendCard,
  EditorialTrendInboxState,
} from "@t3tools/contracts";
import { EditorialTrendKey } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decisionPanelState,
  evidenceAlsoIn,
  incompleteSourcesText,
  movementBadge,
  movementChart,
  movementHeadline,
  quietSourcesText,
  shownEvidence,
  weekRangeLabels,
} from "./trendDossier.logic";

const row = (
  source: string,
  weeks: ReadonlyArray<number | null>,
  status: EditorialCardCurveRow["status"] = "comparable",
): EditorialCardCurveRow => ({ source, status, weeks });

// The rebound of the 11 November run: one source with items, four quiet, Wikipedia unused.
const REBOUND = [
  row("hn", [5, 4, 3, 11]),
  row("github", [0, 0, 0, 0]),
  row("huggingface", [0, 0, 0, 0]),
  row("npm", [0, 0, 0, 0]),
  row("wikipedia", [], "unused"),
  row("rss", [0, 0, 0, 0], "partial"),
];

const coverage = (source: string, daysComplete: number, daysPartial = 0) => ({
  source,
  windowDays: 28,
  daysComplete,
  daysPartial,
  daysUnavailable: 28 - daysComplete - daysPartial,
});

describe("weekRangeLabels", () => {
  it.each([
    ["2026-11-11T00:00:00.000Z", ["14 a 20 oct", "21 a 27 oct", "28 oct a 3 nov", "4 a 10 nov"]],
    ["2026-11-11T05:30:00.000Z", ["14 a 20 oct", "21 a 27 oct", "28 oct a 3 nov", "4 a 10 nov"]],
    [null, ["Hace 3 sem.", "Hace 2 sem.", "Semana anterior", "Última semana"]],
  ])("labels the weeks before the cutoff %s", (cutoffAt, labels) => {
    expect(weekRangeLabels(cutoffAt)).toEqual(labels);
  });
});

describe("movementChart", () => {
  it("keeps sources with items as series and names the quiet and unused ones", () => {
    const chart = movementChart({ curve: REBOUND });
    expect(chart.series.map((entry) => entry.name)).toEqual(["Hacker News"]);
    expect(chart.quiet).toEqual(["github", "huggingface", "npm", "rss"]);
    expect(chart.unused).toEqual(["wikipedia"]);
    expect(chart.totals).toEqual([5, 4, 3, 11]);
    expect(chart.max).toBe(11);
  });

  it.each([
    [
      "two new sources",
      [row("hn", [0, 0, 0, 3]), row("rss", [0, 0, 0, 2], "partial")],
      [0, 0, 0, 5],
    ],
    [
      "an uncaptured week",
      [row("hn", [1, 3, 0, 5]), row("github", [0, 0, null, 2])],
      [1, 3, null, 7],
    ],
  ])("adds the weeks of %s", (_, curve, totals) => {
    expect(movementChart({ curve }).totals).toEqual(totals);
  });

  it("shows the total row of a derived dossier as its own series", () => {
    const chart = movementChart({ curve: [row("total", [3, 4, null, 9], "total")] });
    expect(chart.series).toEqual([
      { source: "total", name: "Total", partial: false, weeks: [3, 4, null, 9] },
    ]);
  });
});

describe("movementHeadline", () => {
  it("states the last week and the one before", () => {
    expect(movementHeadline({ totals: [5, 4, 3, 11] })).toEqual({
      count: 11,
      last: "en la última semana",
      previous: "3 la anterior",
    });
  });

  it("never turns an uncaptured week into a number", () => {
    expect(movementHeadline({ totals: [5, 4, null, null] })).toEqual({
      count: null,
      last: "Última semana sin captura completa",
      previous: "la anterior sin captura",
    });
  });
});

describe("quietSourcesText", () => {
  const chart = { quiet: ["github", "huggingface", "npm"] };

  it("lists the quiet sources without a caveat when they were captured", () => {
    expect(
      quietSourcesText(chart, [coverage("github", 28), coverage("npm", 28)], [])?.caveat,
    ).toBeNull();
    expect(quietSourcesText(chart, [], [])?.text).toBe(
      "Sin publicaciones en GitHub, Hugging Face y npm.",
    );
    expect(quietSourcesText({ quiet: [] }, [], [])).toBeNull();
  });

  it("warns that a zero of a partly captured source does not confirm absence", () => {
    expect(quietSourcesText(chart, [coverage("github", 0, 28)], [])?.caveat).toBe(
      "Captura parcial en GitHub: un cero no confirma ausencia.",
    );
    expect(quietSourcesText(chart, [], ["npm", "github"])?.caveat).toBe(
      "Captura parcial en GitHub y npm: un cero no confirma ausencia.",
    );
  });

  it("leaves to the incomplete line only the sources the caveat did not name", () => {
    expect(incompleteSourcesText(["github", "rss"], ["github"])).toBe(
      "Cobertura incompleta en RSS: alguna semana tiene días sin captura.",
    );
    expect(incompleteSourcesText(["github"], ["github"])).toBeNull();
  });
});

describe("movementBadge", () => {
  it.each([
    ["new", "Nueva", "info"],
    ["rebound", "Rebote", "warning"],
    ["strong", "Señal fuerte", "info"],
    ["weak", "Señal débil", "outline"],
    ["stable", "Estable", "secondary"],
    ["falling", "En caída", "secondary"],
  ] as const)("labels %s", (movement, label, variant) => {
    expect(movementBadge({ movement })).toEqual({ label, variant });
  });

  it("shows no badge for a card without movement", () => {
    expect(movementBadge({ movement: null })).toBeNull();
  });
});

describe("decisionPanelState", () => {
  const AT = "2026-11-10T09:00:00.000Z";
  const KEY = EditorialTrendKey.make("sig_1");
  const DECISION: EditorialCardDecision = {
    threadId: "thread-decided",
    action: "edit",
    utility: 4,
    reason: "me interesa",
    decidedAt: "2026-11-09T10:00:00.000Z",
  };
  const PRIOR: EditorialCardDecision = {
    threadId: "thread-prior",
    action: "accept",
    utility: 5,
    reason: "buen tema",
    decidedAt: "2026-09-30T10:00:00.000Z",
  };
  const inbox = (patch: Partial<EditorialTrendInboxState>): EditorialTrendInboxState => ({
    isNew: false,
    seenRunId: null,
    seenAt: null,
    snoozed: null,
    dismissed: null,
    production: null,
    ...patch,
  });
  const card = (patch: Partial<EditorialTrendCard>) =>
    ({ decision: null, priorDecision: null, ...patch }) as EditorialTrendCard;
  const SNOOZED = { at: AT, until: null, returnWhen: null };

  it.each([
    [
      "undecided",
      { trendKey: KEY },
      { headline: "Sin decidir", primary: { kind: "create" }, badge: null },
    ],
    [
      "decided",
      { trendKey: KEY, card: card({ decision: DECISION }) },
      {
        headline: "Editado · utilidad 4 de 5",
        reason: "me interesa",
        meta: "Tu decisión · 9 nov 2026",
        primary: { kind: "open", threadId: "thread-decided", prepare: false },
        badge: { label: "Decidida", variant: "success" },
      },
    ],
    [
      "decided before on the same topic",
      { trendKey: KEY, card: card({ priorDecision: PRIOR }) },
      {
        headline: "Ya decidiste este tema el 30 sept 2026",
        meta: "Aceptado · utilidad 5 de 5 · «buen tema»",
        prior: PRIOR,
        priorLine: null,
        primary: { kind: "create" },
        badge: null,
      },
    ],
    [
      "decided, with the same thread as prior decision",
      { trendKey: KEY, card: card({ decision: DECISION, priorDecision: DECISION }) },
      { prior: null, priorLine: null, badge: { label: "Decidida", variant: "success" } },
    ],
    [
      "decided, with a prior decision of another thread",
      { trendKey: KEY, card: card({ decision: DECISION, priorDecision: PRIOR }) },
      {
        headline: "Editado · utilidad 4 de 5",
        prior: PRIOR,
        priorLine: "Antes lo decidiste el 30 sept 2026: aceptado.",
      },
    ],
    [
      "in production",
      { trendKey: KEY, inbox: inbox({ production: { threadId: "thread-video", linkedAt: AT } }) },
      {
        headline: "En producción desde el 10 nov 2026",
        primary: { kind: "open", threadId: "thread-video", prepare: true },
        badge: { label: "En producción", variant: "info" },
      },
    ],
    [
      "kept watching",
      { trendKey: KEY, inbox: inbox({ snoozed: SNOOZED }) },
      {
        headline: "Sin decidir",
        stateLine: "En observación.",
        primary: { kind: "create" },
        badge: { label: "En observación", variant: "secondary" },
      },
    ],
    [
      "dismissed",
      {
        trendKey: KEY,
        card: card({ decision: DECISION }),
        inbox: inbox({ dismissed: { at: AT, reason: "Fuera de tema" }, snoozed: SNOOZED }),
      },
      {
        headline: "Descartada el 10 nov 2026",
        reason: "Fuera de tema",
        stateLine: null,
        primary: { kind: "reopen" },
        badge: { label: "Descartada", variant: "outline" },
      },
    ],
    [
      "from a server without trend keys",
      { card: card({ decision: DECISION }) },
      { primary: null, badge: null },
    ],
  ] as const)("%s", (_, trend, expected) => {
    expect(decisionPanelState(trend)).toMatchObject(expected);
  });
});

describe("evidence", () => {
  const item = (index: number): EditorialEvidenceItem => ({
    itemId: `itm_hn_${index}`,
    source: "hn",
    title: `Item ${index}`,
    excerpt: "",
    author: null,
    publishedAt: "2026-11-10T00:00:00.000Z",
    permalink: null,
    externalUrl: null,
  });
  const ten = Array.from({ length: 10 }, (_, index) => item(index + 1));

  it("shows three items until all are asked for", () => {
    expect(shownEvidence(ten.slice(0, 6), ten, false)).toHaveLength(3);
    expect(shownEvidence(ten.slice(0, 6), ten, true)).toHaveLength(10);
    // While the rest loads, the first page stays.
    expect(shownEvidence(ten.slice(0, 6), null, true)).toHaveLength(6);
  });

  it("indexes the card's alsoIn by item id", () => {
    const alsoIn = evidenceAlsoIn({
      evidence: [
        { itemId: "itm_hn_1", source: "hn", title: "a", day: null, url: null, alsoIn: ["rss"] },
        { itemId: "itm_hn_2", source: "hn", title: "b", day: null, url: null },
        { itemId: null, source: "hn", title: "c", day: null, url: null, alsoIn: ["npm"] },
      ],
    });
    expect([...alsoIn]).toEqual([["itm_hn_1", ["rss"]]]);
  });
});
