import type { EditorialTrendPresentation, EditorialTrendSummary } from "@t3tools/contracts";
import { hashTrendPresentationInput } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { EditorialReadServiceShape } from "./EditorialReadService.ts";
import { loadPresentationDossiers, type PresentationDossier } from "./presentationDossierSource.ts";
import { trendPresentationVoiceProblems, VOICE_TITLE_PART } from "./presentationVoice.ts";
import type { EditorialRunDirectoryShape } from "./RunDirectory.ts";

/** A row of `editorial_presentations` (migration 005). */
export interface PresentationRow {
  readonly presentation_id: string;
  readonly run_id: string;
  readonly dossier_id: string;
  readonly input_hash: string;
  readonly revision: number;
  readonly prompt_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly title: string | null;
  readonly what_happened: string | null;
  readonly why_it_matters: string | null;
  readonly video_angle: string | null;
  readonly cited_item_ids_json: string;
  readonly warnings_json: string;
  readonly generated_at: string | null;
  readonly status: "pending" | "ready" | "failed";
}

export const PRESENTATION_COLUMNS = `
  presentation_id, run_id, dossier_id, input_hash, revision, prompt_version, provider, model,
  title, what_happened, why_it_matters, video_angle, cited_item_ids_json, warnings_json,
  generated_at, status
`;

const StringListJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStrings = Schema.decodeUnknownOption(StringListJson);
export const encodeStrings = Schema.encodeSync(StringListJson);

export const parseStrings = (json: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeStrings(json), () => []);

/** A ready row as the contract shows it; `null` for anything else. */
export function presentationOfRow(row: PresentationRow): EditorialTrendPresentation | null {
  if (
    row.status !== "ready" ||
    row.title === null ||
    row.what_happened === null ||
    row.why_it_matters === null ||
    row.video_angle === null ||
    row.provider === null ||
    row.model === null ||
    row.prompt_version === null ||
    row.generated_at === null
  ) {
    return null;
  }
  return {
    title: row.title,
    summary: {
      whatHappened: row.what_happened,
      whyItMatters: row.why_it_matters,
      videoAngle: row.video_angle,
    },
    citedItemIds: parseStrings(row.cited_item_ids_json),
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    generatedAt: row.generated_at,
  };
}

const NO_PRESENTATIONS: ReadonlyMap<string, EditorialTrendPresentation> = new Map();

type VoiceChecked = Pick<EditorialTrendPresentation, "title" | "summary">;

/**
 * A stored text that `ensure` may reuse and the run's progress counts as drafted: it passes
 * today's voice check. The read side marks the others `outdated`, so all three agree.
 */
export const passesVoice = (presentation: VoiceChecked, dossier: PresentationDossier) =>
  trendPresentationVoiceProblems(presentation, dossier.input.evidence).length === 0;

/**
 * `outdated`: written with another prompt version, or failing today's voice check. Hashing
 * the current input with the row's version gives the current hash only when that version is
 * the current one. `titleRejected`: the title itself fails, so no surface shows it.
 */
function review(presentation: EditorialTrendPresentation, dossier: PresentationDossier) {
  const problems = trendPresentationVoiceProblems(presentation, dossier.input.evidence);
  return {
    outdated:
      problems.length > 0 ||
      hashTrendPresentationInput(dossier.input, presentation.promptVersion) !== dossier.inputHash,
    titleRejected: problems.some((problem) => problem.part === VOICE_TITLE_PART),
  };
}

/**
 * Each dossier's latest ready presentation: `current` when written for its current input,
 * `stale` for an earlier input (shown until regenerated), `outdated` for another prompt
 * version or a failed voice check (kept, never drawn as the story).
 */
export const presentationsForRun = Effect.fn("EditorialPresentationRead.presentationsForRun")(
  function* (sql: SqlClient.SqlClient, directory: EditorialRunDirectoryShape, runId: string) {
    const dossiers = yield* loadPresentationDossiers(directory, sql, runId);
    const byId = new Map(dossiers.map((dossier) => [dossier.dossierId, dossier]));
    const rows = yield* sql<PresentationRow>`
      SELECT ${sql.literal(PRESENTATION_COLUMNS)} FROM editorial_presentations
      WHERE run_id = ${runId} AND status = 'ready'
      ORDER BY revision ASC
    `;
    const current = new Map<string, EditorialTrendPresentation>();
    const latest = new Map<string, EditorialTrendPresentation>();
    for (const row of rows) {
      const presentation = presentationOfRow(row);
      if (presentation === null) continue;
      latest.set(row.dossier_id, presentation);
      if (byId.get(row.dossier_id)?.inputHash === row.input_hash) {
        current.set(row.dossier_id, presentation);
      }
    }
    const shown = new Map<string, EditorialTrendPresentation>();
    for (const [dossierId, presentation] of latest) {
      const own = current.get(dossierId);
      const dossier = byId.get(dossierId);
      const candidate = own ?? presentation;
      const checked = dossier === undefined ? null : review(candidate, dossier);
      shown.set(dossierId, {
        ...candidate,
        status: checked?.outdated ? "outdated" : own === undefined ? "stale" : "current",
        ...(checked?.titleRejected ? { titleRejected: true } : {}),
      });
    }
    return shown as ReadonlyMap<string, EditorialTrendPresentation>;
  },
  // A storage or directory failure must not hide the inbox: the engine's terms are shown.
  (effect, _sql, _directory, runId) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("editorial: cannot read trend presentations", { runId, cause }).pipe(
          Effect.as(NO_PRESENTATIONS),
        ),
      ),
    ),
);

const attach = <T extends EditorialTrendSummary>(
  trend: T,
  presentations: ReadonlyMap<string, EditorialTrendPresentation>,
): T => {
  const presentation = presentations.get(trend.dossierId);
  return presentation === undefined ? trend : { ...trend, presentation };
};

/**
 * Fills `presentation` in the inbox and dossier reads, with its `status` against the input
 * the dossier has now. Uses the read service's own client and run directory, so the read
 * side never depends on generation.
 */
export function withPresentations(
  sql: SqlClient.SqlClient,
  directory: EditorialRunDirectoryShape,
  read: EditorialReadServiceShape,
): EditorialReadServiceShape {
  return {
    ...read,
    getInbox: (input) =>
      read.getInbox(input).pipe(
        Effect.flatMap((inbox) =>
          (inbox.run === null
            ? Effect.succeed(NO_PRESENTATIONS)
            : presentationsForRun(sql, directory, inbox.run.runId)
          ).pipe(
            Effect.map((presentations) => ({
              ...inbox,
              trends: inbox.trends.map((trend) => attach(trend, presentations)),
            })),
          ),
        ),
      ),
    getDossier: (input) =>
      read.getDossier(input).pipe(
        Effect.flatMap((dossier) =>
          presentationsForRun(sql, directory, dossier.run.runId).pipe(
            Effect.map((presentations) => ({
              ...dossier,
              trend: attach(dossier.trend, presentations),
            })),
          ),
        ),
      ),
  };
}
