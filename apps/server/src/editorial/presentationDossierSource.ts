import { EditorialPresentationError } from "@t3tools/contracts";
import type {
  TrendPresentationEvidence,
  TrendPresentationTrend,
} from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { EditorialRunDirectory, type IndexedDossier } from "./RunDirectory.ts";

/** Evidence items sent to the assistant, in the engine's selection order. */
const PRESENTATION_EVIDENCE_LIMIT = 12;

/** What the assistant reads about one dossier: deterministic engine data and its evidence. */
export interface PresentationDossier {
  readonly runId: string;
  readonly dossierId: string;
  /** The inbox's trend identity (`trendKey.ts`): `signal.id`, else a hash of the terms. */
  readonly trendKey: string;
  readonly trend: TrendPresentationTrend;
  readonly evidence: ReadonlyArray<TrendPresentationEvidence>;
}

export interface PresentationDossierSourceShape {
  /** Every dossier of the run, in file order. */
  readonly loadRun: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<PresentationDossier>, EditorialPresentationError>;
}

/**
 * Dossiers as the presentation service needs them, from the shared run directory: same
 * cache, ranks, coverage, link validation and trend keys as the inbox.
 */
export class PresentationDossierSource extends Context.Service<
  PresentationDossierSource,
  PresentationDossierSourceShape
>()("t3/editorial/presentationDossierSource") {}

function toPresentationDossier(runId: string, dossier: IndexedDossier): PresentationDossier {
  const excerpts = new Map(
    (dossier.file.evidence ?? []).map((item) => [item.item_id, item.excerpt ?? ""]),
  );
  const { summary } = dossier;
  return {
    runId,
    dossierId: summary.dossierId,
    trendKey: dossier.trendKey.key,
    trend: {
      id: dossier.trendKey.key,
      terms: summary.terms,
      items7d: summary.items7d,
      authors7d: summary.authors7d,
      // A dossier without the component reads as flat growth and no affinity, not as missing.
      growth: summary.growth ?? 0,
      affinity: summary.affinity ?? 0,
      volumeRank: summary.volumeRank,
      scoreRank: summary.scoreRank,
      sourceCount: summary.sourceCount,
      coverage: dossier.coverage.map((entry) => ({
        source: entry.source,
        daysComplete: entry.daysComplete,
        daysPartial: entry.daysPartial,
        daysUnavailable: entry.daysUnavailable,
      })),
    },
    evidence: dossier.evidence.slice(0, PRESENTATION_EVIDENCE_LIMIT).map((item) => ({
      itemId: item.itemId,
      source: item.source,
      title: item.title,
      excerpt: excerpts.get(item.itemId) ?? "",
      publishedAt: item.publishedAt,
      url: item.externalUrl ?? item.permalink ?? "",
    })),
  };
}

const make = Effect.gen(function* () {
  const directory = yield* EditorialRunDirectory;

  const loadRun: PresentationDossierSourceShape["loadRun"] = Effect.fn(
    "PresentationDossierSource.loadRun",
  )(function* (runId) {
    const entry = yield* directory
      .find(runId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new EditorialPresentationError({ reason: "run-not-found", message: cause.message }),
        ),
      );
    if (Option.isNone(entry)) {
      return yield* new EditorialPresentationError({
        reason: "run-not-found",
        message: `Run ${runId} is not in the runs directory.`,
      });
    }
    const loaded = yield* directory.load(entry.value);
    return loaded.dossiers.map((dossier) => toPresentationDossier(runId, dossier));
  });

  return PresentationDossierSource.of({ loadRun });
});

export const layer = Layer.effect(PresentationDossierSource, make);
