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
  activeCaptureText,
  decisionPanelState,
  evidenceAlsoIn,
  incompleteSourcesText,
  movementBadge,
  movementChart,
  movementHeadline,
  quietSourcesText,
  shownEvidence,
  weekRangeLabels,
  weekStartLabels,
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

  it("names each week by its first day for the weeks table", () => {
    expect(weekStartLabels("2026-11-11T00:00:00.000Z")).toEqual([
      "14 oct",
      "21 oct",
      "28 oct",
      "4 nov",
    ]);
  });
});

describe("movementChart", () => {
  it("keeps sources with items as series and names the quiet and unused ones", () => {
    const chart = movementChart({ curve: REBOUND });
    expect(chart.series.map((entry) => entry.name)).toEqual(["Hacker News"]);
    expect(chart.quiet).toEqual(["github", "huggingface", "npm", "rss"]);
    expect(chart.uncaptured).toEqual([]);
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
    [
      "a source without items and with uncaptured weeks",
      [row("hn", [1, 2, 3, 4]), row("github", [0, null, 0, null], "partial")],
      [1, null, 3, null],
    ],
    [
      "a single source never captured",
      [row("github", [null, null, null, null], "partial")],
      [null, null, null, null],
    ],
    [
      "no source with items",
      [row("github", [0, 0, 0, 0]), row("npm", [0, null, 0, 0])],
      [0, null, 0, 0],
    ],
    ["only the unused source", [row("wikipedia", [], "unused")], [null, null, null, null]],
  ])("adds the weeks of %s", (_, curve, totals) => {
    expect(movementChart({ curve }).totals).toEqual(totals);
  });

  it("tells captured zeros from weeks nobody captured", () => {
    const chart = movementChart({
      curve: [
        row("hn", [1, 2, 3, 4]),
        row("github", [0, null, 0, null], "partial"),
        row("npm", [0, 0, 0, 0]),
      ],
    });
    expect(chart.series.map((entry) => entry.source)).toEqual(["hn"]);
    expect(chart.quiet).toEqual(["npm"]);
    expect(chart.uncaptured).toEqual(["github"]);
    // The figure states no number for a week some source did not capture.
    expect(movementHeadline(chart)).toEqual({
      count: null,
      last: "Última semana sin captura completa",
      previous: "3 la anterior",
    });
    expect(quietSourcesText(chart, [], [])).toEqual({
      text: "Sin publicaciones en npm.",
      caveat: null,
      uncaptured: "Sin captura completa en GitHub: no se sabe si tuvo publicaciones.",
      saidSources: ["github"],
    });
  });

  it("says nothing was captured instead of zero for a source never captured", () => {
    const chart = movementChart({ curve: [row("github", [null, null, null, null], "partial")] });
    expect(chart.series).toEqual([]);
    expect(chart.quiet).toEqual([]);
    expect(movementHeadline(chart).count).toBeNull();
    expect(quietSourcesText(chart, [coverage("github", 0)], [])).toMatchObject({
      text: null,
      uncaptured: "Sin captura completa en GitHub: no se sabe si tuvo publicaciones.",
    });
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
  const chart = { quiet: ["github", "huggingface", "npm"], uncaptured: [] };

  it("lists the quiet sources without a caveat when they were captured", () => {
    expect(
      quietSourcesText(chart, [coverage("github", 28), coverage("npm", 28)], [])?.caveat,
    ).toBeNull();
    expect(quietSourcesText(chart, [], [])?.text).toBe(
      "Sin publicaciones en GitHub, Hugging Face y npm.",
    );
    expect(quietSourcesText({ quiet: [], uncaptured: [] }, [], [])).toBeNull();
  });

  it("warns that a zero of a partly captured source does not confirm absence", () => {
    expect(quietSourcesText(chart, [coverage("github", 0, 28)], [])?.caveat).toBe(
      "Captura parcial en GitHub: un cero no confirma ausencia.",
    );
    expect(quietSourcesText(chart, [], ["npm", "github"])?.caveat).toBe(
      "Captura parcial en GitHub y npm: un cero no confirma ausencia.",
    );
  });

  it("warns about the daily capture of the sources drawn with bars", () => {
    const chart = movementChart({
      curve: [
        row("hn", [5, 4, 3, 11]),
        row("huggingface", [0, 2, 14, 3]),
        row("npm", [0, 0, 1, 0]),
      ],
    });
    expect(
      activeCaptureText(chart, [
        coverage("hn", 28),
        coverage("huggingface", 0, 28),
        coverage("npm", 20, 3),
      ]),
    ).toEqual({
      text: "Captura diaria incompleta en Hugging Face (0 de 28 días completos) y npm (20 de 28 días completos): sus cifras pueden quedarse cortas.",
      sources: ["huggingface", "npm"],
    });
    expect(activeCaptureText(chart, [coverage("hn", 28)])).toBeNull();
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
  const PRODUCTION = { threadId: "thread-video", linkedAt: AT };
  const PRIOR_RECORD = {
    text: "Antes lo decidiste el 30 sept 2026: aceptado · utilidad 5 de 5",
    reason: "buen tema",
    threadId: "thread-prior",
    linkLabel: "Abrir ese hilo",
  };
  const PRIOR_ONLY_RECORD = { ...PRIOR_RECORD, text: "Aceptado · utilidad 5 de 5" };

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
        meta: null,
        records: [PRIOR_ONLY_RECORD],
        links: [],
        primary: { kind: "create" },
        badge: null,
      },
    ],
    [
      "decided, with the same thread as prior decision",
      { trendKey: KEY, card: card({ decision: DECISION, priorDecision: DECISION }) },
      { records: [], links: [], badge: { label: "Decidida", variant: "success" } },
    ],
    [
      "decided, with a prior decision of another thread",
      { trendKey: KEY, card: card({ decision: DECISION, priorDecision: PRIOR }) },
      {
        headline: "Editado · utilidad 4 de 5",
        reason: "me interesa",
        meta: "Tu decisión · 9 nov 2026",
        records: [PRIOR_RECORD],
        links: [],
        primary: {
          kind: "open",
          threadId: "thread-decided",
          prepare: false,
          label: "Abrir hilo de video",
        },
      },
    ],
    [
      "in production",
      { trendKey: KEY, inbox: inbox({ production: PRODUCTION }) },
      {
        headline: "En producción desde el 10 nov 2026",
        records: [],
        links: [],
        primary: {
          kind: "open",
          threadId: "thread-video",
          prepare: true,
          label: "Abrir hilo de video",
        },
        badge: { label: "En producción", variant: "info" },
      },
    ],
    [
      "in production, with a prior decision of another thread",
      {
        trendKey: KEY,
        card: card({ priorDecision: PRIOR }),
        inbox: inbox({ production: PRODUCTION }),
      },
      {
        headline: "En producción desde el 10 nov 2026",
        records: [PRIOR_RECORD],
        links: [],
        primary: {
          kind: "open",
          threadId: "thread-video",
          prepare: true,
          label: "Abrir hilo de video",
        },
      },
    ],
    [
      "decided, in production in another thread",
      {
        trendKey: KEY,
        card: card({ decision: DECISION }),
        inbox: inbox({ production: PRODUCTION }),
      },
      {
        headline: "Editado · utilidad 4 de 5",
        reason: "me interesa",
        records: [],
        links: [{ threadId: "thread-video", label: "Abrir hilo en producción", prepare: true }],
        primary: {
          kind: "open",
          threadId: "thread-decided",
          prepare: false,
          label: "Abrir hilo decidido",
        },
        badge: { label: "Decidida", variant: "success" },
      },
    ],
    [
      "decided, in production in the same thread",
      {
        trendKey: KEY,
        card: card({ decision: DECISION }),
        inbox: inbox({ production: { threadId: "thread-decided", linkedAt: AT } }),
      },
      {
        links: [],
        primary: {
          kind: "open",
          threadId: "thread-decided",
          prepare: true,
          label: "Abrir hilo de video",
        },
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
      "kept watching, with a prior decision of another thread",
      { trendKey: KEY, card: card({ priorDecision: PRIOR }), inbox: inbox({ snoozed: SNOOZED }) },
      {
        headline: "Ya decidiste este tema el 30 sept 2026",
        stateLine: "En observación.",
        records: [PRIOR_ONLY_RECORD],
      },
    ],
    [
      "dismissed, with its own decision",
      {
        trendKey: KEY,
        card: card({ decision: DECISION }),
        inbox: inbox({ dismissed: { at: AT, reason: "Fuera de tema" }, snoozed: SNOOZED }),
      },
      {
        headline: "Descartada el 10 nov 2026",
        reason: "Fuera de tema",
        stateLine: null,
        records: [
          {
            text: "Tu decisión del 9 nov 2026: editado · utilidad 4 de 5",
            reason: "me interesa",
            threadId: "thread-decided",
            linkLabel: "Abrir hilo decidido",
          },
        ],
        links: [],
        primary: { kind: "reopen" },
        badge: { label: "Descartada", variant: "outline" },
      },
    ],
    [
      "dismissed, with a prior decision and a production thread",
      {
        trendKey: KEY,
        card: card({ priorDecision: PRIOR }),
        inbox: inbox({ dismissed: { at: AT, reason: "Repetido" }, production: PRODUCTION }),
      },
      {
        headline: "Descartada el 10 nov 2026",
        reason: "Repetido",
        records: [PRIOR_RECORD],
        links: [{ threadId: "thread-video", label: "Abrir hilo en producción", prepare: true }],
        primary: { kind: "reopen" },
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
