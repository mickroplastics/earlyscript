// @effect-diagnostics globalDate:off - pure date arithmetic on ISO strings.
// Read-only compatibility with Earlywindow's dossier/1 and corpus/1
// (~/tesis/early-window, src/contract/dossier.ts and corpus.ts at engine.v0.02).
import * as Schema from "effect/Schema";

import { DOSSIER_SCHEMA_VERSION, type Dossier, SignalStage } from "./dossier.ts";
import { DataGapReason, SourceId, UtcDay } from "./source.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));

export const EarlywindowDossier = Schema.Struct({
  schema_version: Schema.Literal("dossier/1"),
  dossier_id: Schema.String,
  created_at: Schema.String,
  cutoff_at: Schema.String,
  engine: Schema.Struct({
    version: Schema.String,
    run_id: Schema.String,
    mode: Schema.Literals(["daily", "backtest", "experiment"]),
    config_version: Schema.String,
    config_hash: Schema.String,
    corpus_hash: Schema.String,
    embedding: Schema.Struct({
      model: Schema.String,
      revision: Schema.String,
      dtype: Schema.String,
      pooling: Schema.Literals(["last_token", "mean"]),
      batch_size: Schema.Int,
      runtime: Schema.String,
    }),
  }),
  profile: Schema.Struct({
    version: Schema.Int,
    hash: Schema.String,
    include_score: Schema.Number,
    exclude_score: Schema.Number,
  }),
  signal: Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    label_source: Schema.Literals(["terms", "llm", "operator"]),
    stage: SignalStage,
    corroboration: Schema.Literals(["multi_source", "single_source"]),
    first_seen_at: Schema.String,
    top_terms: Schema.Array(Schema.String),
  }),
  curve: Schema.Array(
    Schema.Struct({
      day: UtcDay,
      items: Schema.Int,
      sources: Schema.Int,
      authors: Schema.Int,
      known: Schema.Boolean,
    }),
  ),
  rank: Schema.Struct({
    method: Schema.String,
    reference: Schema.Literal("zero"),
    score: Schema.Number,
    components: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        value: Schema.NullOr(Schema.Number),
        weight: Schema.Number,
        contribution: Schema.Number,
      }),
    ),
  }),
  coverage: Schema.Struct({
    window_days: Schema.Int,
    by_source: Schema.Array(
      Schema.Struct({
        source: SourceId,
        days_complete: Schema.Int,
        days_partial: Schema.Int,
        days_unavailable: Schema.Int,
      }),
    ),
  }),
  observations: Schema.Array(Schema.Unknown),
  evidence: Schema.Array(
    Schema.Struct({
      item_id: Schema.String,
      source: SourceId,
      permalink: Schema.String,
      external_url: Schema.NullOr(Schema.String),
      published_at: Schema.String,
      author: Schema.NullOr(Schema.String),
      title: Schema.String,
      excerpt: Schema.String,
      retrieved_at: Schema.String,
    }),
  ),
  evidence_status: Schema.Literals(["sufficient", "thin"]),
  catalog_matches: Schema.Array(Schema.Unknown),
  data_gaps: Schema.Array(Schema.Struct({ source: SourceId, day: UtcDay, reason: DataGapReason })),
});
export type EarlywindowDossier = typeof EarlywindowDossier.Type;

export const EarlywindowCorpusManifest = Schema.Struct({
  schema_version: Schema.Literal("corpus/1"),
  from_day: UtcDay,
  to_day: UtcDay,
  files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Sha256, bytes: Schema.Int })),
  selection_bias: Schema.Literal("present_stars"),
  selection: Schema.Record(Schema.String, Schema.String),
  purges: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  corpus_hash: Sha256,
  written_at: Schema.String,
});
export type EarlywindowCorpusManifest = typeof EarlywindowCorpusManifest.Type;

export const decodeEarlywindowDossier = Schema.decodeUnknownSync(EarlywindowDossier);

const DAY_MS = 86_400_000;
const dayOffset = (cutoffAt: string, days: number) =>
  new Date(Date.parse(cutoffAt) - days * DAY_MS).toISOString().slice(0, 10);

/** Window counts a dossier/1 does not store, rebuilt from its curve. */
function windowCounts(dossier: EarlywindowDossier) {
  const last7 = dayOffset(dossier.cutoff_at, 7);
  const prev7 = dayOffset(dossier.cutoff_at, 14);
  let items7d = 0;
  let itemsPrev7d = 0;
  for (const point of dossier.curve) {
    if (point.day >= last7) items7d += point.items;
    else if (point.day >= prev7) itemsPrev7d += point.items;
  }
  return { items7d, itemsPrev7d };
}

const componentValue = (dossier: EarlywindowDossier, name: string) =>
  dossier.rank.components.find((component) => component.name === name)?.value ?? null;

interface Positions {
  readonly eligible: number;
  readonly baseline: number;
  readonly weighted: number;
}

/**
 * Converts one dossier/1. Positions come from the whole run (see fromEarlywindowRun):
 * a single dossier does not know where it stands.
 */
export function fromEarlywindowDossier(dossier: EarlywindowDossier, positions: Positions): Dossier {
  const { items7d, itemsPrev7d } = windowCounts(dossier);
  const growth = componentValue(dossier, "growth") ?? Math.log((items7d + 1) / (itemsPrev7d + 1));
  const logAuthors = componentValue(dossier, "log_authors_7d");
  const sources = [...new Set(dossier.evidence.map((item) => item.source))].toSorted();
  return {
    schema_version: DOSSIER_SCHEMA_VERSION,
    origin: "earlywindow",
    dossier_id: dossier.dossier_id,
    run_id: dossier.engine.run_id,
    created_at: dossier.created_at,
    cutoff_at: dossier.cutoff_at,
    engine: {
      version: `earlywindow ${dossier.engine.config_version}`,
      config_hash: dossier.engine.config_hash,
      corpus_hash: dossier.engine.corpus_hash,
      embedding: { ...dossier.engine.embedding, platform: null, arch: null },
    },
    profile: { name: null, version: dossier.profile.version, hash: dossier.profile.hash },
    trend: {
      id: dossier.signal.id,
      label: dossier.signal.label,
      label_source:
        dossier.signal.label_source === "llm" ? "assistant" : dossier.signal.label_source,
      top_terms: dossier.signal.top_terms,
      stage: dossier.signal.stage,
      corroboration: dossier.signal.corroboration,
      first_seen_at: dossier.signal.first_seen_at,
      last_seen_at: null,
      sources,
      items_total: null,
      items_7d: items7d,
      items_prev_7d: itemsPrev7d,
      authors_7d: logAuthors === null ? 0 : Math.round(Math.exp(logAuthors) - 1),
      growth,
    },
    profile_fit: {
      include_score: dossier.profile.include_score,
      exclude_score: dossier.profile.exclude_score,
      passes: true,
      nearest_include: null,
    },
    rankings: {
      eligible: positions.eligible,
      baseline: {
        method: "baseline.items_7d",
        position: positions.baseline,
        score: items7d,
        components: [{ name: "items_7d", value: items7d, weight: 1, contribution: items7d }],
      },
      weighted: {
        method: dossier.rank.method,
        position: positions.weighted,
        score: dossier.rank.score,
        components: dossier.rank.components,
      },
    },
    curve: dossier.curve,
    coverage: {
      ...dossier.coverage,
      // Earlywindow lists GitHub's by-design partial days as gaps; only failures are uncertainty.
      uncertain: dossier.data_gaps.some((gap) => gap.reason !== "partial"),
    },
    data_gaps: dossier.data_gaps,
    evidence: dossier.evidence.map((item) => ({ ...item, similarity: null })),
    evidence_status: dossier.evidence_status,
  };
}

/**
 * Converts every dossier of one Earlywindow run. Weighted order is the run's emission
 * order (score desc, signal id asc); baseline order is items_7d desc, signal id asc,
 * the rule of Earlywindow's backtest.
 */
export function fromEarlywindowRun(dossiers: ReadonlyArray<EarlywindowDossier>): Array<Dossier> {
  const bySignal = (a: EarlywindowDossier, b: EarlywindowDossier) =>
    a.signal.id < b.signal.id ? -1 : a.signal.id > b.signal.id ? 1 : 0;
  const weighted = dossiers.toSorted((a, b) => b.rank.score - a.rank.score || bySignal(a, b));
  const items7d = new Map(dossiers.map((d) => [d.dossier_id, windowCounts(d).items7d]));
  const baseline = dossiers.toSorted(
    (a, b) => items7d.get(b.dossier_id)! - items7d.get(a.dossier_id)! || bySignal(a, b),
  );
  return weighted.map((dossier) =>
    fromEarlywindowDossier(dossier, {
      eligible: dossiers.length,
      baseline: baseline.indexOf(dossier) + 1,
      weighted: weighted.indexOf(dossier) + 1,
    }),
  );
}
