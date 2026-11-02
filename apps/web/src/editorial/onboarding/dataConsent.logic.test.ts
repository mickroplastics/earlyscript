import { SOURCE_CATALOG } from "@earlyscript/editorial-contracts/sourceCatalog";
import type { EditorialSourceEntry, EditorialSourcesCorpus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { failureText } from "../settings/sourcesText";
import {
  buildAcceptance,
  canonicalJson,
  catalogHash,
  consentSourceRows,
  corpusText,
  DATA_CONSENT_POLICY,
  deletionCommand,
  pendingWrites,
  policyHash,
  selectedSources,
  shownCollect,
  STORED_FIELDS,
  termsLine,
} from "./dataConsent.logic";

const entry = (source: string, overrides: Partial<EditorialSourceEntry> = {}) =>
  ({
    source,
    collect: false,
    rank: false,
    backtestRunId: null,
    backtest: null,
    rankBlocked: "no-backtest",
    collectBlocked: null,
    updatedAt: null,
    lastCapture: null,
    recentGaps: [],
    ...overrides,
  }) satisfies EditorialSourceEntry;

const MISSING: EditorialSourcesCorpus = {
  status: "missing",
  directory: "/home/op/earlyscript-data/live",
  fromDay: null,
  toDay: null,
  message: null,
};

// The server's defaults: catalog order, HN and GitHub on, unread or blocked sources locked.
const DEFAULT_ENTRIES = [
  entry("hn", { collect: true, rank: true, rankBlocked: null }),
  entry("github", { collect: true, rank: true, rankBlocked: null }),
  entry("arxiv"),
  entry("wikipedia"),
  entry("npm"),
  entry("stackexchange", { rankBlocked: "not-ready", collectBlocked: "pending-review" }),
  entry("bluesky", { rankBlocked: "not-ready", collectBlocked: "pending-review" }),
  entry("huggingface"),
  entry("lobsters", { rankBlocked: "not-ready", collectBlocked: "blocked" }),
  entry("rss"),
];

const ROWS = consentSourceRows(DEFAULT_ENTRIES);
const row = (id: string) => ROWS.find((candidate) => candidate.id === id)!;

describe("consentSourceRows", () => {
  it("puts capturable sources first, then pending, then blocked, catalog order within each", () => {
    expect(ROWS.map((candidate) => candidate.id)).toEqual([
      "hn",
      "github",
      "arxiv",
      "wikipedia",
      "npm",
      "huggingface",
      "rss",
      "stackexchange",
      "bluesky",
      "lobsters",
    ]);
  });

  it("drops ids the catalog does not know, such as the retired dev.to", () => {
    expect(consentSourceRows([entry("devto"), entry("hn")]).map((r) => r.id)).toEqual(["hn"]);
  });

  it("lets only a ready source the server does not block be captured", () => {
    expect(ROWS.filter((r) => r.capturable).map((r) => r.id)).toEqual([
      "hn",
      "github",
      "arxiv",
      "wikipedia",
      "npm",
      "huggingface",
      "rss",
    ]);
    // The server's lock wins over a catalog the client thinks is ready.
    const [locked] = consentSourceRows([entry("arxiv", { collectBlocked: "blocked" })]);
    expect(locked?.capturable).toBe(false);
  });

  it("takes collect from the server and the rest from the catalog", () => {
    expect(row("hn")).toMatchObject({
      name: "Hacker News",
      collect: true,
      termsLine: "Términos leídos el 26 de octubre de 2026",
      termsUrl: "https://www.ycombinator.com/legal",
      storedText: STORED_FIELDS.hn,
      retentionText: "Hasta la revisión del 27 nov 2026.",
    });
    expect(row("bluesky").retentionText).toBe("Efímera, fuera del corpus congelado.");
    expect(row("rss").termsUrl).toBeNull();
  });
});

describe("termsLine", () => {
  it("says the day the terms were read, that they are pending, or why the source is blocked", () => {
    expect(termsLine(SOURCE_CATALOG.arxiv)).toBe("Términos leídos el 31 de octubre de 2026");
    expect(termsLine(SOURCE_CATALOG.stackexchange)).toBe("Pendiente de leer sus términos");
    // Bluesky's guidelines were read, its Terms of Service were not: still pending.
    expect(termsLine(SOURCE_CATALOG.bluesky)).toBe("Pendiente de leer sus términos");
    expect(termsLine(SOURCE_CATALOG.lobsters)).toBe(
      "Bloqueada: Su robots.txt (leído por el adaptador el 31 de octubre de 2026) solo admite buscadores conocidos, con «User-agent: *» y «Disallow: /», y declara «Content-Signal: ai-input=no».",
    );
  });
});

describe("switches", () => {
  it("starts from the server: HN and GitHub on", () => {
    expect(selectedSources(ROWS, {})).toEqual(["hn", "github"]);
    expect(pendingWrites(ROWS, {})).toEqual([]);
  });

  it("writes only what the operator changed, and keeps catalog order", () => {
    const draft = { rss: true, github: false, arxiv: true, hn: true } as const;
    expect(selectedSources(ROWS, draft)).toEqual(["hn", "arxiv", "rss"]);
    expect(pendingWrites(ROWS, draft)).toEqual([
      { source: "github", collect: false },
      { source: "arxiv", collect: true },
      { source: "rss", collect: true },
    ]);
  });

  it("never turns on a locked source, and turns off one the server still holds on", () => {
    expect(shownCollect(row("lobsters"), { lobsters: true })).toBe(false);
    expect(selectedSources(ROWS, { stackexchange: true })).toEqual(["hn", "github"]);
    const stale = consentSourceRows([
      entry("stackexchange", { collect: true, collectBlocked: "pending-review" }),
    ]);
    expect(pendingWrites(stale, {})).toEqual([{ source: "stackexchange", collect: false }]);
  });
});

describe("texts", () => {
  it("does not block on a corpus without captures", () => {
    expect(corpusText(MISSING)).toBe(
      "Aún no hay capturas. El corpus se creará en /home/op/earlyscript-data/live con la primera.",
    );
    expect(
      corpusText({ ...MISSING, status: "ready", fromDay: "2026-10-03", toDay: "2026-11-01" }),
    ).toBe("Corpus en /home/op/earlyscript-data/live, con días del 3 oct 2026 al 31 oct 2026.");
  });

  it("puts the machine's corpus directory in the deletion command", () => {
    expect(deletionCommand("/home/op/earlyscript-data/live")).toBe(
      "engine purge --corpus /home/op/earlyscript-data/live --source <fuente> (--author <autor> | --url <enlace> | --feed <url del feed>)",
    );
  });

  it("dates the retention review and keeps the RSS excerpt policy", () => {
    expect(DATA_CONSENT_POLICY.retention.join(" ")).toContain(
      "hasta la revisión del 27 de noviembre de 2026",
    );
    expect(DATA_CONSENT_POLICY.retention.join(" ")).toContain("extracto de hasta 500 caracteres");
  });

  it("explains RPC failures in Spanish", () => {
    expect(failureText({ _tag: "EditorialSourcesError", reason: "unavailable" })).toBe(
      "Los servicios editoriales no están montados en este servidor.",
    );
    expect(failureText({ _tag: "EnvironmentAuthorizationError" })).toMatch(/^Este dispositivo/);
  });
});

describe("buildAcceptance", () => {
  it("records the sources, the acknowledgement, their terms days and two hashes", async () => {
    const acceptance = await buildAcceptance(selectedSources(ROWS, {}));
    expect(acceptance).toEqual({
      sources: ["hn", "github"],
      acknowledgedTerms: true,
      catalogHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      acceptedTermsDates: { hn: "2026-10-26", github: "2026-10-26" },
    });
    // Small enough for a decision row: ids, days and hashes, never raw texts.
    expect(JSON.stringify(acceptance).length).toBeLessThan(400);
  });

  it("records an empty list when the operator captures nothing", async () => {
    const acceptance = await buildAcceptance([]);
    expect(acceptance.sources).toEqual([]);
    expect(acceptance.acceptedTermsDates).toEqual({});
  });

  it("changes a hash when the catalog or the policy text changes", async () => {
    const base = await catalogHash();
    expect(await catalogHash()).toBe(base);
    expect(
      await catalogHash({ ...SOURCE_CATALOG, hn: { ...SOURCE_CATALOG.hn, status: "blocked" } }),
    ).not.toBe(base);
    const policy = await policyHash();
    expect(await policyHash({ ...DATA_CONSENT_POLICY, accept: "Acepto" })).not.toBe(policy);
  });

  it("hashes key order away", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
  });
});
