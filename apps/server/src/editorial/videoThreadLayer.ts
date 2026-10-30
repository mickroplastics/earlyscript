import * as EditorialThreadService from "./EditorialThreadService.ts";

/**
 * Video thread services. They launch T3 threads, so `server.ts` mounts them
 * above the orchestration layers; their storage comes from
 * `persistenceLayer.ts`, below.
 */
export const layer = EditorialThreadService.layer;
