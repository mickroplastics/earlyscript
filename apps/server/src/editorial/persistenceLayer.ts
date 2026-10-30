import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EditorialCommandService from "./EditorialCommandService.ts";
import * as ManualThreadPolicy from "./ManualThreadPolicy.ts";
import * as WorkClockService from "./WorkClockService.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";
import * as EditorialEventLog from "./persistence/EditorialEventLog.ts";

// Segments left open by a previous process are flagged for the operator
// before any client can reach the clock.
const layerRecoverOpenIntervals = Layer.effectDiscard(
  Effect.gen(function* () {
    const clock = yield* WorkClockService.WorkClockService;
    const recovered = yield* clock.recoverOpenIntervals();
    if (recovered.length > 0) {
      yield* Effect.logWarning("Editorial work intervals need resolution after restart").pipe(
        Effect.annotateLogs({ intervals: recovered.map((interval) => interval.intervalId) }),
      );
    }
  }),
);

/**
 * Editorial storage over `editorial.sqlite`; publishes `EditorialSql`, never the
 * global `SqlClient`. Must sit below the orchestration layers, which read
 * `ManualThreadPolicy` from it; thread launchers live in `videoThreadLayer.ts`.
 */
export const layerFromDatabase = <E, R>(
  database: Layer.Layer<EditorialDatabase.EditorialSql, E, R>,
) =>
  layerRecoverOpenIntervals.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        EditorialCommandService.layer,
        WorkClockService.layer,
        ManualThreadPolicy.layer,
      ),
    ),
    Layer.provideMerge(EditorialEventLog.layer),
    Layer.provideMerge(database),
  );

export const layer = layerFromDatabase(EditorialDatabase.layerConfig);
