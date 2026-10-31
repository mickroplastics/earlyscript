// @effect-diagnostics nodeBuiltinImport:off - the tests run a stand-in engine script and lay out its files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DEFAULT_CONFIG_PATH } from "@earlyscript/trend-engine/run";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EditorialPresentationError, EditorialRunId, type EditorialJob } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { SINGULARIDEV_PROFILE_V1 } from "./channelProfile.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import * as EditorialJobsService from "./EditorialJobsService.ts";
import { EditorialPresentationService } from "./EditorialPresentationService.ts";
import * as EditorialSourcesService from "./EditorialSourcesService.ts";
import { addDays } from "./nightlySchedule.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import {
  makeTempDir,
  removeDir,
  withEditorialDatabase,
} from "./persistence/EditorialDatabase.testkit.ts";
import { EditorialRunDirectory } from "./RunDirectory.ts";

// Stands in for packages/trend-engine/src/cli.ts: writes the files the real commands write
// and appends each command to trace.log. A `fail-<command>` file next to it makes it fail; a
// `slow-run` file holds how many milliseconds `run` takes. `run` records in events.log when it
// finishes, when it is killed and when it starts while another `run` is still alive.
const FAKE_ENGINE = String.raw`
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import url from "node:url";

const [command, ...rest] = process.argv.slice(2);
const opt = (name) => rest[rest.indexOf("--" + name) + 1];
const here = path.dirname(url.fileURLToPath(import.meta.url));
const trace = (line) => fs.appendFileSync(path.join(here, "trace.log"), line + "\n");
const failing = (name) => fs.existsSync(path.join(here, "fail-" + name));
const sha = (data) => "sha256:" + crypto.createHash("sha256").update(data).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
const daysBetween = (from, to) => {
  const days = [];
  for (let ms = Date.parse(from + "T00:00:00Z"); ms < Date.parse(to + "T00:00:00Z"); ms += 86400000) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
};

if (command === "collect") {
  trace("collect " + opt("from") + " " + opt("to") + " " + opt("sources"));
  if (failing("collect")) {
    console.error("collect broke");
    process.exit(1);
  }
  const dir = opt("corpus");
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "corpus-manifest.json");
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  const toDay = previous && previous.to_day > opt("to") ? previous.to_day : opt("to");
  const fromDay = previous && previous.from_day < opt("from") ? previous.from_day : opt("from");
  fs.writeFileSync(manifestPath, JSON.stringify({ schema_version: "corpus/1", from_day: fromDay, to_day: toDay, files: [] }));
  const rows = opt("sources").split(",").flatMap((source) =>
    daysBetween(opt("from"), opt("to")).map((day) => ({ source, day, status: "complete", items: 2, retrieved_at: new Date().toISOString(), note: null })),
  );
  console.log(JSON.stringify(rows));
} else if (command === "run") {
  trace("run");
  const event = (line) => fs.appendFileSync(path.join(here, "events.log"), line + "\n");
  const running = path.join(here, "engine-running");
  try {
    fs.closeSync(fs.openSync(running, "wx"));
  } catch {
    event("OVERLAP");
  }
  process.on("SIGTERM", () => {
    fs.rmSync(running, { force: true });
    event("run killed");
    process.exit(143);
  });
  const slow = path.join(here, "slow-run");
  if (fs.existsSync(slow)) await new Promise((resolve) => setTimeout(resolve, Number(fs.readFileSync(slow, "utf8"))));
  fs.rmSync(running, { force: true });
  console.error(JSON.stringify({ phase: "embed", inferred: 1, total: 2 }));
  if (failing("run")) {
    console.error("run broke");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(opt("config"), "utf8"));
  const cutoff = new Date(Date.parse(opt("cutoff"))).toISOString();
  const runId = "run_" + cutoff.slice(0, 10).replaceAll("-", "") + "_" + process.pid;
  fs.mkdirSync(path.join(opt("out"), runId), { recursive: true });
  fs.writeFileSync(
    path.join(opt("out"), runId, "run.json"),
    JSON.stringify({
      run_id: runId,
      status: "ok",
      cutoff_at: cutoff,
      config_hash: sha(canonical(config)),
      started_at: new Date().toISOString(),
      profile: { hash: sha(fs.readFileSync(opt("profile"))) },
    }),
  );
  console.log(JSON.stringify({ run_id: runId, status: "ok", error: null, dossiers: 3 }));
  event("run done");
} else if (command === "check") {
  trace("check");
  console.log(JSON.stringify({ ok: !failing("check") }));
  process.exitCode = failing("check") ? 1 : 0;
}
`;

const makeFixture = () => {
  const root = makeTempDir();
  const engine = NodePath.join(root, "engine.mjs");
  NodeFS.writeFileSync(engine, FAKE_ENGINE);
  const runsDir = NodePath.join(root, "runs");
  NodeFS.mkdirSync(runsDir);
  const traceFile = NodePath.join(root, "trace.log");
  return {
    root,
    engine,
    runsDir,
    corpusDir: NodePath.join(root, "corpus"),
    mark: (line: string) => NodeFS.appendFileSync(traceFile, `${line}\n`),
    trace: () =>
      NodeFS.existsSync(traceFile)
        ? NodeFS.readFileSync(traceFile, "utf8").split("\n").filter(Boolean)
        : [],
    flag: (name: string, on: boolean) => {
      const file = NodePath.join(root, `fail-${name}`);
      if (on) NodeFS.writeFileSync(file, "");
      else NodeFS.rmSync(file, { force: true });
    },
    slowRun: (ms: number | null) => {
      const file = NodePath.join(root, "slow-run");
      if (ms === null) NodeFS.rmSync(file, { force: true });
      else NodeFS.writeFileSync(file, String(ms));
    },
    events: () => {
      const file = NodePath.join(root, "events.log");
      return NodeFS.existsSync(file)
        ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean)
        : [];
    },
    runDirs: () => NodeFS.readdirSync(runsDir).filter((name) => name.startsWith("run_")),
    /** Presentations: the first `awaitRun` waits for this before answering. */
    holdFirstDraft: null as Promise<void> | null,
  };
};

type Fixture = ReturnType<typeof makeFixture>;

const progressOf = (runId: string) => ({
  runId: EditorialRunId.make(runId),
  status: "idle" as const,
  total: 3,
  ready: 3,
  failed: 0,
  startedAt: null,
  finishedAt: null,
});

/** The jobs service over a fresh database, the stand-in engine, and doubles that trace. */
const withJobs = <A, E>(
  fx: Fixture,
  body: Effect.Effect<A, E, EditorialJobsService.EditorialJobsService | EditorialSql>,
  options: {
    readonly timing?: Partial<EditorialJobsService.EditorialJobsOptions>;
    readonly draftFails?: boolean;
  } = {},
) => {
  let draftsAwaited = 0;
  const jobs = EditorialJobsService.layerWith({
    engine: { cli: fx.engine, defaultConfig: DEFAULT_CONFIG_PATH },
    jobsDir: NodePath.join(fx.root, "jobs"),
    profilePath: NodePath.join(fx.root, "profile.json"),
    cacheFile: NodePath.join(fx.root, "embeddings.sqlite"),
    modelsDir: null,
    ...EditorialJobsService.DEFAULT_JOB_TIMING,
    pollMs: 50,
    ...options.timing,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        EditorialSourcesService.layerWithCorpusDir(fx.corpusDir),
        Layer.mock(EditorialImportService)({
          sync: Effect.sync(() => {
            fx.mark("import");
            return { runs: [], returned: [] };
          }),
        }),
        Layer.mock(EditorialPresentationService)({
          startRun: (runId) =>
            Effect.suspend(() => {
              fx.mark("presentations");
              return options.draftFails === true
                ? Effect.fail(
                    new EditorialPresentationError({
                      reason: "generation-failed",
                      message: "no provider",
                    }),
                  )
                : Effect.succeed(progressOf(runId));
            }),
          runProgress: (runId) => Effect.succeed(progressOf(runId)),
          awaitRun: (runId) => {
            draftsAwaited += 1;
            const hold = draftsAwaited === 1 ? fx.holdFirstDraft : null;
            return hold === null
              ? Effect.succeed(progressOf(runId))
              : Effect.promise(() => hold).pipe(Effect.as(progressOf(runId)));
          },
        }),
        Layer.mock(EditorialRunDirectory)({ runsDir: fx.runsDir }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return withEditorialDatabase(body.pipe(Effect.provide(jobs))).pipe(
    Effect.ensuring(removeDir(fx.root)),
  );
};

/** Resolves once trace.log holds `count` lines equal to `line`; watches, never polls. */
const traceReaches = (fx: Fixture, line: string, count = 1) =>
  Effect.callback<void>((resume) => {
    const reached = () => fx.trace().filter((entry) => entry === line).length >= count;
    const watcher = NodeFS.watch(fx.root, () => {
      if (reached()) resume(Effect.void);
    });
    if (reached()) resume(Effect.void);
    return Effect.sync(() => watcher.close());
  });

const leaseOf = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const rows = yield* sql<{
    readonly lease_owner: string | null;
    readonly lease_generation: number;
  }>`
    SELECT lease_owner, lease_generation FROM editorial_jobs
  `;
  return rows[0];
});

const onlyJob = Effect.gen(function* () {
  const jobs = yield* EditorialJobsService.EditorialJobsService;
  const { jobs: list } = yield* jobs.list;
  assert.strictEqual(list.length, 1);
  return list[0] as EditorialJob;
});

const phaseStatuses = (job: EditorialJob) => job.artifacts.phases.map((phase) => phase.status);

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("EditorialJobsService", () => {
  it.live("runs capture, engine, check, import and presentations in order, once per key", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const created = yield* jobs.runNow;
        assert.strictEqual((yield* jobs.runNow).jobId, created.jobId);
        yield* jobs.runDue;

        const job = yield* onlyJob;
        const today = job.cutoffAt.slice(0, 10);
        assert.deepStrictEqual(fx.trace(), [
          `collect ${addDays(today, -28)} ${today} hn,github`,
          "run",
          "check",
          "import",
          "presentations",
        ]);
        assert.strictEqual(job.status, "done");
        assert.strictEqual(job.attempt, 1);
        assert.deepStrictEqual(phaseStatuses(job), ["done", "done", "done", "done", "done"]);
        assert.match(job.artifacts.runId ?? "", /^run_/);
        assert.strictEqual(job.artifacts.dossiers, 3);
        assert.deepStrictEqual(job.artifacts.presentations, { ready: 3, failed: 0, total: 3 });
        assert.isNull(job.artifacts.progress);

        // A finished job is answered as it is; nothing runs again.
        assert.strictEqual((yield* jobs.runNow).status, "done");
        yield* jobs.runDue;
        assert.strictEqual(fx.trace().length, 5);
      }),
    );
  });

  it.live("shares one job between the scheduled time and Ejecutar ahora", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        // On at 00:00 UTC, but only since a moment that has not come: nothing is due yet.
        yield* sql`
          INSERT INTO editorial_nightly_settings (
            id, enabled, time_of_day, timezone, workers, enabled_at, updated_at
          ) VALUES (1, 1, '00:00', 'UTC', 2, ${FUTURE}, ${PAST})
        `;
        yield* jobs.runDue;
        assert.strictEqual((yield* jobs.list).jobs.length, 0);

        yield* sql`UPDATE editorial_nightly_settings SET enabled_at = ${PAST}`;
        yield* jobs.runDue;
        const scheduled = yield* onlyJob;
        assert.strictEqual(scheduled.status, "done");
        assert.strictEqual(scheduled.scheduledFor, scheduled.cutoffAt);

        assert.strictEqual((yield* jobs.runNow).jobId, scheduled.jobId);
        yield* jobs.runDue;
        yield* onlyJob;
        assert.strictEqual(fx.trace().filter((line) => line === "run").length, 1);
      }),
    );
  });

  it.live("keeps a live lease, and resumes a lapsed one from the phase that is missing", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        const job = yield* jobs.runNow;
        // A process died after the engine wrote its run and before it was recorded.
        const artifacts = {
          ...job.artifacts,
          phases: job.artifacts.phases.map((phase) =>
            phase.phase === "collect"
              ? { ...phase, status: "done", startedAt: PAST, finishedAt: PAST }
              : phase.phase === "run"
                ? { ...phase, status: "running", startedAt: PAST }
                : phase,
          ),
        };
        yield* sql`
          UPDATE editorial_jobs SET
            status = 'running', attempt = 1, started_at = ${PAST}, lease_until = ${FUTURE},
            artifacts_json = ${JSON.stringify(artifacts)}
          WHERE job_id = ${job.jobId}
        `;
        const runId = "run_crashed";
        NodeFS.mkdirSync(NodePath.join(fx.runsDir, runId));
        NodeFS.writeFileSync(
          NodePath.join(fx.runsDir, runId, "run.json"),
          JSON.stringify({
            run_id: runId,
            status: "ok",
            cutoff_at: job.cutoffAt,
            config_hash: job.configHash,
            started_at: "2000-01-01T00:01:00.000Z",
            profile: { hash: job.profileHash },
          }),
        );

        yield* jobs.runDue;
        assert.deepStrictEqual(fx.trace(), []);

        yield* sql`UPDATE editorial_jobs SET lease_until = ${PAST} WHERE job_id = ${job.jobId}`;
        yield* jobs.runDue;
        assert.deepStrictEqual(fx.trace(), ["check", "import", "presentations"]);
        const resumed = yield* onlyJob;
        assert.strictEqual(resumed.status, "done");
        assert.strictEqual(resumed.attempt, 2);
        assert.strictEqual(resumed.artifacts.runId, runId);
      }),
    );
  });

  it.live("backfills from the last captured day with one job at today's cutoff", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const job = yield* jobs.runNow;
        const today = job.cutoffAt.slice(0, 10);
        NodeFS.mkdirSync(fx.corpusDir);
        NodeFS.writeFileSync(
          NodePath.join(fx.corpusDir, "corpus-manifest.json"),
          JSON.stringify({
            schema_version: "corpus/1",
            from_day: addDays(today, -30),
            to_day: addDays(today, -3),
            files: [],
          }),
        );
        yield* jobs.runDue;

        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.strictEqual(fx.trace()[0], `collect ${addDays(today, -4)} ${today} hn,github`);
        assert.deepStrictEqual(done.artifacts.collect?.missedDays, [
          addDays(today, -3),
          addDays(today, -2),
        ]);
        assert.isTrue(done.artifacts.notes.some((note) => note.startsWith("Backfill:")));
        assert.deepStrictEqual(done.artifacts.notices, [
          { code: "missed_days", days: [addDays(today, -3), addDays(today, -2)] },
        ]);
      }),
    );
  });

  it.live("retries a failed phase later without capturing again", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        fx.flag("run", true);
        const job = yield* jobs.runNow;
        yield* jobs.runDue;

        const failed = yield* onlyJob;
        assert.strictEqual(failed.status, "pending");
        assert.include(failed.error ?? "", "run broke");
        assert.deepStrictEqual(failed.artifacts.failure, { code: "engine_failed", phase: "run" });
        assert.isTrue(failed.scheduledFor > job.scheduledFor);
        assert.deepStrictEqual(phaseStatuses(failed), [
          "done",
          "failed",
          "pending",
          "pending",
          "pending",
        ]);
        yield* jobs.runDue;
        assert.deepStrictEqual(fx.trace().slice(1), ["run"]);

        fx.flag("run", false);
        yield* sql`UPDATE editorial_jobs SET scheduled_for = ${PAST} WHERE job_id = ${job.jobId}`;
        yield* jobs.runDue;
        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.isNull(done.error);
        assert.isNull(done.artifacts.failure);
        assert.deepStrictEqual(fx.trace().slice(1), [
          "run",
          "run",
          "check",
          "import",
          "presentations",
        ]);
      }),
    );
  });

  it.live("finishes with presentations pending when no provider can draft", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        yield* jobs.runNow;
        yield* jobs.runDue;
        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.strictEqual(done.attempt, 1);
        assert.deepStrictEqual(done.artifacts.notices, [{ code: "presentations_unavailable" }]);
      }),
      { draftFails: true },
    );
  });

  it.live("replaces a job whose engine sources changed before it ran", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        const first = yield* jobs.runNow;
        yield* sql`
          INSERT INTO editorial_source_settings (source, collect, rank, backtest_run_id, updated_at)
          VALUES ('github', 1, 0, NULL, ${PAST})
        `;
        yield* jobs.runDue;
        yield* jobs.runDue;
        const { jobs: list } = yield* jobs.list;
        const replaced = list.find((job) => job.jobId === first.jobId);
        const replacement = list.find((job) => job.jobId !== first.jobId);
        assert.strictEqual(replaced?.status, "skipped");
        assert.deepStrictEqual(replaced?.artifacts.notices, [{ code: "config_changed" }]);
        assert.strictEqual(replacement?.status, "done");
        assert.deepStrictEqual(replacement?.artifacts.sources.rank, ["hn"]);
      }),
    );
  });
});

describe("EditorialJobsService with two owners of one job", () => {
  it.live("a former owner past its lease launches no second engine and writes nothing", () => {
    const fx = makeFixture();
    fx.slowRun(1500);
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        yield* jobs.runNow;
        const former = yield* Effect.forkChild(jobs.runDue);
        yield* traceReaches(fx, "run");
        // The former owner stalls past its lease while its engine child keeps running.
        yield* sql`UPDATE editorial_jobs SET lease_until = ${PAST}`;
        const current = yield* Effect.forkChild(jobs.runDue);
        yield* Fiber.join(current);
        yield* Fiber.join(former);

        assert.deepStrictEqual(fx.trace().slice(1), ["run", "check", "import", "presentations"]);
        assert.notInclude(fx.events(), "OVERLAP");
        assert.strictEqual((yield* leaseOf)?.lease_generation, 2);
        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.strictEqual(done.attempt, 2);
        assert.deepStrictEqual(fx.runDirs(), [done.artifacts.runId]);
        assert.deepStrictEqual(done.artifacts.notices, [{ code: "stale_engine_waited" }]);
      }),
    );
  });

  it.live("a renewal that keeps failing stops the phases and kills the engine in time", () => {
    const fx = makeFixture();
    fx.slowRun(3000);
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        // Only renewals fail: a claim changes the owner, a release clears the lease.
        yield* sql`
          CREATE TRIGGER block_renewal BEFORE UPDATE OF lease_until ON editorial_jobs
          WHEN OLD.status = 'running' AND NEW.lease_owner = OLD.lease_owner
            AND NEW.lease_until > OLD.lease_until
          BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
        `;
        yield* jobs.runNow;
        yield* jobs.runDue;
        assert.deepStrictEqual(fx.events(), ["run killed"]);
        assert.deepStrictEqual(fx.runDirs(), []);
        const stalled = yield* onlyJob;
        assert.strictEqual(stalled.status, "running");
        assert.strictEqual(
          stalled.artifacts.phases.find((phase) => phase.phase === "run")?.status,
          "running",
        );

        yield* sql`DROP TRIGGER block_renewal`;
        fx.slowRun(null);
        yield* sql`UPDATE editorial_jobs SET lease_until = ${PAST}`;
        yield* jobs.runDue;
        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.notInclude(fx.events(), "OVERLAP");
        assert.strictEqual(fx.runDirs().length, 1);
      }),
      { timing: { leaseMs: 600, heartbeatMs: 100 } },
    );
  });

  it.live("a late finish from the former owner leaves the current owner's result", () => {
    const fx = makeFixture();
    let releaseDraft = () => {};
    fx.holdFirstDraft = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        yield* jobs.runNow;
        const former = yield* Effect.forkChild(jobs.runDue);
        yield* traceReaches(fx, "presentations");
        yield* sql`UPDATE editorial_jobs SET lease_until = ${PAST}`;
        yield* jobs.runDue;
        const current = yield* onlyJob;
        assert.strictEqual(current.status, "done");

        releaseDraft();
        yield* Fiber.join(former);
        assert.deepStrictEqual(yield* onlyJob, current);
        assert.strictEqual((yield* leaseOf)?.lease_generation, 2);
        assert.strictEqual(fx.trace().filter((line) => line === "run").length, 1);
      }),
    );
  });

  it.live("after a crash, the recovery waits for the orphaned engine and adopts its run", () => {
    const fx = makeFixture();
    fx.slowRun(1200);
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        const job = yield* jobs.runNow;
        const jobDir = job.artifacts.jobDir;
        NodeFS.mkdirSync(jobDir, { recursive: true });
        // What a server killed mid-run leaves: its claim, its lock and its engine child.
        const config = JSON.parse(NodeFS.readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as object;
        const configFile = NodePath.join(jobDir, "engine-config.g1.json");
        NodeFS.writeFileSync(configFile, JSON.stringify({ ...config, sources: ["hn", "github"] }));
        const profileFile = NodePath.join(fx.root, "profile.json");
        NodeFS.writeFileSync(profileFile, SINGULARIDEV_PROFILE_V1);
        const orphan = NodeChildProcess.spawn(
          process.execPath,
          [
            fx.engine,
            "run",
            "--corpus",
            fx.corpusDir,
            "--cutoff",
            job.cutoffAt,
            "--profile",
            profileFile,
            "--out",
            fx.runsDir,
            "--config",
            configFile,
            "--lock-token",
            `${job.jobId}:dead-server:1`,
          ],
          { stdio: "ignore" },
        );
        const exited = new Promise<void>((resolve) => orphan.once("exit", () => resolve()));
        NodeFS.mkdirSync(NodePath.join(jobDir, "engine.lock.d"));
        NodeFS.writeFileSync(
          NodePath.join(jobDir, "engine.lock.d", "dead-server-g1.json"),
          JSON.stringify({
            owner: "dead-server",
            generation: 1,
            token: `${job.jobId}:dead-server:1`,
            pid: orphan.pid,
          }),
        );
        const artifacts = {
          ...job.artifacts,
          phases: job.artifacts.phases.map((phase) =>
            phase.phase === "collect"
              ? { ...phase, status: "done", startedAt: PAST, finishedAt: PAST }
              : phase.phase === "run"
                ? { ...phase, status: "running", startedAt: PAST }
                : phase,
          ),
        };
        yield* sql`
          UPDATE editorial_jobs SET
            status = 'running', attempt = 1, started_at = ${PAST}, lease_until = ${PAST},
            lease_owner = 'dead-server', lease_generation = 1,
            artifacts_json = ${JSON.stringify(artifacts)}
          WHERE job_id = ${job.jobId}
        `;
        yield* traceReaches(fx, "run");

        yield* jobs.runDue;
        yield* Effect.promise(() => exited);
        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.deepStrictEqual(fx.trace(), ["run", "check", "import", "presentations"]);
        assert.deepStrictEqual(fx.events(), ["run done"]);
        assert.deepStrictEqual(fx.runDirs(), [done.artifacts.runId]);
        assert.deepStrictEqual(done.artifacts.notices, [{ code: "stale_engine_waited" }]);
      }),
    );
  });
});
