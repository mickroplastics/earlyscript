import type { EditorialTrendPresentation, EditorialTrendSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EditorialReadServiceShape } from "./EditorialReadService.ts";

export interface EditorialPresentationReaderShape {
  /** Latest ready presentation of each dossier of the run, by dossier id. */
  readonly readyPresentations: (
    runId: string,
  ) => Effect.Effect<ReadonlyMap<string, EditorialTrendPresentation>>;
}

/**
 * Read side of the assistant's presentations. Kept apart from the service that generates
 * them, so readers (inbox, dossier, MCP) never depend on text generation.
 */
export class EditorialPresentationReader extends Context.Service<
  EditorialPresentationReader,
  EditorialPresentationReaderShape
>()("t3/editorial/presentationRead/EditorialPresentationReader") {}

const NO_PRESENTATIONS: ReadonlyMap<string, EditorialTrendPresentation> = new Map();

const attach = (
  trend: EditorialTrendSummary,
  presentations: ReadonlyMap<string, EditorialTrendPresentation>,
): EditorialTrendSummary => {
  const presentation = presentations.get(trend.dossierId);
  return presentation === undefined ? trend : { ...trend, presentation };
};

/**
 * Fills `presentation` in the inbox and dossier reads when a ready one exists. Without the
 * reader in context (tests, servers without the editorial database) the reads are returned
 * unchanged, so the read service gains no requirement.
 */
export const withPresentations = Effect.fn("EditorialPresentationReader.withPresentations")(
  function* (read: EditorialReadServiceShape) {
    const reader = yield* Effect.serviceOption(EditorialPresentationReader);
    if (Option.isNone(reader)) return read;
    const { readyPresentations } = reader.value;
    return {
      ...read,
      getInbox: (input) =>
        read.getInbox(input).pipe(
          Effect.flatMap((inbox) =>
            (inbox.run === null
              ? Effect.succeed(NO_PRESENTATIONS)
              : readyPresentations(inbox.run.runId)
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
            readyPresentations(dossier.run.runId).pipe(
              Effect.map((presentations) => ({
                ...dossier,
                trend: attach(dossier.trend, presentations),
              })),
            ),
          ),
        ),
    } satisfies EditorialReadServiceShape;
  },
);
