// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - plain library; files are decoded with Schema.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { Dossier } from "@earlyscript/editorial-contracts/dossier";
import { RunRecord } from "@earlyscript/editorial-contracts/run";

import { logicalHash } from "./dossier.ts";
import { runEngine, type RunOptions } from "./run.ts";

const decodeRun = Schema.decodeUnknownSync(RunRecord);
const decodeDossier = Schema.decodeUnknownSync(Dossier);

export function readRun(runDir: string): { record: RunRecord; dossiers: Array<Dossier> } {
  const record = decodeRun(
    JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, "run.json"), "utf8")),
  );
  const dossiers = record.files.map((file) =>
    decodeDossier(JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, file), "utf8"))),
  );
  return { record, dossiers };
}

export interface CheckResult {
  readonly run_id: string;
  readonly ok: boolean;
  readonly recorded: string | null;
  readonly recomputed: string;
  readonly dossiers: number;
  readonly rerun?: {
    readonly run_id: string;
    readonly logical_hash: string | null;
    readonly signals_hash: unknown;
  };
}

/** Recomputes the logical hash from the dossier files and compares it with run.json. */
export function checkRun(runDir: string): CheckResult {
  const { record, dossiers } = readRun(runDir);
  const recomputed = logicalHash(dossiers);
  return {
    run_id: record.run_id,
    ok: record.status === "ok" && recomputed === record.logical_hash,
    recorded: record.logical_hash,
    recomputed,
    dossiers: dossiers.length,
  };
}

/** Runs again with the recorded corpus, cutoff, config and profile, and compares logical hashes. */
export async function rerunAndCheck(
  runDir: string,
  outDir: string,
  options: Pick<
    RunOptions,
    "cacheFile" | "cacheOnly" | "modelDir" | "workers" | "log" | "allowUnverifiedCorpus"
  > = {},
): Promise<CheckResult> {
  const checked = checkRun(runDir);
  const { record } = readRun(runDir);
  if (!record.corpus || !record.profile || !record.config)
    throw new Error(`${runDir} is a failed run`);
  const rerun = await runEngine({
    ...options,
    corpusDir: record.corpus.dir,
    cutoff: record.cutoff_at,
    profilePath: record.profile.path,
    config: record.config,
    outDir,
  });
  return {
    ...checked,
    ok: checked.ok && rerun.logical_hash === record.logical_hash,
    rerun: {
      run_id: rerun.run_id,
      logical_hash: rerun.logical_hash,
      signals_hash: rerun.stats?.["signals_hash"] ?? null,
    },
  };
}
