import * as EditorialReadService from "./EditorialReadService.ts";

/** Every editorial service the server mounts, provided once in `server.ts`. */
export const layer = EditorialReadService.layer;
