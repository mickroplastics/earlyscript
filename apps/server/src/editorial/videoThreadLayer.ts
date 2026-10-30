import * as Layer from "effect/Layer";

import * as EditorialThreadService from "./EditorialThreadService.ts";
import * as ScriptVersionService from "./ScriptVersionService.ts";

/**
 * Video thread services. They launch and read T3 threads, so `server.ts`
 * mounts them above the orchestration layers; the storage they write comes
 * from `persistenceLayer.ts`, below.
 */
export const layer = ScriptVersionService.layer.pipe(
  Layer.provideMerge(EditorialThreadService.layer),
);
