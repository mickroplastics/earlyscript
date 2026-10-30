import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { Dossier } from "./dossier.ts";
import { decodeEarlywindowDossier, fromEarlywindowRun } from "./earlywindow.ts";

const decodeDossier = Schema.decodeUnknownSync(Dossier);

const days = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);

/** A dossier/1 as Earlywindow engine.v0.02 writes it, with invented content. */
function earlywindowDossier(id: string, signal: string, score: number, perDay: [number, number]) {
  return {
    schema_version: "dossier/1",
    dossier_id: id,
    created_at: "2026-10-27T00:43:00.000Z",
    cutoff_at: "2026-10-19T00:00:00.000Z",
    engine: {
      version: "0.0.1",
      run_id: "run_20261019_x",
      mode: "daily",
      config_version: "engine.v0.02",
      config_hash: `sha256:${"a".repeat(64)}`,
      corpus_hash: `sha256:${"b".repeat(64)}`,
      embedding: {
        model: "qwen",
        revision: "r",
        dtype: "q8",
        pooling: "last_token",
        batch_size: 1,
        runtime: "rt",
      },
    },
    profile: {
      version: 1,
      hash: `sha256:${"c".repeat(64)}`,
      include_score: 0.64,
      exclude_score: 0.2,
    },
    signal: {
      id: signal,
      label: "agents compiler rust",
      label_source: "terms",
      stage: "growing",
      corroboration: "single_source",
      first_seen_at: "2026-10-05T10:00:00.000Z",
      top_terms: ["agents", "compiler", "rust"],
    },
    curve: [
      ...days(5, 7).map((day) => ({
        day,
        items: perDay[0],
        sources: 1,
        authors: perDay[0],
        known: true,
      })),
      ...days(12, 7).map((day) => ({
        day,
        items: perDay[1],
        sources: 1,
        authors: perDay[1],
        known: true,
      })),
    ],
    rank: {
      method: "weighted_sum.v0.01",
      reference: "zero",
      score,
      components: [
        { name: "growth", value: 1.1, weight: 0.5, contribution: 0.55 },
        { name: "log_authors_7d", value: Math.log(1 + 6), weight: 0.2, contribution: 0.389182 },
        { name: "include_score", value: 0.64, weight: 0.3, contribution: 0.192 },
      ],
    },
    coverage: {
      window_days: 28,
      by_source: [{ source: "hn", days_complete: 28, days_partial: 0, days_unavailable: 0 }],
    },
    observations: [],
    evidence: [
      {
        item_id: "itm_hn_1",
        source: "hn",
        permalink: "https://news.ycombinator.com/item?id=1",
        external_url: null,
        published_at: "2026-10-15T08:00:00.000Z",
        author: "someone",
        title: "A title",
        excerpt: "",
        retrieved_at: "2026-10-21T00:00:00.000Z",
      },
    ],
    evidence_status: "thin",
    catalog_matches: [],
    data_gaps: [{ source: "github", day: "2026-10-12", reason: "partial" }],
  };
}

describe("Earlywindow dossier/1 reader", () => {
  it("rebuilds window counts and both positions from a run", () => {
    const a = decodeEarlywindowDossier(earlywindowDossier("dos_a", "sig_a", 1.2, [0, 1]));
    const b = decodeEarlywindowDossier(earlywindowDossier("dos_b", "sig_b", 1.0, [1, 2]));
    const [first, second] = fromEarlywindowRun([b, a]);
    expect(first?.dossier_id).toBe("dos_a");
    expect(first?.rankings).toMatchObject({
      eligible: 2,
      weighted: { position: 1 },
      baseline: { position: 2, score: 7 },
    });
    expect(second?.rankings).toMatchObject({
      weighted: { position: 2 },
      baseline: { position: 1, score: 14 },
    });
    expect(second?.trend).toMatchObject({
      items_7d: 14,
      items_prev_7d: 7,
      authors_7d: 6,
      growth: 1.1,
      sources: ["hn"],
    });
    expect(first?.coverage.uncertain).toBe(false);
    expect(first?.engine.embedding.platform).toBeNull();
    expect(() => decodeDossier(first)).not.toThrow();
  });

  it("treats failed collection as uncertainty and rejects other schemas", () => {
    const raw = earlywindowDossier("dos_a", "sig_a", 1, [0, 1]);
    const failed = {
      ...raw,
      data_gaps: [{ source: "hn", day: "2026-10-12", reason: "fetch_failed" }],
    };
    expect(fromEarlywindowRun([decodeEarlywindowDossier(failed)])[0]?.coverage.uncertain).toBe(
      true,
    );
    expect(() => decodeEarlywindowDossier({ ...raw, schema_version: "dossier/2" })).toThrow();
  });
});
