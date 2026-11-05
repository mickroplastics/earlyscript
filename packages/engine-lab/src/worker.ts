// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off - the trusted executor, a plain Node program.
// The trusted side of an evaluation: it checks the job against the sealed partitions, builds a
// code candidate's tree, runs every arm (in bwrap without network when available), checks what
// each arm wrote against the corpus and returns the signed outputs. It never sees labels.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { memberKey } from "./compare.ts";
import { engineSourceHash, sha256 } from "./hash.ts";
import { assertNotSealed, LabPolicyError } from "./policy.ts";
import {
  type ArmOutput,
  type ArmSide,
  type ArmTrend,
  type JobSpec,
  RESULT_SCHEMA,
  signResult,
  specHash,
  type WorkerResult,
} from "./result.ts";

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

const nodeDir = () => NodePath.dirname(process.execPath);

/** bwrap arguments: no network, a read-only system, a hidden /home except what the arm needs. */
function sandboxArgs(input: {
  readonly readOnly: ReadonlyArray<string>;
  readonly writable: ReadonlyArray<string>;
  readonly out: string;
}): Array<string> {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  for (const hidden of ["/home", "/root", "/tmp", "/mnt", "/media", "/srv", "/var/tmp"]) {
    if (NodeFS.existsSync(hidden)) args.push("--tmpfs", hidden);
  }
  const seen = new Set<string>();
  for (const path of [nodeDir(), ...input.readOnly]) {
    if (seen.has(path) || !NodeFS.existsSync(path)) continue;
    seen.add(path);
    args.push("--ro-bind", path, path);
  }
  for (const path of [...input.writable, input.out]) {
    args.push("--bind", path, path);
  }
  args.push(
    "--clearenv",
    "--setenv",
    "PATH",
    `${nodeDir()}:/usr/bin:/bin`,
    "--setenv",
    "HOME",
    input.out,
  );
  args.push("--chdir", input.out);
  return args;
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
      corpus_dir: spec.corpus_dir,
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
  const nodeArgs = [armScript, "--spec", armSpec];
  const root = input.options.engineRoot;
  const readOnly = [
    NodePath.join(root, "node_modules"),
    NodePath.join(root, "packages", "trend-engine"),
    NodePath.join(root, "packages", "editorial-contracts"),
    NodePath.dirname(armScript),
    spec.corpus_dir,
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
  const child = NodeChildProcess.spawnSync(command, args, {
    stdio: ["ignore", log, log],
    cwd: out,
    // Outside the sandbox the arm still gets no secret: the spec stays in this process.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: out, ELECTRON_RUN_AS_NODE: "1" },
  });
  NodeFS.closeSync(log);
  const armFile = NodePath.join(out, "arm.json");
  if (child.status !== 0 || !NodeFS.existsSync(armFile)) {
    const tail = NodeFS.readFileSync(NodePath.join(out, "arm.log"), "utf8").slice(-600);
    throw new WorkerFailure(
      "engine-failed",
      `${side} at ${cutoff} exited with ${child.status}: ${tail}`,
    );
  }
  const arm = JSON.parse(NodeFS.readFileSync(armFile, "utf8")) as Omit<
    ArmOutput,
    "cutoff" | "top"
  > & {
    top: ReadonlyArray<Omit<ArmTrend, "member_keys" | "headlines">>;
  };
  const cutoffDay = cutoff.slice(0, 10);
  if (arm.status !== "ok") {
    throw new WorkerFailure(
      "engine-failed",
      `${side} at ${cutoffDay}: the run is ${arm.status}: ${JSON.stringify((arm as { error?: unknown }).error ?? null)}`,
    );
  }
  const top: Array<ArmTrend> = arm.top.map((trend) => {
    const items = trend.item_ids.map((id) => {
      const item = input.index.get(id);
      if (item === undefined) {
        throw new WorkerFailure(
          "artifact-mismatch",
          `${side} at ${cutoffDay} emitted ${id}, which the corpus has not before the cutoff.`,
        );
      }
      if (item.published_at.slice(0, 10) >= cutoffDay) {
        throw new WorkerFailure(
          "artifact-mismatch",
          `${side} at ${cutoffDay} emitted ${id}, published after the cutoff.`,
        );
      }
      return item;
    });
    return {
      ...trend,
      member_keys: items.map(memberKey),
      headlines: items
        .toSorted((a, b) =>
          a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0,
        )
        .slice(0, 5)
        .map(({ title, source, published_at }) => ({ title, source, published_at })),
    };
  });
  return {
    cutoff,
    run_id: arm.run_id,
    status: arm.status,
    logical_hash: arm.logical_hash ?? "",
    config_hash: arm.config_hash,
    profile_hash: arm.profile_hash,
    eligible: arm.eligible,
    top,
    duration_ms: arm.duration_ms,
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
 * Runs `spec` once per token. A second call with the same token answers the first's result;
 * while the first is alive it waits for it rather than starting another.
 */
export async function evaluateJob(spec: JobSpec, options: WorkerOptions): Promise<WorkerResult> {
  const jobDir = jobDirOf(options.jobsRoot, spec.token);
  NodeFS.mkdirSync(jobDir, { recursive: true });
  const resultFile = NodePath.join(jobDir, "result.json");
  const lockFile = NodePath.join(jobDir, "lock");
  const readResult = () => JSON.parse(NodeFS.readFileSync(resultFile, "utf8")) as WorkerResult;
  for (;;) {
    if (NodeFS.existsSync(resultFile)) return readResult();
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
  let result: WorkerResult;
  try {
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
    if (sha256(NodeFS.readFileSync(spec.profile_path)) !== spec.profile_hash) {
      throw new WorkerFailure("artifact-mismatch", "The profile file is not the campaign's.");
    }
    const codeArms = (["reference", "candidate"] as const).filter(
      (side) => Object.keys(spec[side].files).length > 0,
    );
    if (codeArms.length > 0 && spec.sandbox === "required" && sandbox !== "bwrap") {
      throw new WorkerFailure(
        "executor-unavailable",
        "A code candidate needs bwrap on the executor, which has none.",
      );
    }
    const lastDay =
      spec.cutoffs
        .map((cutoff) => cutoff.slice(0, 10))
        .toSorted()
        .at(-1) ?? "0000-00-00";
    const index = indexCorpus(spec.corpus_dir, lastDay);
    const arms: Record<ArmSide, Array<ArmOutput>> = { reference: [], candidate: [] };
    for (const side of ["reference", "candidate"] as const) {
      const engineSrc = prepareTree(spec, side, jobDir, options);
      // A code candidate writes embeddings only to its own copy of the cache.
      let cacheFile = spec.cache_file;
      if (cacheFile !== null && Object.keys(spec[side].files).length > 0) {
        const own = NodePath.join(jobDir, `${side}-cache`, NodePath.basename(cacheFile));
        NodeFS.mkdirSync(NodePath.dirname(own), { recursive: true });
        if (NodeFS.existsSync(cacheFile)) NodeFS.copyFileSync(cacheFile, own);
        cacheFile = own;
      }
      for (const cutoff of spec.cutoffs) {
        options.log?.(JSON.stringify({ phase: "arm", side, cutoff }));
        arms[side].push(
          runArm({ spec, side, cutoff, engineSrc, jobDir, sandbox, cacheFile, options, index }),
        );
      }
    }
    result = signResult(spec.secret, { ...base, status: "ok", error: null, arms });
  } catch (error) {
    const code =
      error instanceof WorkerFailure || error instanceof LabPolicyError
        ? error.code
        : "engine-failed";
    const message = error instanceof Error ? error.message : String(error);
    result = signResult(spec.secret, {
      ...base,
      status: "failed",
      error: { code, message },
      arms: empty,
    });
  }
  const tmp = `${resultFile}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(result)}\n`);
  NodeFS.renameSync(tmp, resultFile);
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
