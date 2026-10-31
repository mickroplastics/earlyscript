import * as Layer from "effect/Layer";

import * as EditorialVideoThreads from "./videoThreadLayer.ts";

/**
 * The editorial mount of `server.ts` (docs/upstream-divergence.md §10): storage, with
 * `ManualThreadPolicy`, below the orchestration runtime that requires it; the
 * video thread services, which launch T3 threads, above it.
 */
export const aroundOrchestration = <ROut, E, RIn, SOut, SE, SRIn>(
  orchestration: Layer.Layer<ROut, E, RIn>,
  storage: Layer.Layer<SOut, SE, SRIn>,
) =>
  EditorialVideoThreads.layer.pipe(Layer.provideMerge(orchestration), Layer.provideMerge(storage));
