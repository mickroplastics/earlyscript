// @effect-diagnostics nodeBuiltinImport:off -- lists and hashes the installed engine's configuration files, as engineLabSupport reads the default one.
// `editorial.activeEngineConfig`: which configuration file of the installed engine the nightly
// run starts from. Only the operator's explicit choice changes it (EditorialJobsService
// .updateSettings), each choice is a new row with its time, and without any row the nightly run
// keeps `engine.v1.json`, the engine's default. The engine lab's active manifest still applies
// over it, as it did over engine.v1.json.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { EnabledSources } from "./EditorialSourcesService.ts";
import type { EngineLocation } from "./engineProcess.ts";

/** The file the nightly run reads while the operator never chose another one. */
export const DEFAULT_ENGINE_CONFIG = "engine.v1.json";

/**
 * The evaluated method. A server that never recorded a choice registers it as its first one
 * (`actor` `default`) when its engine ships it; an existing choice is never replaced.
 */
export const EVALUATED_ENGINE_CONFIG = "engine.v3-sel.json";

/** A configuration file of the engine's `config/` directory, never a path outside it. */
const ENGINE_CONFIG_FILE = /^engine\.[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

const isEngineConfigFile = (file: string) => ENGINE_CONFIG_FILE.test(file);

export interface EngineConfigChoice {
  readonly file: string;
  /** When the operator chose it; null while the default was never changed. */
  readonly chosenAt: string | null;
}

/** The latest explicit choice, or the default. */
export const readEngineConfigChoice = (sql: SqlClient.SqlClient) =>
  sql<{ readonly config_file: string; readonly created_at: string }>`
    SELECT config_file, created_at FROM editorial_engine_config_choices ORDER BY seq DESC LIMIT 1
  `.pipe(
    Effect.map((rows): EngineConfigChoice => {
      const row = rows[0];
      return row === undefined
        ? { file: DEFAULT_ENGINE_CONFIG, chosenAt: null }
        : { file: row.config_file, chosenAt: row.created_at };
    }),
  );

/** Appends the operator's choice; the caller checked that the file exists in the engine. */
export const appendEngineConfigChoice = (
  sql: SqlClient.SqlClient,
  input: {
    readonly file: string;
    readonly sha256: string;
    readonly previous: string;
    readonly actor: string;
    readonly at: string;
  },
) => sql`
  INSERT INTO editorial_engine_config_choices (config_file, config_sha256, previous_file, actor, created_at)
  VALUES (${input.file}, ${input.sha256}, ${input.previous}, ${input.actor}, ${input.at})
`;

const configDir = (engine: EngineLocation) => NodePath.dirname(engine.defaultConfig);

/** Where `file` lives in the installed engine's configuration directory. */
const engineConfigPath = (engine: EngineLocation, file: string) =>
  NodePath.join(configDir(engine), file);

/** The file the nightly run reads: `engine.defaultConfig` until the operator chose another. */
export const chosenConfigPath = (engine: EngineLocation, choice: EngineConfigChoice) =>
  choice.chosenAt === null ? engine.defaultConfig : engineConfigPath(engine, choice.file);

/** The configuration files the installed engine ships, by name. */
export function availableEngineConfigs(engine: EngineLocation): ReadonlyArray<string> {
  try {
    return NodeFS.readdirSync(configDir(engine))
      .filter(isEngineConfigFile)
      .filter((file) => NodeFS.statSync(NodePath.join(configDir(engine), file)).isFile())
      .toSorted();
  } catch {
    return [];
  }
}

/** sha256 of a configuration file's bytes, as recorded with the choice. */
export const engineConfigFileSha256 = (engine: EngineLocation, file: string) =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(engineConfigPath(engine, file)))
    .digest("hex")}`;

/**
 * The configuration the nightly run hands the engine. The source switches enter it as `sources`,
 * in catalogue order, so they enter its hash. A configuration that names its clustered sources
 * (`sources_cluster`, engine.v3) keeps `sources` and `sources_cluster` exactly as the file has
 * them, so its `config_hash` is the file's (B2); the switches still decide what is collected.
 */
export function nightlyConfig(
  base: Readonly<Record<string, unknown>>,
  enabled: Pick<EnabledSources, "rank">,
): Record<string, unknown> {
  if (base["sources_cluster"] !== undefined) return { ...base };
  return { ...base, sources: [...enabled.rank] };
}
