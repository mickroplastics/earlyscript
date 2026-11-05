// What the trusted worker hands back: the engine outputs of both arms per cutoff, never a
// metric, signed with the job's secret. The server recomputes every metric from these.
import { canonicalJson, hmac, sameSignature, sha256 } from "./hash.ts";
import type { EngineManifest } from "./manifest.ts";

export const JOB_SPEC_SCHEMA = "earlyscript.engine-lab-job/2";
export const RESULT_SCHEMA = "earlyscript.engine-lab-result/3";

export type ArmSide = "reference" | "candidate";

export interface ArmSpec {
  readonly manifest_hash: string;
  readonly manifest: EngineManifest;
  /** Patched engine files, repository path to their full new contents; empty for config. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Built by the server from the campaign the operator created and the stored candidate; sent
 * on stdin. No field comes from a model: paths and cutoffs are the campaign's.
 */
export interface JobSpec {
  readonly schema: typeof JOB_SPEC_SCHEMA;
  /** Server-made; names the job's directory and process group on the executor. */
  readonly token: string;
  /** Signs the result; only on stdin, never in argv, env or a file the sandbox sees. */
  readonly secret: string;
  readonly kind: "development" | "shadow";
  /** Midnight UTC, one per day, sorted. */
  readonly cutoffs: ReadonlyArray<string>;
  /** The operator's authorized input roots: every input must resolve inside one of them. */
  readonly input_roots: ReadonlyArray<string>;
  readonly corpus_dir: string;
  readonly profile_path: string;
  readonly profile_hash: string;
  readonly cache_file: string | null;
  readonly cache_only: boolean;
  readonly models_dir: string | null;
  readonly embedder: "local" | "synthetic";
  readonly workers: number;
  /** Top positions each arm reports; the evaluator reads the first 5. */
  readonly top: number;
  readonly sandbox: "required" | "if-available";
  /** What the campaign fixed by content; the executor checks its inputs against it. */
  readonly inputs: JobInputs;
  readonly limits: JobLimits;
  readonly reference: ArmSpec;
  readonly candidate: ArmSpec;
}

export interface JobInputs {
  /**
   * The development corpus' corpus_hash. Null for a shadow: its corpus grows every day, so
   * each cutoff's view is fixed when it is observed and recorded in the result instead.
   */
  readonly corpus_hash: string | null;
  /** Content hash of the model directory; null when the campaign names none. */
  readonly models_hash: string | null;
}

export interface JobLimits {
  /** Wall time of one arm at one cutoff; past it the arm is killed and the job fails. */
  readonly arm_timeout_ms: number;
  /** The arm's JavaScript heap, in megabytes. */
  readonly memory_mb: number;
}

export const DEFAULT_LIMITS: JobLimits = { arm_timeout_ms: 30 * 60_000, memory_mb: 4096 };

/** One cutoff's corpus view, the same for both arms, as the executor made it. */
export interface ViewRecord {
  readonly cutoff: string;
  readonly corpus_hash: string;
  readonly files: number;
  /** The cache entries this cutoff read (key, text hash, vector hash); null without a cache. */
  readonly cache_entries_hash: string | null;
  readonly cache_entries: number;
  /** When the executor made the view: a shadow cutoff is never viewed before it has passed. */
  readonly observed_at: string;
}

export interface ArmTrend {
  readonly position: number;
  readonly trend_id: string;
  readonly label: string;
  readonly stage: string;
  readonly score: number;
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly value: number | null;
    readonly weight: number;
    readonly contribution: number;
  }>;
  readonly items_7d: number;
  readonly item_ids: ReadonlyArray<string>;
  /** sha256 of `source\npublished_at\ntitle` per member, from the corpus, not the arm. */
  readonly member_keys: ReadonlyArray<string>;
  /** Five most recent members before the cutoff, for blind cards. */
  readonly headlines: ReadonlyArray<{
    readonly title: string;
    readonly source: string;
    readonly published_at: string;
  }>;
}

export interface ArmOutput {
  readonly cutoff: string;
  readonly run_id: string;
  readonly status: string;
  /** Recomputed by the worker from the dossier files, never the arm's own claim. */
  readonly logical_hash: string;
  /** sha256 of every emitted trend's member ids, which the logical hash does not cover. */
  readonly members_hash: string;
  readonly config_hash: string;
  readonly profile_hash: string;
  readonly eligible: number;
  readonly top: ReadonlyArray<ArmTrend>;
  readonly duration_ms: number;
}

export interface WorkerResult {
  readonly schema: typeof RESULT_SCHEMA;
  readonly token: string;
  readonly spec_sha256: string;
  readonly reference_hash: string;
  readonly candidate_hash: string;
  readonly status: "ok" | "failed";
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly executor: {
    readonly host: string;
    readonly node: string;
    /** bwrap: no network, only the corpus, the tree and its output dir visible. */
    readonly sandbox: "bwrap" | "none";
  };
  /** The inputs as the executor found them before any arm ran. */
  readonly inputs: {
    readonly corpus_hash: string | null;
    readonly models_hash: string | null;
  };
  readonly views: ReadonlyArray<ViewRecord>;
  readonly arms: {
    readonly reference: ReadonlyArray<ArmOutput>;
    readonly candidate: ReadonlyArray<ArmOutput>;
  };
  readonly signature: string;
}

/** The spec's identity without its secret: what the server and the worker both hash. */
export const specHash = (spec: JobSpec) => sha256(canonicalJson({ ...spec, secret: null }));

export const signResult = (
  secret: string,
  unsigned: Omit<WorkerResult, "signature">,
): WorkerResult => ({
  ...unsigned,
  signature: hmac(secret, canonicalJson(unsigned)),
});

/** Why `result` is not the signed answer to `spec`, or null when it is. */
export function resultMismatch(spec: JobSpec, result: WorkerResult): string | null {
  if (result.schema !== RESULT_SCHEMA) return "unknown result schema";
  const { signature, ...unsigned } = result;
  if (
    typeof signature !== "string" ||
    !sameSignature(signature, hmac(spec.secret, canonicalJson(unsigned)))
  ) {
    return "the result signature does not match its content";
  }
  if (result.token !== spec.token) return "the result belongs to another job";
  if (result.spec_sha256 !== specHash(spec)) return "the result answers another job spec";
  if (result.reference_hash !== spec.reference.manifest_hash) return "reference manifest differs";
  if (result.candidate_hash !== spec.candidate.manifest_hash) return "candidate manifest differs";
  if (result.status !== "ok") return null;
  if (spec.inputs.corpus_hash !== null && result.inputs.corpus_hash !== spec.inputs.corpus_hash)
    return "the corpus is not the campaign's";
  if (spec.inputs.models_hash !== null && result.inputs.models_hash !== spec.inputs.models_hash)
    return "the models are not the campaign's";
  if (result.views.length !== spec.cutoffs.length) return "a cutoff has no corpus view";
  for (const [k, view] of result.views.entries()) {
    if (view.cutoff !== spec.cutoffs[k]) return `view ${view.cutoff} out of order`;
    if (spec.kind === "shadow" && !(Date.parse(view.observed_at) >= Date.parse(view.cutoff)))
      return `the shadow viewed ${view.cutoff.slice(0, 10)} before it had passed`;
  }
  for (const side of ["reference", "candidate"] as const) {
    const arms = result.arms[side];
    const manifest = spec[side].manifest;
    if (arms.length !== spec.cutoffs.length)
      return `${side}: ${arms.length} cutoffs, expected ${spec.cutoffs.length}`;
    for (const [k, arm] of arms.entries()) {
      if (arm.cutoff !== spec.cutoffs[k]) return `${side}: cutoff ${arm.cutoff} out of order`;
      if (arm.status !== "ok") return `${side}: run at ${arm.cutoff} is ${arm.status}`;
      if (arm.config_hash !== manifest.config_hash)
        return `${side}: run config differs from its manifest`;
      if (arm.profile_hash !== spec.profile_hash) return `${side}: run profile differs`;
    }
  }
  return null;
}
