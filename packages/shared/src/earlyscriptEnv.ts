/**
 * Earlyscript-only module: settings come from `EARLYSCRIPT_*`, never from the `T3CODE_*`/`T3_*`
 * that T3 Code exports to its terminals and agents. Each entry point adopts its environment first;
 * a parent passes settings to an Earlyscript child with `mirrorToEarlyscriptEnvironment`.
 */

const T3_PREFIXES = ["T3CODE_", "T3_"] as const;
const EARLYSCRIPT_PREFIX = "EARLYSCRIPT_";

/**
 * Dev-runner knobs that agents and scripts still pass with the T3 name. T3 Code never exports
 * them, so they are kept during the transition; `EARLYSCRIPT_<NAME>` wins when both are set.
 */
const TRANSITIONAL_T3_VARIABLES: ReadonlyArray<string> = [
  "T3CODE_PORT_OFFSET",
  "T3CODE_DEV_INSTANCE",
  "T3CODE_DEV_SEED",
  "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "T3CODE_LOG_WS_EVENTS",
];

/** Earlyscript's own variables: never aliases of a `T3CODE_*` setting. */
const OWN_PREFIXES = ["EARLYSCRIPT_FLAG_", "EARLYSCRIPT_EDITORIAL_"] as const;
const OWN_NAMES: ReadonlySet<string> = new Set(["EARLYSCRIPT_THREAD_ID"]);
/** Aliases a child keeps: an Earlyscript child needs its home and launcher, not the server's runtime. */
const INHERITED_ALIASES: ReadonlySet<string> = new Set([
  "EARLYSCRIPT_HOME",
  "EARLYSCRIPT_CLI_PATH",
]);
/** One-shot markers for this process only: copied to the T3 name, then removed, so children do not inherit them. */
const CONSUMED_NAMES: ReadonlySet<string> = new Set(["EARLYSCRIPT_DESKTOP_CLI_LAUNCHER"]);

const isT3Variable = (name: string) => T3_PREFIXES.some((prefix) => name.startsWith(prefix));

const aliasOf = (name: string): string | undefined =>
  name.startsWith(EARLYSCRIPT_PREFIX) &&
  !OWN_NAMES.has(name) &&
  !OWN_PREFIXES.some((prefix) => name.startsWith(prefix))
    ? `T3CODE_${name.slice(EARLYSCRIPT_PREFIX.length)}`
    : undefined;

export interface AdoptEarlyscriptEnvironmentOptions {
  /** Keep `TRANSITIONAL_T3_VARIABLES` (development entry points only). */
  readonly transitional: boolean;
  /**
   * Also drop `ELECTRON_RUN_AS_NODE`. The server keeps it: under the desktop app its ACP agents
   * start the MCP bridge with Electron's binary and need it inherited.
   */
  readonly dropElectronRunAsNode: boolean;
}

/** Mutates `env` in place and returns the inherited T3 variables it dropped. */
export function adoptEarlyscriptEnvironment(
  env: NodeJS.ProcessEnv,
  options: AdoptEarlyscriptEnvironmentOptions,
): ReadonlyArray<string> {
  const dropped: Array<string> = [];
  for (const name of Object.keys(env)) {
    if (!isT3Variable(name)) continue;
    if (options.transitional && TRANSITIONAL_T3_VARIABLES.includes(name)) continue;
    delete env[name];
    dropped.push(name);
  }
  if (options.dropElectronRunAsNode && env.ELECTRON_RUN_AS_NODE !== undefined) {
    delete env.ELECTRON_RUN_AS_NODE;
    dropped.push("ELECTRON_RUN_AS_NODE");
  }
  for (const [name, value] of Object.entries(env)) {
    const alias = aliasOf(name);
    if (alias !== undefined && value !== undefined) env[alias] = value;
    if (CONSUMED_NAMES.has(name)) delete env[name];
  }
  return dropped;
}

/**
 * Environment for a child of the server: drops each `T3CODE_*`/`T3_*` and each `EARLYSCRIPT_*`
 * alias (bar HOME and CLI_PATH) that `serverEnv` holds with the same value. What the caller set
 * for this child (its MCP wiring) stays, and so does `ELECTRON_RUN_AS_NODE`, which ACP needs.
 */
export function earlyscriptChildEnvironment<Env extends Record<string, string | undefined>>(
  env: Env,
  serverEnv: Readonly<Record<string, string | undefined>>,
): Env {
  const next: Record<string, string | undefined> = { ...env };
  for (const name of Object.keys(next)) {
    const fromServer = serverEnv[name] !== undefined && next[name] === serverEnv[name];
    if (!fromServer) continue;
    if (isT3Variable(name) || (aliasOf(name) !== undefined && !INHERITED_ALIASES.has(name))) {
      delete next[name];
    }
  }
  return next as Env;
}

/**
 * For a child that is itself an Earlyscript process: makes its `EARLYSCRIPT_*` aliases match
 * the `T3CODE_*` settings in `env` exactly (set, changed or removed), so the child's
 * `adoptEarlyscriptEnvironment` reads the same values back. Mutates and returns `env`.
 */
export function mirrorToEarlyscriptEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of Object.keys(env)) {
    const alias = aliasOf(name);
    if (alias !== undefined && env[alias] === undefined) delete env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("T3CODE_") && value !== undefined) {
      env[`${EARLYSCRIPT_PREFIX}${name.slice("T3CODE_".length)}`] = value;
    }
  }
  return env;
}

/** `T3CODE_<NAME>` to the `EARLYSCRIPT_<NAME>` a child reads it back from. */
export const earlyscriptAliasOf = (t3Name: string): string =>
  `${EARLYSCRIPT_PREFIX}${t3Name.replace(/^T3CODE_/u, "")}`;
