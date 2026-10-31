import { EditorialPresentationError } from "@t3tools/contracts";
import {
  hashTrendPresentationInput,
  type TrendPresentationGenerationInput,
} from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import { currentPresentationProfile } from "./channelProfile.ts";
import type { EditorialRunDirectoryShape, IndexedDossier } from "./RunDirectory.ts";

/** What the model reads: the generation input without where and with which model it runs. */
type TrendPresentationPromptInput = Omit<
  TrendPresentationGenerationInput,
  "cwd" | "modelSelection"
>;

/** Evidence items sent to the assistant, in the engine's selection order. */
const PRESENTATION_EVIDENCE_LIMIT = 12;

/**
 * One dossier as the assistant reads it, with the identity of that input. Reads and
 * generation both build it here, so a stored presentation is current exactly when its
 * `input_hash` equals `inputHash`.
 */
export interface PresentationDossier {
  readonly runId: string;
  readonly dossierId: string;
  /** The inbox's trend identity (`trendKey.ts`): `signal.id`, else a hash of the terms. */
  readonly trendKey: string;
  readonly input: TrendPresentationPromptInput;
  /** Profile, engine data, evidence, language and prompt version; not the model or cwd. */
  readonly inputHash: string;
}

function presentationDossierOf(
  runId: string,
  dossier: IndexedDossier,
  profile: TrendPresentationPromptInput["profile"],
): PresentationDossier {
  const excerpts = new Map(
    (dossier.file.evidence ?? []).map((item) => [item.item_id, item.excerpt ?? ""]),
  );
  const { summary } = dossier;
  const input: TrendPresentationPromptInput = {
    profile,
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
  return {
    runId,
    dossierId: summary.dossierId,
    trendKey: dossier.trendKey.key,
    input,
    inputHash: hashTrendPresentationInput(input),
  };
}

/**
 * Every dossier of the run with its current input identity, from the shared run directory:
 * same cache, ranks, coverage, link validation and trend keys as the inbox.
 */
export const loadPresentationDossiers = Effect.fn("loadPresentationDossiers")(function* (
  directory: EditorialRunDirectoryShape,
  sql: SqlClient.SqlClient,
  runId: string,
) {
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
  const profile = yield* currentPresentationProfile(sql);
  return loaded.dossiers.map((dossier) => presentationDossierOf(runId, dossier, profile));
});
