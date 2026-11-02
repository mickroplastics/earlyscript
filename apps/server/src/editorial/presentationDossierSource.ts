import {
  EditorialPresentationError,
  PRESENTATION_EVIDENCE_LIMIT,
  PRESENTATION_EXCERPT_CHARS,
} from "@t3tools/contracts";
import {
  hashTrendPresentationInput,
  type TrendPresentationGenerationInput,
} from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import { currentPresentationProfile } from "./EditorialProfileService.ts";
import type { EditorialRunDirectoryShape, IndexedDossier } from "./RunDirectory.ts";

/** What the model reads: the generation input without where and with which model it runs. */
type TrendPresentationPromptInput = Omit<
  TrendPresentationGenerationInput,
  "cwd" | "modelSelection"
>;

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
    // The output boundary: at most PRESENTATION_EVIDENCE_LIMIT items, each excerpt cut to
    // PRESENTATION_EXCERPT_CHARS whatever the run stored (the first-run step promises both).
    evidence: dossier.evidence.slice(0, PRESENTATION_EVIDENCE_LIMIT).map((item) => ({
      itemId: item.itemId,
      source: item.source,
      title: item.title,
      excerpt: cutExcerpt(item.excerpt),
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
  const profile = yield* currentPresentationProfile(sql).pipe(
    Effect.mapError(
      (cause) =>
        new EditorialPresentationError({ reason: "storage-failed", message: cause.message }),
    ),
  );
  return loaded.dossiers.map((dossier) => presentationDossierOf(runId, dossier, profile));
});

/**
 * Cuts an excerpt to PRESENTATION_EXCERPT_CHARS Unicode code points, never splitting a
 * surrogate pair: a String.prototype.slice on UTF-16 units could leave a lone high surrogate
 * and hand the provider malformed text.
 */
function cutExcerpt(excerpt: string): string {
  if (excerpt.length <= PRESENTATION_EXCERPT_CHARS) return excerpt;
  return Array.from(excerpt).slice(0, PRESENTATION_EXCERPT_CHARS).join("");
}
