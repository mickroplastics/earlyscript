import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { EditorialDossierId, type EditorialTrendSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readDossierExtras } from "./dossierCard.ts";
// A dossier of engine.v3 (Opus A, run of 10 Oct 2026), trimmed to two evidence items;
// `saturated` and the headlines' `published_at` were added by hand with A's rule.
import dossierV2Fixture from "./fixtures/dossier-v2/01-dos_f352642c441d.json" with { type: "json" };
import {
  compareTrends,
  decodeDossierJson,
  loadRunDossiers,
  toDossiers,
  webUrlOrNull,
  windowCurve,
} from "./dossierFormat.ts";

describe("dossier/2", () => {
  effectIt.effect("decodes and converts to Dossier; the movement block stays for the card", () =>
    Effect.gen(function* () {
      const raw = dossierV2Fixture;
      const text = JSON.stringify(raw);
      const file = yield* decodeDossierJson(text);
      expect(file.schema_version).toBe("earlyscript.dossier/2");
      const [dossier] = toDossiers([file]);
      expect(dossier!.schema_version).toBe("earlyscript.dossier/1");
      expect(dossier!.dossier_id).toBe(raw.dossier_id);
      expect(dossier!.trend).toEqual(raw.trend);
      expect(dossier!.rankings).toEqual(raw.rankings);
      expect(dossier!.evidence.map((item) => item.item_id)).toEqual(
        raw.evidence.map((item) => item.item_id),
      );
      expect(dossier!.evidence.every((item) => !("week" in item) && !("also_in" in item))).toBe(
        true,
      );
      const card = readDossierExtras(text).card;
      expect(card?.movement).toBe(raw.movement.movement);
      expect(card?.section).toBe(raw.movement.section);
      expect(card?.saturated).toBe(raw.movement.saturation.saturated);
      expect(card?.headlines?.map((headline) => headline.day)).toEqual(
        raw.movement.fit.headlines.map((headline) => headline.published_at.slice(0, 10)),
      );
    }),
  );

  effectIt.effect("reads HTML-escaped evidence titles, excerpts and headlines as text", () =>
    Effect.gen(function* () {
      const escaped = "Flint &amp; Orca&#x27;s &quot;Zero&quot; &mdash; 1M context &middot; tools";
      const plain = 'Flint & Orca\'s "Zero" — 1M context · tools';
      const raw = structuredClone(dossierV2Fixture);
      raw.evidence[0]!.title = escaped;
      raw.evidence[0]!.excerpt = escaped;
      raw.movement.fit.headlines[0]!.title = escaped;
      const text = JSON.stringify(raw);
      const file = yield* decodeDossierJson(text);
      const [loaded] = loadRunDossiers("run_x", toDossiers([file]), [readDossierExtras(text)]);
      const first = loaded!.evidence.find((item) => item.itemId === raw.evidence[0]!.item_id);
      expect([first?.title, first?.excerpt]).toEqual([plain, plain]);
      expect(loaded!.summary.card?.headlines.map((headline) => headline.title)).toContain(plain);
    }),
  );
});

const day = (date: string, items: number, known = true) => ({
  day: date,
  items,
  authors: items,
  sources: items > 0 ? 1 : 0,
  known,
});

describe("windowCurve", () => {
  it("covers the days before the cutoff, zero before the trend and unknown in its gaps", () => {
    const curve = windowCurve(
      {
        cutoff_at: "2026-10-19T00:00:00.000Z",
        curve: [day("2026-10-15", 3), day("2026-10-16", 0, false), day("2026-10-18", 2)],
      },
      5,
    );
    expect(curve.map((entry) => [entry.day, entry.items, entry.known])).toEqual([
      ["2026-10-14", 0, true],
      ["2026-10-15", 3, true],
      ["2026-10-16", 0, false],
      ["2026-10-17", 0, false],
      ["2026-10-18", 2, true],
    ]);
  });
});

describe("compareTrends", () => {
  const trend = (
    id: string,
    fields: Partial<Pick<EditorialTrendSummary, "isNew" | "growth" | "items7d" | "affinity">>,
  ) =>
    ({
      dossierId: EditorialDossierId.make(id),
      isNew: true,
      growth: 1,
      items7d: 5,
      authors7d: 5,
      affinity: 0.6,
      score: 1,
      ...fields,
    }) as EditorialTrendSummary;
  const order = (sort: Parameters<typeof compareTrends>[0], trends: EditorialTrendSummary[]) =>
    trends.toSorted(compareTrends(sort)).map((entry) => entry.dossierId);

  it("puts new trends first, then weekly growth, with missing growth last", () => {
    expect(
      order("new-first-growth", [
        trend("seen-fast", { isNew: false, growth: 3 }),
        trend("new-unknown", { growth: null }),
        trend("new-slow", { growth: 0.5 }),
        trend("new-fast", { growth: 2 }),
      ]),
    ).toEqual(["new-fast", "new-slow", "new-unknown", "seen-fast"]);
  });

  it("sorts by weekly volume or by profile affinity on request", () => {
    const trends = [
      trend("a", { items7d: 4, affinity: 0.9 }),
      trend("b", { items7d: 16, affinity: 0.61 }),
      trend("c", { items7d: 11, affinity: null }),
    ];
    expect(order("volume", trends)).toEqual(["b", "c", "a"]);
    expect(order("affinity", trends)).toEqual(["a", "b", "c"]);
  });
});

describe("webUrlOrNull", () => {
  it("keeps http and https evidence links and drops every other scheme", () => {
    expect(webUrlOrNull("https://news.ycombinator.com/item?id=1")).toBe(
      "https://news.ycombinator.com/item?id=1",
    );
    expect(webUrlOrNull("http://example.com/a")).toBe("http://example.com/a");
    expect(webUrlOrNull('javascript:alert("x")')).toBeNull();
    expect(webUrlOrNull("data:text/html,x")).toBeNull();
    expect(webUrlOrNull("file:///etc/passwd")).toBeNull();
    expect(webUrlOrNull("not a url")).toBeNull();
    expect(webUrlOrNull(null)).toBeNull();
    expect(webUrlOrNull(undefined)).toBeNull();
  });
});
