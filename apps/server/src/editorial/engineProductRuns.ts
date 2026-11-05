// @effect-diagnostics nodeBuiltinImport:off - reads the product's run directory through the engine's own reader.
// The product's nightly runs, for a model diagnosing the engine: a page of runs, or a page of one
// run's trends with their score components, gates and evidence titles. Only this environment's
// runs directory, only run ids (never paths), and never a cutoff of the frozen evaluation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isSealedCutoff } from "@earlyscript/engine-lab/policy";
import { readRun } from "@earlyscript/trend-engine/check";
import * as Effect from "effect/Effect";

import { labFailure } from "./engineLabSupport.ts";
import { EditorialRunDirectory } from "./RunDirectory.ts";

const RUN_ID = /^run_[A-Za-z0-9_]+$/;
const PRODUCT_PAGE_MAX = 10;

const pageOf = (cursor: number | undefined, limit: number | undefined) => {
  const offset = Math.max(0, Math.trunc(cursor ?? 0));
  const size = Math.min(PRODUCT_PAGE_MAX, Math.max(1, Math.trunc(limit ?? PRODUCT_PAGE_MAX)));
  return { offset, size };
};

/** The runs of the product, newest cutoff first; sealed cutoffs are not listed. */
export const productRuns = Effect.fn("EngineProductRuns.list")(function* (input: {
  readonly cursor?: number | undefined;
  readonly limit?: number | undefined;
}) {
  const { runsDir } = yield* EditorialRunDirectory;
  const { offset, size } = pageOf(input.cursor, input.limit);
  const names = NodeFS.existsSync(runsDir)
    ? NodeFS.readdirSync(runsDir).filter((name) => RUN_ID.test(name))
    : [];
  const runs = names
    .flatMap((name) => {
      try {
        const { record } = readRun(NodePath.join(runsDir, name));
        if (isSealedCutoff(record.cutoff_at)) return [];
        return [
          {
            runId: record.run_id,
            cutoffAt: record.cutoff_at,
            status: record.status,
            configHash: record.config_hash,
            profileHash: record.profile?.hash ?? null,
            logicalHash: record.logical_hash,
            dossiers: record.files.length,
          },
        ];
      } catch {
        return [];
      }
    })
    .toSorted((a, b) =>
      a.cutoffAt < b.cutoffAt ? 1 : a.cutoffAt > b.cutoffAt ? -1 : a.runId < b.runId ? 1 : -1,
    );
  const page = runs.slice(offset, offset + size);
  return {
    total: runs.length,
    cursor: offset,
    next: offset + size < runs.length ? offset + size : null,
    runs: page,
  };
});

/** One product run's trends, by rank, a page at a time. */
export const productRun = Effect.fn("EngineProductRuns.read")(function* (input: {
  readonly runId: string;
  readonly cursor?: number | undefined;
  readonly limit?: number | undefined;
}) {
  if (!RUN_ID.test(input.runId))
    return yield* labFailure("invalid-change", `${input.runId} is not a run id.`);
  const { runsDir } = yield* EditorialRunDirectory;
  const dir = NodePath.join(runsDir, input.runId);
  if (!NodeFS.existsSync(NodePath.join(dir, "run.json"))) {
    return yield* labFailure("not-found", `No product run ${input.runId}.`);
  }
  const read = yield* Effect.try({
    try: () => readRun(dir),
    catch: () => labFailure("artifact-mismatch", `Product run ${input.runId} does not decode.`),
  });
  if (isSealedCutoff(read.record.cutoff_at)) {
    return yield* labFailure(
      "sealed-partition",
      `${input.runId} is a cutoff of the frozen evaluation.`,
    );
  }
  const { offset, size } = pageOf(input.cursor, input.limit);
  const ranked = read.dossiers.toSorted(
    (a, b) => a.rankings.weighted.position - b.rankings.weighted.position,
  );
  return {
    runId: read.record.run_id,
    cutoffAt: read.record.cutoff_at,
    configHash: read.record.config_hash,
    // The engine's own counts of what each gate let through; per-trend exclusions are not recorded.
    stats: read.record.stats ?? null,
    total: ranked.length,
    cursor: offset,
    next: offset + size < ranked.length ? offset + size : null,
    trends: ranked.slice(offset, offset + size).map((dossier) => ({
      position: dossier.rankings.weighted.position,
      trendId: dossier.trend.id,
      label: dossier.trend.label,
      stage: dossier.trend.stage,
      score: dossier.rankings.weighted.score,
      components: dossier.rankings.weighted.components,
      baselinePosition: dossier.rankings.baseline.position,
      itemsLast7Days: dossier.trend.items_7d,
      itemsPrevious7Days: dossier.trend.items_prev_7d,
      growth: dossier.trend.growth,
      profileFit: dossier.profile_fit,
      relevance: dossier.relevance?.score ?? null,
      evidence: dossier.evidence.slice(0, 3).map((item) => ({
        title: item.title,
        source: item.source,
        publishedAt: item.published_at,
      })),
    })),
  };
});
