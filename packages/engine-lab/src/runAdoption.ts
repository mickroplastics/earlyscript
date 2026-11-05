// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - moves a checked run into the product's runs directory.
// An approved artifact's nightly run is written to a private directory; the trusted process
// copies it without following links, checks it names the job's cutoff, configuration and
// profile, and only then places it among the product's runs. The installed engine's `check`
// verifies its dossiers next. The artifact never has write access to the runs directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { snapshotOutput } from "./worker.ts";

const RUN_ID = /^run_[A-Za-z0-9_]+$/;

export function adoptArtifactRun(input: {
  readonly out: string;
  readonly runsDir: string;
  readonly runId: string;
  readonly expect: {
    readonly cutoff_at: string;
    readonly config_hash: string;
    readonly profile_hash: string;
    readonly profile_path: string;
  };
}): string {
  if (!RUN_ID.test(input.runId)) throw new Error(`${input.runId} is not a run id.`);
  const target = NodePath.join(input.runsDir, input.runId);
  if (NodeFS.existsSync(target))
    throw new Error(`${input.runId} is already in the runs directory.`);
  NodeFS.mkdirSync(input.runsDir, { recursive: true });
  const incoming = NodePath.join(input.runsDir, `.incoming-${input.runId}-${process.pid}`);
  NodeFS.rmSync(incoming, { recursive: true, force: true });
  try {
    snapshotOutput(NodeFS.realpathSync(input.out), incoming, (message) => new Error(message));
    const runs = NodePath.join(incoming, "runs");
    const names = NodeFS.existsSync(runs)
      ? NodeFS.readdirSync(runs).filter((name) => !name.startsWith("."))
      : [];
    if (names.length !== 1 || names[0] !== input.runId) {
      throw new Error(`expected the run ${input.runId}, found ${names.join(", ") || "none"}.`);
    }
    const record = JSON.parse(
      NodeFS.readFileSync(NodePath.join(runs, input.runId, "run.json"), "utf8"),
    ) as {
      run_id?: unknown;
      status?: unknown;
      cutoff_at?: unknown;
      config_hash?: unknown;
      profile?: { hash?: unknown; path?: unknown };
    };
    const problems = [
      record.run_id !== input.runId && "run_id",
      record.status !== "ok" && "status",
      record.cutoff_at !== input.expect.cutoff_at && "cutoff",
      record.config_hash !== input.expect.config_hash && "configuration",
      record.profile?.hash !== input.expect.profile_hash && "profile",
      record.profile?.path !== NodePath.resolve(input.expect.profile_path) && "profile path",
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(`the run's ${problems.join(", ")} is not the job's.`);
    NodeFS.renameSync(NodePath.join(runs, input.runId), target);
    return input.runId;
  } finally {
    NodeFS.rmSync(incoming, { recursive: true, force: true });
  }
}
