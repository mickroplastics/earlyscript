// @effect-diagnostics nodeBuiltinImport:off - the installed engine's sources are hashed from disk, as the worker does.
// What the three engine lab services share: where the engine and the lab worker are, how the
// operator configured the executors, and the manifest rows.
import * as NodeFS from "node:fs";

import {
  EngineLabFailure,
  type EngineLabErrorCode,
  type EngineManifestView,
} from "@earlyscript/editorial-contracts/engineLab";
import { engineSourceHash, sha256 } from "@earlyscript/engine-lab/hash";
import type { EngineManifest } from "@earlyscript/engine-lab/manifest";
import { LabPolicyError } from "@earlyscript/engine-lab/policy";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  resolveEngineLocation,
  type EngineLocation,
  type EngineNotFound,
} from "./engineProcess.ts";

export interface RemoteExecutor {
  /** An SSH alias of the operator's ~/.ssh/config: never a host a model names. */
  readonly alias: string;
  /** The executor's checkout, with packages/trend-engine and packages/engine-lab. */
  readonly root: string;
  readonly node: string;
  readonly jobsRoot: string;
}

export interface EngineLabOptionsShape {
  readonly engine: Result.Result<EngineLocation, EngineNotFound>;
  /** The checkout whose packages/engine-lab runs local jobs; null in the desktop bundle. */
  readonly engineRoot: string | null;
  readonly jobsRoot: string;
  /** Approved code candidates' engines, one directory per source hash, away from the live one. */
  readonly artifactsRoot: string;
  readonly remote: RemoteExecutor | null;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly maxTries: number;
  readonly pollMs: number;
  /** A whole job's wall time; past it its executor's process group is killed and it fails. */
  readonly jobTimeoutMs: number;
  /** Tests only: whether this machine's nightly has bwrap for approved code; detected otherwise. */
  readonly nightlySandbox?: "bwrap" | "unavailable";
}

export class EngineLabOptions extends Context.Service<EngineLabOptions, EngineLabOptionsShape>()(
  "t3/editorial/engineLabSupport/EngineLabOptions",
) {}

export const DEFAULT_LAB_TIMING = {
  leaseMs: 2 * 60_000,
  heartbeatMs: 30_000,
  maxTries: 3,
  pollMs: 15_000,
  jobTimeoutMs: 4 * 60 * 60_000,
} as const;

const REMOTE_ENV = "EARLYSCRIPT_ENGINE_LAB_REMOTE";

/** `packages/trend-engine/src/cli.ts` → the checkout root, when the engine is a workspace one. */
export const engineRootOf = (engine: EngineLocation): string | null => {
  const match = /^(.*)[\\/]packages[\\/]trend-engine[\\/]src[\\/]cli\.ts$/.exec(engine.cli);
  return match?.[1] ?? null;
};

/**
 * The operator's remote executor: `EARLYSCRIPT_ENGINE_LAB_REMOTE=<alias>:<root>:<node>:<jobs>`,
 * four absolute paths after the alias. Absent, only the local executor exists.
 */
export const parseRemote = (value: string): RemoteExecutor | null => {
  const [alias, root, node, jobsRoot, ...rest] = value.split(":");
  if (rest.length > 0 || !alias || !/^[A-Za-z0-9_.-]+$/.test(alias)) return null;
  if (![root, node, jobsRoot].every((p) => p !== undefined && p.startsWith("/"))) return null;
  return { alias, root: root!, node: node!, jobsRoot: jobsRoot! };
};

const resolveLabOptions = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const engine = yield* resolveEngineLocation.pipe(
    Effect.map(Result.succeed),
    Effect.catchTags({ EngineNotFound: (missing) => Effect.succeed(Result.fail(missing)) }),
  );
  const remote = yield* Config.String(REMOTE_ENV).pipe(Config.option);
  return {
    engine,
    engineRoot: Result.isSuccess(engine) ? engineRootOf(engine.success) : null,
    jobsRoot: path.join(stateDir, "editorial-engine-lab", "jobs"),
    artifactsRoot: path.join(stateDir, "editorial-engine-lab", "artifacts"),
    remote: Option.match(remote, { onNone: () => null, onSome: parseRemote }),
    ...DEFAULT_LAB_TIMING,
  } satisfies EngineLabOptionsShape;
});

export const layerOptions = Layer.effect(EngineLabOptions, resolveLabOptions.pipe(Effect.orDie));
export const layerOptionsWith = (options: EngineLabOptionsShape) =>
  Layer.succeed(EngineLabOptions, options);

export const labFailure = (code: EngineLabErrorCode, message: string) =>
  new EngineLabFailure({ code, message });

/** A policy refusal from the engine-lab package, as the MCP failure the model reads. */
export const fromPolicy = (error: unknown): EngineLabFailure =>
  error instanceof LabPolicyError
    ? labFailure(error.code, error.message)
    : labFailure("invalid-change", error instanceof Error ? error.message : String(error));

export const storageFailure = (cause: unknown) =>
  labFailure(
    "executor-unavailable",
    `The engine lab storage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  );

export const manifestIdOf = (hash: string) => `mf_${hash.replace(/^sha256:/, "").slice(0, 16)}`;

/** The installed engine's code identity: its source hash, or the bundle file's hash. */
export function installedSourceHash(options: EngineLabOptionsShape): string | null {
  if (options.engineRoot !== null)
    return engineSourceHash(`${options.engineRoot}/packages/trend-engine/src`);
  if (Result.isSuccess(options.engine)) {
    try {
      return sha256(NodeFS.readFileSync(options.engine.success.cli));
    } catch {
      return null;
    }
  }
  return null;
}

export interface ManifestRow {
  readonly manifest_hash: string;
  readonly manifest_id: string;
  readonly kind: "installed" | "config" | "code";
  readonly parent_hash: string | null;
  readonly manifest_json: string;
  readonly files_json: string;
  readonly project_id: string | null;
  readonly author_thread_id: string | null;
  readonly intent: string | null;
  readonly hypothesis: string | null;
  readonly idempotency_key: string | null;
  readonly created_at: string;
}

const MANIFEST_COLUMNS =
  "manifest_hash, manifest_id, kind, parent_hash, manifest_json, files_json, project_id, " +
  "author_thread_id, intent, hypothesis, idempotency_key, created_at";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const parseJson = (text: string): unknown => decodeJson(text);
export const toJson = (value: unknown): string => encodeJson(value);

export const manifestOf = (row: ManifestRow) => parseJson(row.manifest_json) as EngineManifest;
export const filesOf = (row: ManifestRow) => parseJson(row.files_json) as Record<string, string>;

export const manifestView = (row: ManifestRow): EngineManifestView => {
  const manifest = manifestOf(row);
  return {
    manifestId: row.manifest_id,
    manifestHash: row.manifest_hash,
    kind: row.kind,
    parentHash: row.parent_hash,
    configHash: manifest.config_hash,
    profileHash: manifest.profile_hash,
    feedsHash: manifest.feeds_hash,
    engineSourceHash: manifest.code.engine_source_hash,
    intent: row.intent,
    hypothesis: row.hypothesis,
    createdAt: row.created_at,
    manifest,
  };
};

/** The manifest of `ref`: its full hash or its `mf_` id. */
export const selectManifest = (sql: SqlClient.SqlClient, ref: string) =>
  sql<ManifestRow>`
    SELECT ${sql.literal(MANIFEST_COLUMNS)} FROM editorial_engine_manifests
    WHERE manifest_hash = ${ref} OR manifest_id = ${ref}
  `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

/** Stores `manifest` unless a row with its hash exists, and answers the stored row. */
export const insertManifest = Effect.fn("EngineLab.insertManifest")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly hash: string;
    readonly manifest: EngineManifest;
    readonly files: Readonly<Record<string, string>>;
    readonly projectId: string | null;
    readonly threadId: string | null;
    readonly intent: string | null;
    readonly hypothesis: string | null;
    readonly idempotencyKey: string | null;
    readonly createdAt: string;
  },
) {
  yield* sql`
      INSERT INTO editorial_engine_manifests (
        manifest_hash, manifest_id, kind, parent_hash, manifest_json, files_json, project_id,
        author_thread_id, intent, hypothesis, idempotency_key, created_at
      ) VALUES (
        ${input.hash}, ${manifestIdOf(input.hash)}, ${input.manifest.kind}, ${input.manifest.parent},
        ${toJson(input.manifest)}, ${toJson(input.files)}, ${input.projectId}, ${input.threadId},
        ${input.intent}, ${input.hypothesis}, ${input.idempotencyKey}, ${input.createdAt}
      )
      ON CONFLICT (manifest_hash) DO NOTHING
    `;
  const row = yield* selectManifest(sql, input.hash);
  return Option.getOrThrow(row);
});
