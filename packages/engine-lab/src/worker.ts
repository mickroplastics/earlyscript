// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off - the trusted executor, a plain Node program.
// The trusted side of an evaluation: it checks the job against the sealed partitions, builds a
// code candidate's tree, runs every arm (in bwrap without network when available), checks what
// each arm wrote against the corpus and returns the signed outputs. It never sees labels.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { checkRun, readRun } from "@earlyscript/trend-engine/check";

import { memberKey } from "./compare.ts";
import { canonicalJson, engineSourceHash, sha256 } from "./hash.ts";
import { canonicalInputs } from "./inputs.ts";
import { assertNotSealed, configHash, cutoffDays, LabPolicyError } from "./policy.ts";
import {
  type ArmOutput,
  type ArmSide,
  type ArmTrend,
  type JobSpec,
  RESULT_SCHEMA,
  signResult,
  specHash,
  type ViewRecord,
  type WorkerResult,
} from "./result.ts";
import { sandboxArgs } from "./sandbox.ts";
import { buildView, corpusIdentity, type CorpusView, fileHash, treeHash } from "./view.ts";

const ENGINE_PREFIX = "packages/trend-engine/src/";
const TOKEN = /^[a-z0-9][a-z0-9_-]{7,63}$/;

export interface WorkerOptions {
  /** Where job directories live on this executor; the operator's, never a model's. */
  readonly jobsRoot: string;
  /** The checkout whose packages/trend-engine is the installed engine. */
  readonly engineRoot: string;
  readonly log?: (line: string) => void;
  /** Overrides bwrap detection, for tests. */
  readonly sandbox?: "bwrap" | "none";
  /** The executor's clock; tests set it, the product never does. */
  readonly now?: () => number;
}

class WorkerFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const bwrapAvailable = (): boolean => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone worker, no Effect runtime.
  if (NodeOS.platform() !== "linux") return false;
  const probe = NodeChildProcess.spawnSync(
    "bwrap",
    [
      "--unshare-all",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "true",
    ],
    { stdio: "ignore", timeout: 10_000 },
  );
  return probe.status === 0;
};

interface IndexedItem {
  readonly source: string;
  readonly published_at: string;
  readonly title: string;
}

/** Every item of the corpus published before `untilDay`, by id: what the arms may emit. */
function indexCorpus(corpusDir: string, untilDay: string): Map<string, IndexedItem> {
  const index = new Map<string, IndexedItem>();
  for (const entry of NodeFS.readdirSync(corpusDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "raw") continue;
    const dir = NodePath.join(corpusDir, entry.name);
    for (const file of NodeFS.readdirSync(dir)) {
      const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)?.[1];
      if (day === undefined || day >= untilDay) continue;
      for (const line of NodeFS.readFileSync(NodePath.join(dir, file), "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const item = JSON.parse(line) as {
          id: string;
          source: string;
          published_at: string;
          title: string;
        };
        index.set(item.id, {
          source: item.source,
          published_at: item.published_at,
          title: item.title,
        });
      }
    }
  }
  return index;
}

/** Materializes `side`'s engine: the installed one, or a copy with the candidate's files. */
function prepareTree(spec: JobSpec, side: ArmSide, jobDir: string, options: WorkerOptions): string {
  const arm = spec[side];
  const installedSrc = NodePath.join(options.engineRoot, ENGINE_PREFIX);
  const installed = engineSourceHash(installedSrc);
  const files = Object.entries(arm.files);
  if (files.length === 0) {
    if (arm.manifest.code.engine_source_hash !== installed) {
      throw new WorkerFailure(
        "stale-base",
        `${side}: the executor's engine is ${installed}, not the manifest's ${arm.manifest.code.engine_source_hash}.`,
      );
    }
    return installedSrc;
  }
  if (arm.manifest.code.base_source_hash !== installed) {
    throw new WorkerFailure(
      "stale-base",
      `${side}: the patch was made for another engine than the executor's.`,
    );
  }
  const tree = NodePath.join(jobDir, `${side}-tree`);
  const pkg = NodePath.join(tree, "packages", "trend-engine");
  NodeFS.rmSync(tree, { recursive: true, force: true });
  NodeFS.mkdirSync(pkg, { recursive: true });
  NodeFS.cpSync(installedSrc, NodePath.join(pkg, "src"), { recursive: true });
  const overrides = new Map<string, string>();
  for (const [path, contents] of files) {
    if (!path.startsWith(ENGINE_PREFIX) || path.includes("..")) {
      throw new WorkerFailure("artifact-mismatch", `${path} is not an engine source file.`);
    }
    if (sha256(contents) !== arm.manifest.code.files[path]) {
      throw new WorkerFailure(
        "artifact-mismatch",
        `${path} differs from the candidate's manifest.`,
      );
    }
    const rel = path.slice(ENGINE_PREFIX.length);
    NodeFS.writeFileSync(NodePath.join(pkg, "src", rel), contents);
    overrides.set(rel, contents);
  }
  // Read-only links to what the engine resolves: its dependencies and its configuration dir.
  for (const name of ["node_modules", "config", "package.json"]) {
    NodeFS.symlinkSync(
      NodePath.join(options.engineRoot, "packages", "trend-engine", name),
      NodePath.join(pkg, name),
    );
  }
  const built = engineSourceHash(NodePath.join(pkg, "src"));
  if (built !== arm.manifest.code.engine_source_hash) {
    throw new WorkerFailure(
      "artifact-mismatch",
      `${side}: the built tree hashes ${built}, not its manifest's.`,
    );
  }
  return NodePath.join(pkg, "src");
}

function runArm(input: {
  readonly spec: JobSpec;
  readonly side: ArmSide;
  readonly cutoff: string;
  readonly engineSrc: string;
  readonly jobDir: string;
  readonly sandbox: "bwrap" | "none";
  readonly cacheFile: string | null;
  readonly options: WorkerOptions;
  /** The cutoff's corpus view: the only corpus the arm sees. */
  readonly view: CorpusView;
  readonly index: Map<string, IndexedItem>;
}): ArmOutput {
  const { spec, side, cutoff } = input;
  const out = NodePath.join(input.jobDir, side, cutoff.slice(0, 10));
  NodeFS.rmSync(out, { recursive: true, force: true });
  NodeFS.mkdirSync(out, { recursive: true });
  const configPath = NodePath.join(out, "config.json");
  NodeFS.writeFileSync(configPath, `${JSON.stringify(spec[side].manifest.config)}\n`);
  const armSpec = NodePath.join(out, "arm-spec.json");
  NodeFS.writeFileSync(
    armSpec,
    JSON.stringify({
      engine_src: input.engineSrc,
      corpus_dir: input.view.dir,
      cutoff,
      profile_path: spec.profile_path,
      config_path: configPath,
      out_dir: out,
      cache_file: input.cacheFile,
      cache_only: spec.cache_only,
      models_dir: spec.models_dir,
      embedder: spec.embedder,
      workers: spec.workers,
      top: spec.top,
    }),
  );
  const armScript = NodePath.join(import.meta.dirname, "arm.ts");
  // The heap cap; the wall-time cap is the spawn's timeout below.
  const nodeArgs = [`--max-old-space-size=${spec.limits.memory_mb}`, armScript, "--spec", armSpec];
  const root = input.options.engineRoot;
  const readOnly = [
    NodePath.join(root, "node_modules"),
    NodePath.join(root, "packages", "trend-engine"),
    NodePath.join(root, "packages", "editorial-contracts"),
    NodePath.dirname(armScript),
    input.view.dir,
    spec.profile_path,
    ...(spec.models_dir === null ? [] : [spec.models_dir]),
    ...(input.engineSrc.startsWith(input.jobDir)
      ? [NodePath.dirname(NodePath.dirname(NodePath.dirname(input.engineSrc)))]
      : []),
  ];
  const writable = input.cacheFile === null ? [] : [NodePath.dirname(input.cacheFile)];
  const [command, args] =
    input.sandbox === "bwrap"
      ? ["bwrap", [...sandboxArgs({ readOnly, writable, out }), process.execPath, ...nodeArgs]]
      : [process.execPath, nodeArgs];
  const log = NodeFS.openSync(NodePath.join(out, "arm.log"), "w");
  const started = Date.now();
  const child = NodeChildProcess.spawnSync(command, args, {
    stdio: ["ignore", log, log],
    cwd: out,
    // Outside the sandbox the arm still gets no secret: the spec stays in this process.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: out, ELECTRON_RUN_AS_NODE: "1" },
    // bwrap's namespace dies with it: killing it ends every process of the arm.
    timeout: spec.limits.arm_timeout_ms,
    killSignal: "SIGKILL",
  });
  NodeFS.closeSync(log);
  if ((child.error as { code?: string } | undefined)?.code === "ETIMEDOUT") {
    throw new WorkerFailure(
      "timeout",
      `${side} at ${cutoff} ran past ${spec.limits.arm_timeout_ms} ms and was killed.`,
    );
  }
  if (child.status !== 0) {
    const tail = NodeFS.readFileSync(NodePath.join(out, "arm.log"), "utf8").slice(-600);
    throw new WorkerFailure(
      "engine-failed",
      `${side} at ${cutoff} exited with ${child.status}: ${tail}`,
    );
  }
  return collectArm({ ...input, out, durationMs: Date.now() - started });
}

const DOSSIER_FILE = /^dossiers\/[A-Za-z0-9._-]+\.json$/;

/**
 * Copies `runs/` and `members.json` of an arm's output into `dest`: directories and regular
 * single-link files only, opened without following links. A link, a device, a fifo or a file
 * shared with another path anywhere in them refuses the whole output.
 */
function snapshotOutput(out: string, dest: string, mismatch: (message: string) => Error) {
  const root = NodeFS.lstatSync(out);
  if (!root.isDirectory() || NodeFS.realpathSync(out) !== out)
    throw mismatch("its output directory moved.");
  NodeFS.mkdirSync(dest, { recursive: true });
  const copy = (rel: string) => {
    const from = NodePath.join(out, rel);
    const stat = NodeFS.lstatSync(from);
    if (stat.isSymbolicLink()) throw mismatch(`${rel} is a link; an arm's output takes no links.`);
    if (stat.isDirectory()) {
      NodeFS.mkdirSync(NodePath.join(dest, rel), { recursive: true });
      for (const name of NodeFS.readdirSync(from)) copy(NodePath.join(rel, name));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1)
      throw mismatch(`${rel} is not a plain file of its own.`);
    const fd = NodeFS.openSync(from, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    try {
      const opened = NodeFS.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw mismatch(`${rel} changed while it was read.`);
      }
      NodeFS.writeFileSync(NodePath.join(dest, rel), NodeFS.readFileSync(fd));
    } finally {
      NodeFS.closeSync(fd);
    }
  };
  for (const entry of ["runs", "members.json"]) {
    let present = true;
    try {
      NodeFS.lstatSync(NodePath.join(out, entry));
    } catch {
      present = false;
    }
    if (present) copy(entry);
  }
}

/**
 * What one arm emitted, read back by this process, which never loads candidate code: the run
 * as the installed engine's reader decodes it, its logical hash recomputed from the dossiers,
 * its configuration, profile and cutoff checked against the job, and its members checked
 * against the corpus. The arm's own claims about any of these count for nothing.
 */
function collectArm(input: {
  readonly spec: JobSpec;
  readonly side: ArmSide;
  readonly cutoff: string;
  readonly out: string;
  readonly durationMs: number;
  readonly index: Map<string, IndexedItem>;
}): ArmOutput {
  const { spec, side, cutoff, out } = input;
  const cutoffDay = cutoff.slice(0, 10);
  const where = `${side} at ${cutoffDay}`;
  const mismatch = (message: string) =>
    new WorkerFailure("artifact-mismatch", `${where}: ${message}`);
  // Everything the candidate's arm left is untrusted input: copied here first, regular files
  // only, no link followed, after the arm's processes are gone (bwrap ends its whole pid
  // namespace with it). Every later read is of this copy, which the arm never sees.
  const snapshot = NodePath.join(NodePath.dirname(out), `${NodePath.basename(out)}.collected`);
  NodeFS.rmSync(snapshot, { recursive: true, force: true });
  snapshotOutput(out, snapshot, mismatch);
  const runsDir = NodePath.join(snapshot, "runs");
  const runs = NodeFS.existsSync(runsDir) ? NodeFS.readdirSync(runsDir) : [];
  const finished = runs.filter((name) => /^run_[A-Za-z0-9_]+$/.test(name));
  if (
    finished.length !== 1 ||
    runs.some((name) => !name.startsWith(".") && !finished.includes(name))
  ) {
    throw mismatch(`expected one run directory, found ${runs.join(", ") || "none"}.`);
  }
  const runDir = NodePath.join(runsDir, finished[0]!);
  const listed = (() => {
    try {
      return JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, "run.json"), "utf8")) as {
        run_id?: unknown;
        files?: unknown;
      };
    } catch {
      throw mismatch("run.json is not JSON.");
    }
  })();
  // The dossiers run.json names: plain names inside the run's own dossiers directory.
  if (
    listed.run_id !== finished[0] ||
    !Array.isArray(listed.files) ||
    listed.files.some((file) => typeof file !== "string" || !DOSSIER_FILE.test(file)) ||
    new Set(listed.files).size !== listed.files.length
  ) {
    throw mismatch("run.json names files outside its own dossiers, or another run.");
  }
  let read: ReturnType<typeof readRun>;
  let checked: ReturnType<typeof checkRun>;
  try {
    read = readRun(runDir);
    checked = checkRun(runDir);
  } catch (error) {
    throw mismatch(
      `the run does not decode: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { record, dossiers } = read;
  if (record.status !== "ok") {
    throw new WorkerFailure(
      "engine-failed",
      `${where}: the run is ${record.status}: ${JSON.stringify(record.error ?? null)}`,
    );
  }
  if (checked.recomputed !== record.logical_hash) {
    throw mismatch("run.json's logical hash is not the hash of its dossiers.");
  }
  const expected = spec[side].manifest.config_hash;
  if (configHash(record.config) !== expected || record.config_hash !== expected) {
    throw mismatch("the run's configuration is not its manifest's.");
  }
  if (record.profile?.hash !== spec.profile_hash)
    throw mismatch("the run's profile is not the campaign's.");
  if (record.cutoff_at !== cutoff) throw mismatch(`the run's cutoff is ${record.cutoff_at}.`);
  const positions = dossiers.map((dossier) => dossier.rankings.weighted.position);
  if (
    dossiers.some((dossier) => dossier.run_id !== record.run_id || dossier.cutoff_at !== cutoff) ||
    new Set(positions).size !== positions.length
  ) {
    throw mismatch("the dossiers are not this run's, one per position.");
  }
  const membersFile = NodePath.join(snapshot, "members.json");
  const raw = NodeFS.existsSync(membersFile)
    ? (JSON.parse(NodeFS.readFileSync(membersFile, "utf8")) as {
        run_id?: string;
        members?: Record<string, ReadonlyArray<string>>;
      })
    : {};
  if (raw.run_id !== record.run_id || raw.members === undefined)
    throw mismatch("no members for this run.");
  const membersOf = (dossier: (typeof dossiers)[number]) => {
    const ids = raw.members![dossier.trend.id];
    if (!Array.isArray(ids)) throw mismatch(`no members for ${dossier.trend.id}.`);
    const set = new Set(ids);
    if (
      set.size !== ids.length ||
      dossier.evidence.some((evidence) => !set.has(evidence.item_id))
    ) {
      throw mismatch(`the members of ${dossier.trend.id} do not contain its evidence.`);
    }
    return ids.map((id) => {
      const item = input.index.get(id);
      if (item === undefined) throw mismatch(`${id} is not in the corpus before the cutoff.`);
      if (item.published_at.slice(0, 10) >= cutoffDay)
        throw mismatch(`${id} was published after the cutoff.`);
      return { id, item };
    });
  };
  const all = dossiers
    .toSorted((a, b) => a.rankings.weighted.position - b.rankings.weighted.position)
    .map((dossier) => ({ dossier, members: membersOf(dossier) }));
  const top: Array<ArmTrend> = all.slice(0, spec.top).map(({ dossier, members }) => ({
    position: dossier.rankings.weighted.position,
    trend_id: dossier.trend.id,
    label: dossier.trend.label,
    stage: dossier.trend.stage,
    score: dossier.rankings.weighted.score,
    components: dossier.rankings.weighted.components.map(
      ({ name, value, weight, contribution }) => ({
        name,
        value,
        weight,
        contribution,
      }),
    ),
    items_7d: dossier.trend.items_7d,
    item_ids: members.map((member) => member.id),
    member_keys: members.map((member) => memberKey(member.item)),
    headlines: members
      .map((member) => member.item)
      .toSorted((a, b) =>
        a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0,
      )
      .slice(0, 5)
      .map(({ title, source, published_at }) => ({ title, source, published_at })),
  }));
  return {
    cutoff,
    run_id: record.run_id,
    status: record.status,
    logical_hash: checked.recomputed,
    // Every emitted trend's members, which the logical hash of the dossiers does not cover.
    members_hash: sha256(
      canonicalJson(
        all.map(({ dossier, members }) => [dossier.trend.id, members.map((m) => m.id).toSorted()]),
      ),
    ),
    config_hash: record.config_hash,
    profile_hash: record.profile.hash,
    eligible: dossiers[0]?.rankings.eligible ?? 0,
    top,
    duration_ms: input.durationMs,
  };
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The job directory of `token`; refuses tokens that are not plain names. */
export function jobDirOf(jobsRoot: string, token: string): string {
  if (!TOKEN.test(token))
    throw new WorkerFailure("invalid-change", `token ${token} is not a plain name`);
  return NodePath.join(jobsRoot, token);
}

/**
 * What a campaign fixes of its executor-side inputs, computed where they live: the corpus'
 * identity (its verified manifest hash) and the model directory's content hash.
 */
export function identifyInputs(input: {
  readonly input_roots: ReadonlyArray<string>;
  readonly corpus_dir: string;
  readonly models_dir: string | null;
}): { readonly corpus_hash: string; readonly models_hash: string | null } {
  const real = canonicalInputs(input.input_roots, [
    { path: input.corpus_dir, kind: "tree" },
    ...(input.models_dir === null ? [] : [{ path: input.models_dir, kind: "tree" as const }]),
  ]);
  return {
    corpus_hash: corpusIdentity(real.get(input.corpus_dir)!),
    models_hash: input.models_dir === null ? null : treeHash(real.get(input.models_dir)!),
  };
}

const dayBefore = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * The job's inputs by canonical path, checked against the sealed partitions, the operator's
 * roots and the identity the campaign fixed by content: the profile's hash, the development
 * corpus' manifest and every file it lists, the model directory's files.
 */
function checkedInputs(spec: JobSpec, options: WorkerOptions) {
  assertNotSealed({
    cutoffs: spec.cutoffs,
    paths: [
      spec.corpus_dir,
      spec.profile_path,
      spec.cache_file ?? "",
      spec.models_dir ?? "",
      options.jobsRoot,
    ],
  });
  if (cutoffDays(spec.cutoffs).join(",") !== spec.cutoffs.join(",")) {
    throw new WorkerFailure("invalid-change", "The cutoffs are not distinct UTC days in order.");
  }
  // Every input by its canonical path, inside the operator's roots, links included.
  const real = canonicalInputs(spec.input_roots, [
    { path: spec.corpus_dir, kind: "tree" },
    { path: spec.profile_path, kind: "file" },
    ...(spec.cache_file === null
      ? []
      : [{ path: spec.cache_file, kind: "optional-file" as const }]),
    ...(spec.models_dir === null ? [] : [{ path: spec.models_dir, kind: "tree" as const }]),
  ]);
  const canonical: JobSpec = {
    ...spec,
    corpus_dir: real.get(spec.corpus_dir)!,
    profile_path: real.get(spec.profile_path)!,
    cache_file: spec.cache_file === null ? null : real.get(spec.cache_file)!,
    models_dir: spec.models_dir === null ? null : real.get(spec.models_dir)!,
  };
  if (sha256(NodeFS.readFileSync(canonical.profile_path)) !== spec.profile_hash) {
    throw new WorkerFailure("artifact-mismatch", "The profile file is not the campaign's.");
  }
  const corpusHash = corpusIdentity(canonical.corpus_dir);
  if (spec.inputs.corpus_hash !== null && corpusHash !== spec.inputs.corpus_hash) {
    throw new WorkerFailure(
      "artifact-mismatch",
      `The corpus at ${spec.corpus_dir} is ${corpusHash}, not the campaign's ${spec.inputs.corpus_hash}.`,
    );
  }
  const modelsHash = canonical.models_dir === null ? null : treeHash(canonical.models_dir);
  if (spec.inputs.models_hash !== null && modelsHash !== spec.inputs.models_hash) {
    throw new WorkerFailure(
      "artifact-mismatch",
      `The models at ${spec.models_dir} are ${modelsHash}, not the campaign's ${spec.inputs.models_hash}.`,
    );
  }
  return { canonical, corpusHash, modelsHash };
}

/**
 * Runs `spec` once per token. A second call with the same token answers the first's result,
 * once its inputs check again against the campaign's and its views against the corpus; while
 * the first is alive it waits for it rather than starting another.
 */
export async function evaluateJob(spec: JobSpec, options: WorkerOptions): Promise<WorkerResult> {
  const jobDir = jobDirOf(options.jobsRoot, spec.token);
  NodeFS.mkdirSync(jobDir, { recursive: true });
  const resultFile = NodePath.join(jobDir, "result.json");
  const lockFile = NodePath.join(jobDir, "lock");
  const readResult = () => JSON.parse(NodeFS.readFileSync(resultFile, "utf8")) as WorkerResult;
  const now = () => options.now?.() ?? Date.now();
  const sandbox = options.sandbox ?? (bwrapAvailable() ? "bwrap" : "none");
  const executor = { host: NodeOS.hostname(), node: process.version, sandbox };
  const empty = { reference: [], candidate: [] };
  const base = {
    schema: RESULT_SCHEMA,
    token: spec.token,
    spec_sha256: specHash(spec),
    reference_hash: spec.reference.manifest_hash,
    candidate_hash: spec.candidate.manifest_hash,
    executor,
  } as const;
  const failure = (error: unknown): WorkerResult => {
    const code =
      error instanceof WorkerFailure || error instanceof LabPolicyError
        ? error.code
        : "engine-failed";
    const message = error instanceof Error ? error.message : String(error);
    return signResult(spec.secret, {
      ...base,
      status: "failed",
      error: { code, message },
      inputs: { corpus_hash: null, models_hash: null, cache_sha256: null },
      views: [],
      arms: empty,
    });
  };
  /** A stored result, only while its inputs are still the ones it was computed from. */
  const recovered = (stored: WorkerResult): WorkerResult => {
    if (stored.status !== "ok") return stored;
    try {
      const { canonical, corpusHash, modelsHash } = checkedInputs(spec, options);
      if (stored.inputs?.models_hash !== modelsHash)
        throw new WorkerFailure("artifact-mismatch", "The models changed since the result.");
      if (spec.inputs.corpus_hash === null) {
        // A shadow's corpus grows; the days each view held must not have changed.
        const recheck = NodePath.join(jobDir, "recheck");
        for (const view of stored.views ?? []) {
          const again = buildView({
            corpusDir: canonical.corpus_dir,
            cutoff: view.cutoff,
            out: NodePath.join(recheck, view.cutoff.slice(0, 10)),
          });
          if (again.corpus_hash !== view.corpus_hash) {
            throw new WorkerFailure(
              "artifact-mismatch",
              `The corpus before ${view.cutoff.slice(0, 10)} changed since the result.`,
            );
          }
        }
        NodeFS.rmSync(recheck, { recursive: true, force: true });
      } else if (stored.inputs?.corpus_hash !== corpusHash) {
        throw new WorkerFailure("artifact-mismatch", "The corpus changed since the result.");
      }
      return stored;
    } catch (error) {
      return failure(error);
    }
  };
  for (;;) {
    if (NodeFS.existsSync(resultFile)) return recovered(readResult());
    try {
      NodeFS.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch {
      const holder = Number(NodeFS.readFileSync(lockFile, "utf8").trim());
      if (Number.isInteger(holder) && holder !== process.pid && pidAlive(holder)) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      NodeFS.rmSync(lockFile, { force: true });
    }
  }
  NodeFS.writeFileSync(NodePath.join(jobDir, "pgid"), `${process.pid}\n`);
  let result: WorkerResult;
  try {
    // A shadow observes the product's days as they pass: a cutoff still ahead is never run.
    if (spec.kind === "shadow") {
      const ahead = spec.cutoffs.filter((cutoff) => Date.parse(cutoff) > now());
      if (ahead.length > 0) {
        throw new WorkerFailure(
          "insufficient-evidence",
          `Shadow cutoffs ${ahead.map((c) => c.slice(0, 10)).join(", ")} have not passed yet.`,
        );
      }
    }
    const { canonical, corpusHash, modelsHash } = checkedInputs(spec, options);
    const codeArms = (["reference", "candidate"] as const).filter(
      (side) => Object.keys(spec[side].files).length > 0,
    );
    if (codeArms.length > 0 && spec.sandbox === "required" && sandbox !== "bwrap") {
      throw new WorkerFailure(
        "executor-unavailable",
        "A code candidate needs bwrap on the executor, which has none.",
      );
    }
    // One view per cutoff, made here before any arm runs; both arms read the same one.
    const views = spec.cutoffs.map((cutoff) => {
      const view = buildView({
        corpusDir: canonical.corpus_dir,
        cutoff,
        out: NodePath.join(jobDir, "views", cutoff.slice(0, 10)),
      });
      if (spec.kind === "shadow" && view.last_covered_day !== dayBefore(cutoff.slice(0, 10))) {
        throw new WorkerFailure(
          "insufficient-evidence",
          `The corpus does not cover ${dayBefore(cutoff.slice(0, 10))} yet: the shadow cutoff ${cutoff.slice(0, 10)} is not closed.`,
        );
      }
      return { view, observed_at: new Date(now()).toISOString() };
    });
    const cacheSha =
      canonical.cache_file !== null && NodeFS.existsSync(canonical.cache_file)
        ? fileHash(canonical.cache_file)
        : null;
    const arms: Record<ArmSide, Array<ArmOutput>> = { reference: [], candidate: [] };
    for (const side of ["reference", "candidate"] as const) {
      const engineSrc = prepareTree(spec, side, jobDir, options);
      // A code candidate writes embeddings only to its own copy of the cache.
      let cacheFile = canonical.cache_file;
      if (cacheFile !== null && Object.keys(spec[side].files).length > 0) {
        const own = NodePath.join(jobDir, `${side}-cache`, NodePath.basename(cacheFile));
        NodeFS.mkdirSync(NodePath.dirname(own), { recursive: true });
        if (NodeFS.existsSync(cacheFile)) NodeFS.copyFileSync(cacheFile, own);
        cacheFile = own;
      }
      for (const { view } of views) {
        options.log?.(JSON.stringify({ phase: "arm", side, cutoff: view.cutoff }));
        arms[side].push(
          runArm({
            spec: canonical,
            side,
            cutoff: view.cutoff,
            engineSrc,
            jobDir,
            sandbox,
            cacheFile,
            options,
            view,
            index: indexCorpus(view.dir, view.cutoff.slice(0, 10)),
          }),
        );
      }
    }
    // The views as the arms left them: read-only to them, checked again before signing.
    const records: Array<ViewRecord> = views.map(({ view, observed_at }) => {
      if (corpusIdentity(view.dir) !== view.corpus_hash) {
        throw new WorkerFailure("artifact-mismatch", `The view of ${view.cutoff} changed.`);
      }
      return { cutoff: view.cutoff, corpus_hash: view.corpus_hash, files: view.files, observed_at };
    });
    result = signResult(spec.secret, {
      ...base,
      status: "ok",
      error: null,
      inputs: { corpus_hash: corpusHash, models_hash: modelsHash, cache_sha256: cacheSha },
      views: records,
      arms,
    });
  } catch (error) {
    result = failure(error);
  }
  // A shadow that ran too early is not a result: the same token may run once its days pass.
  if (result.error?.code !== "insufficient-evidence") {
    const tmp = `${resultFile}.${process.pid}.tmp`;
    NodeFS.writeFileSync(tmp, `${JSON.stringify(result)}\n`);
    NodeFS.renameSync(tmp, resultFile);
  }
  NodeFS.rmSync(lockFile, { force: true });
  return result;
}

/**
 * Ends the job's worker and every arm in its process group, after checking that the group
 * leader still is that worker (its command line carries the token).
 */
export function cancelJob(jobsRoot: string, token: string): "cancelled" | "not-running" {
  const jobDir = jobDirOf(jobsRoot, token);
  const pgidFile = NodePath.join(jobDir, "pgid");
  if (!NodeFS.existsSync(pgidFile)) return "not-running";
  const pgid = Number(NodeFS.readFileSync(pgidFile, "utf8").trim());
  if (!Number.isInteger(pgid) || pgid <= 1 || !pidAlive(pgid)) return "not-running";
  const cmdline = (() => {
    try {
      return NodeFS.readFileSync(`/proc/${pgid}/cmdline`, "utf8").split("\0");
    } catch {
      return [];
    }
  })();
  if (!cmdline.includes(token)) return "not-running";
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    return "not-running";
  }
  NodeFS.writeFileSync(NodePath.join(jobDir, "cancelled"), `${new Date().toISOString()}\n`);
  return "cancelled";
}
