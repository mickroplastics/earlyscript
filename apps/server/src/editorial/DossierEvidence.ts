import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export interface DossierReference {
  readonly runId: string | null;
  readonly dossierId: string;
  readonly dossierHash: string | null;
}

/**
 * The dossier JSON attached to a video thread, as `checkScript` reads it
 * (`evidence[].item_id`). The default knows no dossier, so script_check
 * reports the dossier as unavailable instead of guessing a file. The read side
 * (EditorialReadService, which owns the run directory) provides the lookup.
 */
export class DossierEvidence extends Context.Reference<{
  readonly load: (reference: DossierReference) => Effect.Effect<Option.Option<unknown>>;
}>("t3/editorial/DossierEvidence", {
  defaultValue: () => ({ load: () => Effect.succeedNone }),
}) {}
