import {
  EDITORIAL_PROFILE_WS_METHODS,
  EditorialProfileError,
  type EditorialEngineParameter,
  type EditorialEngineScoring,
  type EditorialProfileRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as EditorialProfileService from "./EditorialProfileService.ts";
import { resolveEngineLocation } from "./engineProcess.ts";

/** Trace and metric aggregate of each Profile method, merged into `RpcInstrumentation`. */
export const EDITORIAL_PROFILE_RPC_AGGREGATES = {
  [EDITORIAL_PROFILE_WS_METHODS.get]: "editorial",
  [EDITORIAL_PROFILE_WS_METHODS.history]: "editorial",
  [EDITORIAL_PROFILE_WS_METHODS.update]: "editorial",
} as const;

type ProfileRpcs = RpcGroup.Rpcs<typeof EditorialProfileRpcGroup>;

export type EditorialProfileHandlers = {
  readonly [Current in ProfileRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const unavailable = new EditorialProfileError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});

/** Spread into the WebSocket group in `ws.ts`; a Reference, as in `sourcesRpc.ts`. */
export class EditorialProfileRpcHandlers extends Context.Reference<EditorialProfileHandlers>(
  "t3/editorial/EditorialProfileRpcHandlers",
  {
    defaultValue: () => ({
      [EDITORIAL_PROFILE_WS_METHODS.get]: () => Effect.fail(unavailable),
      [EDITORIAL_PROFILE_WS_METHODS.history]: () => Effect.fail(unavailable),
      [EDITORIAL_PROFILE_WS_METHODS.update]: () => Effect.fail(unavailable),
    }),
  },
) {}

/** Single-valued parameters of the engine configuration that filter or weigh a trend. */
const SCORING_PATHS = [
  "profile.include_min",
  "profile.exclude_max",
  "cluster.threshold",
  "stage.growth_min",
  "stage.fading_max",
  "stage.growing_min_items_7d",
] as const;
/** Every weight of the ranking method is listed, whatever its components. */
const WEIGHTS_PATH = "rank.weighted.weights";
const LIMIT_PATHS = ["emit.max_dossiers"] as const;

const at = (value: unknown, dotted: string): unknown =>
  dotted
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );

/** The named scoring parameters of an engine configuration, in a fixed reading order. */
export function engineScoringOf(config: unknown): EditorialEngineScoring | null {
  const version = at(config, "config_version");
  if (typeof version !== "string") return null;
  const parameters: Array<EditorialEngineParameter> = [];
  const push = (key: string, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) parameters.push({ key, value });
  };
  for (const key of SCORING_PATHS) push(key, at(config, key));
  const weights = at(config, WEIGHTS_PATH);
  if (typeof weights === "object" && weights !== null) {
    for (const [name, value] of Object.entries(weights)) push(`${WEIGHTS_PATH}.${name}`, value);
  }
  for (const key of LIMIT_PATHS) push(key, at(config, key));
  return { configVersion: version, parameters };
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const makeHandlers = Effect.gen(function* () {
  const profiles = yield* EditorialProfileService.EditorialProfileService;
  const fs = yield* FileSystem.FileSystem;
  const configFile = yield* resolveEngineLocation.pipe(
    Effect.map((location) => location.defaultConfig),
    Effect.orElseSucceed(() => null),
  );
  // The default configuration the nightly run starts from; null when no engine is installed.
  const scoring =
    configFile === null
      ? Effect.succeed(null)
      : fs.readFileString(configFile).pipe(
          Effect.map((text) => Option.getOrNull(Option.map(decodeJson(text), engineScoringOf))),
          Effect.orElseSucceed(() => null),
        );
  return {
    [EDITORIAL_PROFILE_WS_METHODS.get]: () => Effect.all({ active: profiles.get, scoring }),
    [EDITORIAL_PROFILE_WS_METHODS.history]: () => profiles.history,
    [EDITORIAL_PROFILE_WS_METHODS.update]: profiles.update,
  } satisfies EditorialProfileHandlers;
});

/**
 * Mounted once in `server.ts`; publishes the service too, for the nightly run, which writes the
 * active profile for the engine.
 */
export const layer = Layer.effect(EditorialProfileRpcHandlers, makeHandlers).pipe(
  Layer.provideMerge(EditorialProfileService.layer),
);
