// Earlyscript-only module: switches for upstream features that send data off the machine.
// Upstream files read `earlyscriptFlags` at one-line hook points listed in
// docs/upstream-divergence.md. `EARLYSCRIPT_FLAG_<NAME>=1|0` overrides a default.

export const EARLYSCRIPT_FLAG_DEFAULTS = {
  /** Traces, metrics and logs: OTLP exporters (server, desktop), browser uploads to `/api/observability/v1/traces`, relay tracing. */
  telemetry: false,
  /** Product analytics batches the server sends to PostHog through `ingest.t3.codes`. */
  thirdPartyAnalytics: false,
  /** T3 update checks: web polls `registry.npmjs.org/t3`; desktop's electron-updater polls GitHub Releases. */
  updateChecks: false,
  /** Declared, not wired: T3 relay (`T3CODE_RELAY_URL`, a T3-operated Cloudflare worker). */
  relay: false,
  /** Declared, not wired: T3 Connect account, tunnels and cloud-managed servers (Clerk, `app.t3.codes`). */
  t3Connect: false,
  /** Declared, not wired: pairing the mobile app, which routes through the relay and Expo push. */
  mobilePairing: false,
  /** Declared, not wired: links and prompts to `t3.codes` and the app stores. */
  marketing: false,
} as const satisfies Readonly<Record<string, boolean>>;

export type EarlyscriptFlagName = keyof typeof EARLYSCRIPT_FLAG_DEFAULTS;

export type EarlyscriptFlags = { readonly [Name in EarlyscriptFlagName]: boolean };

type FlagEnv = Readonly<Record<string, string | undefined>>;

const EARLYSCRIPT_FLAG_NAMES = Object.keys(
  EARLYSCRIPT_FLAG_DEFAULTS,
) as ReadonlyArray<EarlyscriptFlagName>;

const ENV_PREFIX = "EARLYSCRIPT_FLAG_";

/** `thirdPartyAnalytics` reads `EARLYSCRIPT_FLAG_THIRD_PARTY_ANALYTICS`. */
export const earlyscriptFlagEnvName = (name: EarlyscriptFlagName): string =>
  `${ENV_PREFIX}${name.replace(/[A-Z]/gu, (letter) => `_${letter}`).toUpperCase()}`;

const parseFlag = (raw: string | undefined): boolean | undefined => {
  switch (raw?.trim().toLowerCase()) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
      return false;
    default:
      return undefined;
  }
};

export const readEarlyscriptFlags = (env: FlagEnv): EarlyscriptFlags => {
  const flags: Record<EarlyscriptFlagName, boolean> = { ...EARLYSCRIPT_FLAG_DEFAULTS };
  for (const name of EARLYSCRIPT_FLAG_NAMES) {
    flags[name] = parseFlag(env[earlyscriptFlagEnvName(name)]) ?? EARLYSCRIPT_FLAG_DEFAULTS[name];
  }
  return Object.freeze(flags);
};

/** The `EARLYSCRIPT_FLAG_*` subset of `env`, for bundlers that inline it into browser code. */
export const pickEarlyscriptFlagEnv = (env: FlagEnv): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith(ENV_PREFIX) && entry[1] !== undefined,
    ),
  );

// Browser bundles have no `process`; apps/web/vite.config.ts inlines the build-time subset.
declare const __EARLYSCRIPT_FLAG_ENV__: Readonly<Record<string, string>> | undefined;

export const earlyscriptFlags: EarlyscriptFlags = readEarlyscriptFlags({
  ...(typeof __EARLYSCRIPT_FLAG_ENV__ === "undefined" ? {} : __EARLYSCRIPT_FLAG_ENV__),
  ...(typeof process === "undefined" ? {} : process.env),
});
