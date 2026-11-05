import * as Layer from "effect/Layer";

import * as EngineChangeService from "./EngineChangeService.ts";
import * as EngineExperimentService from "./EngineExperimentService.ts";
import * as EnginePromotionService from "./EnginePromotionService.ts";
import * as EngineLabSupport from "./engineLabSupport.ts";

/**
 * The engine lab's services and its background runner, mounted once in `server.ts` above the
 * sources and profile services it reads. The nightly run reads the active engine from the
 * same EnginePromotionService.
 */
export const layer = Layer.merge(
  EngineChangeService.layer,
  EngineExperimentService.layerRunner.pipe(Layer.provideMerge(EngineExperimentService.layer)),
).pipe(
  Layer.provideMerge(EnginePromotionService.layer),
  Layer.provideMerge(EngineLabSupport.layerOptions),
);
