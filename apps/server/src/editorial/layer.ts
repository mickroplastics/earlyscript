import * as Layer from "effect/Layer";

import * as EditorialImportService from "./EditorialImportService.ts";
import * as EditorialInboxCommands from "./EditorialInboxCommands.ts";
import * as EditorialReadService from "./EditorialReadService.ts";
import * as EditorialRpc from "./rpc.ts";
import * as RunDirectory from "./RunDirectory.ts";

/**
 * The editorial read side, importer and RPC handlers over a run directory. Needs the storage
 * services of `persistenceLayer.ts` (EditorialSql, EditorialEventLog, EditorialCommandService),
 * which `server.ts` mounts below it.
 */
export const layerFromRunDirectory = <E, R>(
  runDirectory: Layer.Layer<RunDirectory.EditorialRunDirectory, E, R>,
  options: { readonly watch?: boolean } = {},
) =>
  (options.watch === false
    ? EditorialRpc.layerHandlers
    : Layer.merge(EditorialRpc.layerHandlers, EditorialImportService.layerWatch)
  ).pipe(
    Layer.provideMerge(EditorialInboxCommands.layer),
    Layer.provideMerge(Layer.merge(EditorialReadService.layer, EditorialImportService.layer)),
    Layer.provideMerge(runDirectory),
  );

/**
 * Mounted once in `server.ts`: every WebSocket connection and the MCP readers share the same
 * services and the same directory cache. `ws.ts` only binds the handlers to the session.
 */
export const layer = layerFromRunDirectory(RunDirectory.layer);
