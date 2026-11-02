import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

// Earlyscript's local embedding model (Qwen3-Embedding-0.6B, pinned by the trend engine):
// what is on disk and the download the operator starts from the app, with its progress.

export const EDITORIAL_ENGINE_WS_METHODS = {
  modelStatus: "editorial.engine.modelStatus",
  prepareModel: "editorial.engine.prepareModel",
  watchModel: "editorial.engine.watchModel",
} as const;

/** `unknown` until the engine has reported once, or when it could not run. */
export const EditorialModelDiskStatus = Schema.Literals(["ready", "missing", "partial", "unknown"]);
export type EditorialModelDiskStatus = typeof EditorialModelDiskStatus.Type;

/** Why the last download or status check failed; the client words it. */
export const EditorialModelErrorCode = Schema.Literals([
  "network",
  "http",
  "hash",
  "disk",
  "other",
  "engine_missing",
  "engine_failed",
]);
export type EditorialModelErrorCode = typeof EditorialModelErrorCode.Type;

export const EditorialModelError = Schema.Struct({
  code: EditorialModelErrorCode,
  /** Technical detail in English, for diagnosis. */
  message: Schema.String,
});
export type EditorialModelError = typeof EditorialModelError.Type;

/** A download in flight. Bytes count the whole model, finished files included. */
export const EditorialModelDownload = Schema.Struct({
  startedAt: IsoDateTime,
  file: Schema.NullOr(Schema.String),
  bytesDone: NonNegativeInt,
  bytesTotal: NonNegativeInt,
  /** Over the last seconds; null until two samples exist. */
  bytesPerSecond: Schema.NullOr(Schema.Number),
});
export type EditorialModelDownload = typeof EditorialModelDownload.Type;

export const EditorialModelState = Schema.Struct({
  status: EditorialModelDiskStatus,
  revision: Schema.NullOr(Schema.String),
  /** The revision directory the nightly run reads. */
  path: Schema.NullOr(Schema.String),
  /** Its parent, with the server's home written `~`, for display. */
  location: Schema.NullOr(Schema.String),
  bytesPresent: NonNegativeInt,
  bytesExpected: NonNegativeInt,
  download: Schema.NullOr(EditorialModelDownload),
  /** The last failure; a new download clears it. */
  error: Schema.NullOr(EditorialModelError),
});
export type EditorialModelState = typeof EditorialModelState.Type;

export class EditorialEngineError extends Schema.TaggedError<EditorialEngineError>()(
  "EditorialEngineError",
  {
    reason: Schema.Literals(["unavailable"]),
    message: Schema.String,
  },
) {}

const engineError = Schema.Union([EditorialEngineError, EnvironmentAuthorizationError]);

/** Reads the model directory again, unless a download is in flight. */
const EditorialEngineModelStatusRpc = Rpc.make(EDITORIAL_ENGINE_WS_METHODS.modelStatus, {
  payload: Schema.Struct({}),
  success: EditorialModelState,
  error: engineError,
});

/** Starts the download; a second call while one runs answers its state and starts nothing. */
const EditorialEnginePrepareModelRpc = Rpc.make(EDITORIAL_ENGINE_WS_METHODS.prepareModel, {
  payload: Schema.Struct({}),
  success: EditorialModelState,
  error: engineError,
});

/** The state now, then on every change: progress, the end of a download, a failure. */
const EditorialEngineWatchModelRpc = Rpc.make(EDITORIAL_ENGINE_WS_METHODS.watchModel, {
  payload: Schema.Struct({}),
  success: EditorialModelState,
  error: engineError,
  stream: true,
});

/** Merged into `WsRpcGroup` next to the other editorial groups. */
export const EditorialEngineRpcGroup = RpcGroup.make(
  EditorialEngineModelStatusRpc,
  EditorialEnginePrepareModelRpc,
  EditorialEngineWatchModelRpc,
);

export const EDITORIAL_ENGINE_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_ENGINE_WS_METHODS.modelStatus]: AuthOrchestrationReadScope,
  [EDITORIAL_ENGINE_WS_METHODS.prepareModel]: AuthOrchestrationOperateScope,
  [EDITORIAL_ENGINE_WS_METHODS.watchModel]: AuthOrchestrationReadScope,
} as const;
