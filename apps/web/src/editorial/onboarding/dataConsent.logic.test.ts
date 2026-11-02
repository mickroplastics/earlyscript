import { Item, SOURCE_ITEM_KEYS } from "@earlyscript/editorial-contracts/item";
import { SOURCE_CATALOG, SOURCE_IDS } from "@earlyscript/editorial-contracts/sourceCatalog";
import {
  PRESENTATION_EVIDENCE_LIMIT,
  PRESENTATION_EXCERPT_CHARS,
  type EditorialSourceEntry,
  type EditorialSourcesCorpus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CONNECTION_LOST, failureText, UNREACHABLE } from "../settings/sourcesText";
import {
  buildAcceptance,
  canonicalJson,
  catalogHash,
  COMMON_STORED_LINE,
  consentSourceRows,
  corpusText,
  DATA_CONSENT_POLICY,
  deletionCommand,
  describedKeys,
  pendingWrites,
  policyHash,
  selectedSources,
  shownCollect,
  SERVER_LOCK_TEXT,
  STORED_FIELDS,
  storedText,
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
      storedText:
        "Título; enlace a la discusión; usuario que la envió; texto de la publicación, hasta 4.000 caracteres.",
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
    expect(await policyHash()).toBe(policy);
    // Every accepted text counts: the policy, and what a source stores (Sol, H3).
    const accept = DATA_CONSENT_POLICY.accept;
    Object.assign(DATA_CONSENT_POLICY, { accept: "Acepto" });
    try {
      expect(await policyHash()).not.toBe(policy);
    } finally {
      Object.assign(DATA_CONSENT_POLICY, { accept });
    }
    const rss = STORED_FIELDS.rss;
    Object.assign(STORED_FIELDS, { rss: { ...rss, body: "el artículo entero" } });
    try {
      expect(await policyHash()).not.toBe(policy);
      expect(await catalogHash()).toBe(base);
    } finally {
      Object.assign(STORED_FIELDS, { rss });
    }
    expect(await policyHash()).toBe(policy);
  });

  it("hashes key order away", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
  });
});

describe("what each source stores (Sol, H2)", () => {
  it("describes exactly the keys each source's items carry", () => {
    for (const source of SOURCE_IDS) {
      expect(describedKeys(source)).toEqual([...SOURCE_ITEM_KEYS[source]].toSorted());
    }
  });

  it("covers every key of the corpus item, so a new field must be described", () => {
    const declared = new Set(SOURCE_IDS.flatMap((source) => SOURCE_ITEM_KEYS[source]));
    expect([...declared].toSorted()).toEqual(Object.keys(Item.fields).toSorted());
  });

  it("names RSS's feed URL and body origin, and arXiv's GitHub entities", () => {
    expect(storedText("rss")).toBe(
      "Título; enlace; autor, o el nombre del feed si no lo hay; extracto de hasta 500 caracteres (nunca el artículo entero); origen del extracto (resumen o contenido); URL del feed.",
    );
    expect(storedText("arxiv")).toContain(
      "repositorios de GitHub citados en el resumen o en sus comentarios",
    );
    expect(COMMON_STORED_LINE).toBe(
      "Todas las fuentes guardan además: identificador, fuente, enlace externo si lo hay, fecha de publicación, fecha de captura, entidades detectadas, longitud del cuerpo y si fue truncado.",
    );
    // RSS's retention sentence no longer reads as the full list of what it keeps.
    expect(DATA_CONSENT_POLICY.retention.join(" ")).not.toContain("solo se guarda");
  });
});

describe("what goes to the model provider (Sol, H4)", () => {
  it("quotes the server's own limits", () => {
    expect(PRESENTATION_EVIDENCE_LIMIT).toBe(12);
    expect(PRESENTATION_EXCERPT_CHARS).toBe(500);
    expect(DATA_CONSENT_POLICY.outbound[2]).toContain(
      "como máximo 12 ítems de evidencia con su fuente, fecha, enlace, título y un extracto recortado a 500 caracteres",
    );
  });
});

describe("connection failures (Sol, H5)", () => {
  it("never shows the transport's English", () => {
    expect(failureText(new Error("beatriz is not connected."))).toBe(CONNECTION_LOST);
    expect(failureText(new Error("Environment disconnected."))).toBe(CONNECTION_LOST);
    expect(failureText(new Error("Request timed out after 30s"))).toBe(CONNECTION_LOST);
    expect(failureText(new Error("Host not reachable"))).toBe(CONNECTION_LOST);
    expect(failureText(new Error("Something odd in English"))).toBe(UNREACHABLE);
    expect(failureText("socket closed")).toBe(UNREACHABLE);
    expect(failureText(undefined)).toBe(UNREACHABLE);
  });
});

describe("the server's lock (Sol, H6)", () => {
  it("shows the server's lock when the local catalog says ready", () => {
    const [blocked] = consentSourceRows([entry("arxiv", { collectBlocked: "blocked" })]);
    expect(blocked).toMatchObject({
      capturable: false,
      status: "blocked",
      termsLine: SERVER_LOCK_TEXT.blocked,
    });
    expect(blocked?.termsLine).toBe(
      "Bloqueada en esta instalación: el servidor no permite capturarla.",
    );
    const [pending] = consentSourceRows([entry("npm", { collectBlocked: "pending-review" })]);
    expect(pending).toMatchObject({
      status: "pending-review",
      termsLine: SERVER_LOCK_TEXT["pending-review"],
    });
  });

  it("keeps the catalog's own words when the server agrees", () => {
    const [lobsters] = consentSourceRows([entry("lobsters", { collectBlocked: "blocked" })]);
    expect(lobsters?.termsLine).toMatch(/^Bloqueada: Su robots\.txt/);
  });
});
