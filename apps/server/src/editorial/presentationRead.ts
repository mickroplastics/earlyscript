import type { EditorialTrendPresentation, EditorialTrendSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { EditorialReadServiceShape } from "./EditorialReadService.ts";

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

/** Latest ready presentation of each dossier of the run, by dossier id. */
export const readyPresentations = (sql: SqlClient.SqlClient, runId: string) =>
  sql<PresentationRow>`
    SELECT ${sql.literal(PRESENTATION_COLUMNS)} FROM editorial_presentations
    WHERE run_id = ${runId} AND status = 'ready'
    ORDER BY revision ASC
  `.pipe(
    Effect.map((rows) => {
      // The highest ready revision of each dossier wins.
      const byDossier = new Map<string, EditorialTrendPresentation>();
      for (const row of rows) {
        const presentation = presentationOfRow(row);
        if (presentation !== null) byDossier.set(row.dossier_id, presentation);
      }
      return byDossier as ReadonlyMap<string, EditorialTrendPresentation>;
    }),
    // A storage failure must not hide the inbox: the engine's terms are shown instead.
    Effect.catch((cause) =>
      Effect.logWarning("editorial: cannot read trend presentations", { runId, cause }).pipe(
        Effect.as(NO_PRESENTATIONS),
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
 * Fills `presentation` in the inbox and dossier reads when a ready one exists. Reads the
 * table with the read service's own client, so the read side never depends on generation.
 */
export function withPresentations(
  sql: SqlClient.SqlClient,
  read: EditorialReadServiceShape,
): EditorialReadServiceShape {
  return {
    ...read,
    getInbox: (input) =>
      read.getInbox(input).pipe(
        Effect.flatMap((inbox) =>
          (inbox.run === null
            ? Effect.succeed(NO_PRESENTATIONS)
            : readyPresentations(sql, inbox.run.runId)
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
          readyPresentations(sql, dossier.run.runId).pipe(
            Effect.map((presentations) => ({
              ...dossier,
              trend: attach(dossier.trend, presentations),
            })),
          ),
        ),
      ),
  };
}
