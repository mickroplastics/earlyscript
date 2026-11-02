import * as Layer from "effect/Layer";

import * as EditorialThreadService from "./EditorialThreadService.ts";
import * as ManualThreadLauncher from "./ManualThreadLauncher.ts";
import * as ScriptVersionService from "./ScriptVersionService.ts";
import * as VideoProject from "./VideoProject.ts";
import * as VideoWorkspace from "./VideoWorkspace.ts";

/**
 * Video thread services. They launch and read T3 threads, so `server.ts`
 * mounts them above the orchestration layers; the storage they write comes
 * from `persistenceLayer.ts`, below.
 */
export const layer = Layer.merge(ScriptVersionService.layer, VideoWorkspace.layer).pipe(
  Layer.provideMerge(
    EditorialThreadService.layer.pipe(
      Layer.provide(ManualThreadLauncher.layer),
      // Also mounted for `videoRpc.ts`, which restores the studio's instructions on open.
      Layer.provideMerge(VideoProject.layer),
    ),
  ),
);
