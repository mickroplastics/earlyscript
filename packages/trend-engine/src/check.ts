// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - plain library; files are decoded with Schema.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import {
  Dossier,
  DOSSIER_SCHEMA_VERSION,
  DOSSIER_V2_SCHEMA_VERSION,
  DossierV2,
} from "@earlyscript/editorial-contracts/dossier";
import { RunRecord } from "@earlyscript/editorial-contracts/run";

import { logicalHash } from "./dossier.ts";
import { HOST } from "./host.ts";
import { runEngine, type RunOptions } from "./run.ts";

const decodeRun = Schema.decodeUnknownSync(RunRecord);
const decodeDossier = Schema.decodeUnknownSync(Dossier);
const decodeDossierV2 = Schema.decodeUnknownSync(DossierV2);

export function readRun(runDir: string): { record: RunRecord; dossiers: Array<Dossier> } {
  const record = decodeRun(
    JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, "run.json"), "utf8")),
  );
  const dossiers = record.files.map((file) =>
    decodeDossier(JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, file), "utf8"))),
  );
  return { record, dossiers };
}

/**
 * Any run's dossiers, each decoded with the schema its `schema_version` names: dossier/1 (engine
 * v1 and v2) or dossier/2 (engine v3). Every validation of either schema holds; a run mixes no
 * versions, and an unknown version fails as before.
 */
export function readRunAnyVersion(runDir: string): {
  record: RunRecord;
  schemaVersion: string | null;
  dossiers: Array<Dossier | DossierV2>;
} {
  const record = decodeRun(
    JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, "run.json"), "utf8")),
  );
  const versions = new Set<string>();
  const dossiers = record.files.map((file): Dossier | DossierV2 => {
    const raw: unknown = JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, file), "utf8"));
    const version =
      raw !== null && typeof raw === "object"
        ? (raw as Record<string, unknown>)["schema_version"]
        : undefined;
    if (version === DOSSIER_V2_SCHEMA_VERSION) {
      versions.add(version);
      return decodeDossierV2(raw);
    }
    versions.add(DOSSIER_SCHEMA_VERSION);
    return decodeDossier(raw);
  });
  if (versions.size > 1) {
    throw new Error(`${runDir} mixes dossier schemas: ${[...versions].toSorted().join(", ")}`);
  }
  return { record, schemaVersion: [...versions][0] ?? null, dossiers };
}

export interface CheckResult {
  readonly run_id: string;
  readonly ok: boolean;
  readonly recorded: string | null;
  readonly recomputed: string;
  readonly dossiers: number;
  /** `earlyscript.dossier/1` or `/2`; null for a run without dossiers. */
  readonly dossier_schema: string | null;
  readonly rerun?: {
    readonly run_id: string;
    readonly logical_hash: string | null;
    readonly signals_hash: unknown;
  };
  /**
   * B6: the two claims a rerun can support, kept apart. Embedding vectors differ between
   * platforms (arm64 and x86_64), so a run reproduces on the machine that made it and is not
   * expected to give another machine's hash.
   */
  readonly reproduction?: {
    /** Where the run was recorded and where this check ran (os-arch, Node version). */
    readonly recorded_on: string;
    readonly checked_on: string;
    readonly same_platform: boolean;
    /** The recorded hash holds and the rerun here gives it again. */
    readonly rerun_matches_recorded: boolean;
    /**
     * Two runs of this platform are identical: `rerun_matches_recorded` for a run recorded on
     * this os-arch; null for a run recorded elsewhere, which this check cannot speak for.
     */
    readonly reproduces_own_run: boolean | null;
    /** `--expect`: another machine's hash, compared with the recorded one; null without it. */
    readonly reference: string | null;
    readonly matches_reference: boolean | null;
  };
}

/** Recomputes the logical hash from the dossier files and compares it with run.json. */
export function checkRun(runDir: string): CheckResult {
  const { record, schemaVersion, dossiers } = readRunAnyVersion(runDir);
  const recomputed = logicalHash(dossiers);
  return {
    run_id: record.run_id,
    ok: record.status === "ok" && recomputed === record.logical_hash,
    recorded: record.logical_hash,
    recomputed,
    dossiers: dossiers.length,
    dossier_schema: schemaVersion,
  };
}

const platformOf = (p: { readonly os: string; readonly arch: string }) => `${p.os}-${p.arch}`;

/** Runs again with the recorded corpus, cutoff, config and profile, and compares logical hashes. */
export async function rerunAndCheck(
  runDir: string,
  outDir: string,
  options: Pick<
    RunOptions,
    | "cacheFile"
    | "cacheOnly"
    | "modelDir"
    | "workers"
    | "log"
    | "allowUnverifiedCorpus"
    | "embedder"
    | "relevanceModel"
  > & {
    /** Another machine's logical hash for the same inputs, reported apart (B6). */
    readonly expect?: string;
  } = {},
): Promise<CheckResult> {
  const { expect, ...engineOptions } = options;
  const checked = checkRun(runDir);
  const { record } = readRunAnyVersion(runDir);
  if (!record.corpus || !record.profile || !record.config)
    throw new Error(`${runDir} is a failed run`);
  const rerun = await runEngine({
    ...engineOptions,
    corpusDir: record.corpus.dir,
    cutoff: record.cutoff_at,
    profilePath: record.profile.path,
    config: record.config,
    outDir,
  });
  const rerunMatches = checked.ok && rerun.logical_hash === record.logical_hash;
  const here = { os: HOST.platform, arch: HOST.arch };
  const samePlatform = platformOf(record.platform) === platformOf(here);
  return {
    ...checked,
    ok: rerunMatches,
    rerun: {
      run_id: rerun.run_id,
      logical_hash: rerun.logical_hash,
      signals_hash: rerun.stats?.["signals_hash"] ?? null,
    },
    reproduction: {
      recorded_on: `${platformOf(record.platform)} node ${record.platform.node}`,
      checked_on: `${platformOf(here)} node ${process.version}`,
      same_platform: samePlatform,
      rerun_matches_recorded: rerunMatches,
      reproduces_own_run: samePlatform ? rerunMatches : null,
      reference: expect ?? null,
      matches_reference: expect === undefined ? null : record.logical_hash === expect,
    },
  };
}
