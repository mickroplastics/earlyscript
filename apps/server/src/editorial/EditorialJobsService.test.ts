// @effect-diagnostics nodeBuiltinImport:off - the tests run a stand-in engine script and lay out its files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DEFAULT_CONFIG_PATH } from "@earlyscript/trend-engine/run";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EditorialPresentationError, EditorialRunId, type EditorialJob } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { SINGULARIDEV_PROFILE_V1 } from "./channelProfile.ts";
import { NATIVE_FIXTURE_RUN_ID } from "./editorialLayer.testkit.ts";
import * as EditorialImportService from "./EditorialImportService.ts";
import * as EditorialJobsService from "./EditorialJobsService.ts";
import { EnginePromotionService } from "./EnginePromotionService.ts";
import { engineSourceHash } from "@earlyscript/engine-lab/hash";
import * as EditorialProfileService from "./EditorialProfileService.ts";
import { EditorialPresentationService } from "./EditorialPresentationService.ts";
import * as EditorialSourcesService from "./EditorialSourcesService.ts";
import { addDays } from "./nightlySchedule.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import {
  makeTempDir,
  removeDir,
  withEditorialDatabase,
} from "./persistence/EditorialDatabase.testkit.ts";
import * as RunDirectory from "./RunDirectory.ts";
import { EngineNotFound } from "./engineProcess.ts";

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
  // What the engine process can see of its host: its environment and a file outside its mounts.
  const sentinelPath = path.join(here, "sentinel-path");
  let outside = "none";
  if (fs.existsSync(sentinelPath)) {
    outside = "hidden";
    try {
      fs.readFileSync(fs.readFileSync(sentinelPath, "utf8"));
      outside = "visible";
    } catch {}
  }
  fs.appendFileSync(path.join(here, "env.log"), "env " + Object.keys(process.env).join(",") + " outside=" + outside + "\n");
  const event = (line) => fs.appendFileSync(path.join(here, "events.log"), line + "\n");
  const running = path.join(here, "engine-running");
  try {
    fs.closeSync(fs.openSync(running, "wx"));
  } catch (error) {
    // Only a marker that exists is an overlap; an approved artifact may not create files here.
    if (error.code === "EEXIST") event("OVERLAP");
  }
  // An approved artifact that writes where it may not: each attempt and its outcome.
  const tamper = path.join(here, "tamper");
  if (fs.existsSync(tamper)) {
    for (const target of JSON.parse(fs.readFileSync(tamper, "utf8"))) {
      let outcome = "written";
      try {
        fs.appendFileSync(target, "changed");
      } catch (error) {
        outcome = error.code;
      }
      fs.appendFileSync(path.join(here, "tamper.log"), target + " " + outcome + "\n");
    }
  }
  process.on("SIGTERM", () => {
    try {
      fs.rmSync(running, { force: true });
    } catch {}
    event("run killed");
    process.exit(143);
  });
  const slow = path.join(here, "slow-run");
  if (fs.existsSync(slow)) await new Promise((resolve) => setTimeout(resolve, Number(fs.readFileSync(slow, "utf8"))));
  try {
    fs.rmSync(running, { force: true });
  } catch {}
  console.error(JSON.stringify({ phase: "embed", inferred: 1, total: 2 }));
  if (failing("run")) {
    console.error("run broke");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(opt("config"), "utf8"));
  const cutoff = new Date(Date.parse(opt("cutoff"))).toISOString();
  const runId = "run_" + cutoff.slice(0, 10).replaceAll("-", "") + "_" + process.pid;
  const native = path.join(here, "native-fixture");
  if (fs.existsSync(native)) {
    // A complete native run the importer can read: the fixture under this run's id.
    fs.cpSync(fs.readFileSync(native, "utf8"), path.join(opt("out"), runId), { recursive: true });
    const file = path.join(opt("out"), runId, "run.json");
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...run, run_id: runId, started_at: new Date().toISOString(), profile: { ...run.profile, path: path.resolve(opt("profile")) } }));
  } else {
    fs.mkdirSync(path.join(opt("out"), runId), { recursive: true });
    fs.writeFileSync(
      path.join(opt("out"), runId, "run.json"),
      JSON.stringify({
        run_id: runId,
        status: "ok",
        cutoff_at: cutoff,
        config_hash: sha(canonical(config)),
        started_at: new Date().toISOString(),
        profile: { hash: sha(fs.readFileSync(opt("profile"))), path: path.resolve(opt("profile")) },
      }),
    );
  }
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
    /** Runs once, after the engine command line is logged and before its child is spawned. */
    beforeSpawn: null as Effect.Effect<void> | null,
    /** Runs once, right after a child is spawned and before its pid is published. */
    afterSpawn: null as Effect.Effect<void> | null,
  };
};

type Fixture = ReturnType<typeof makeFixture>;

/** What a claim of the installed engine writes before its launch: its manifest and profile. */
const writeClaimRecord = (
  jobDir: string,
  generation: number,
  job: { readonly configHash: string; readonly profileHash: string },
) => {
  NodeFS.writeFileSync(
    NodePath.join(jobDir, `engine-manifest.g${generation}.json`),
    JSON.stringify({
      manifest_hash: null,
      config_hash: job.configHash,
      profile_hash: job.profileHash,
      code_hash: "",
      generation,
    }),
  );
  NodeFS.writeFileSync(NodePath.join(jobDir, `profile.g${generation}.json`), "{}");
};

const progressOf = (runId: string) => ({
  runId: EditorialRunId.make(runId),
  status: "idle" as const,
  total: 3,
  ready: 3,
  failed: 0,
  startedAt: null,
  finishedAt: null,
});

/**
 * Node services whose engine launch runs the fixture's hooks: after the command line is
 * logged (the claim already published its engine) and right after the child is spawned.
 */
const withSpawnHooks = (fx: Fixture) =>
  Layer.mergeAll(
    Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return {
          ...fs,
          writeFileString: (...args: Parameters<FileSystem.FileSystem["writeFileString"]>) =>
            fs.writeFileString(...args).pipe(
              Effect.tap(() => {
                const hook = args[1].startsWith("$ node") ? fx.beforeSpawn : null;
                if (hook === null) return Effect.void;
                fx.beforeSpawn = null;
                return hook;
              }),
            ),
        } satisfies FileSystem.FileSystem;
      }),
    ),
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return {
          ...spawner,
          spawn: (command) =>
            spawner.spawn(command).pipe(
              Effect.tap(() => {
                const hook = fx.afterSpawn;
                if (hook === null) return Effect.void;
                fx.afterSpawn = null;
                return hook;
              }),
            ),
        } satisfies ChildProcessSpawner.ChildProcessSpawner["Service"];
      }),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));

/** The jobs service over a fresh database, the stand-in engine, and doubles that trace. */
const withJobs = <A, E>(
  fx: Fixture,
  body: Effect.Effect<
    A,
    E,
    | EditorialJobsService.EditorialJobsService
    | EditorialImportService.EditorialImportService
    | EditorialProfileService.EditorialProfileService
    | EditorialSql
  >,
  options: {
    readonly timing?: Partial<EditorialJobsService.EditorialJobsOptions>;
    readonly draftFails?: boolean;
    /** The monthly drafting cap stops the run with one of its three trends drafted. */
    readonly draftCapped?: boolean;
    /** The drafting model's provider is disabled; one of the three trends was drafted before. */
    readonly draftProviderDisabled?: boolean;
    /** The real importer over the fixture's runs directory, instead of a double. */
    readonly realImport?: boolean;
    readonly engine?: EditorialJobsService.EditorialJobsOptions["engine"];
    /** The engine lab's active code, changed by the test: null cli runs the installed engine. */
    readonly code?: { current: { cli: string | null; hash: string | null } };
  } = {},
) => {
  let draftsAwaited = 0;
  const importer =
    options.realImport === true
      ? EditorialImportService.layer.pipe(
          Layer.provideMerge(RunDirectory.layerWithRunsDir(fx.runsDir)),
        )
      : Layer.merge(
          Layer.mock(EditorialImportService.EditorialImportService)({
            sync: Effect.sync(() => {
              fx.mark("import");
              return { runs: [], returned: [] };
            }),
            importRun: (runId) =>
              Effect.sync(() => {
                fx.mark("import");
                return { runId, outcome: "imported" as const };
              }),
          }),
          Layer.mock(RunDirectory.EditorialRunDirectory)({ runsDir: fx.runsDir }),
        );
  // An approved artifact writes only its output: the stand-in's own log files are bound for it,
  // and its cache view is an empty stand-in.
  const standInFiles = ["trace.log", "events.log", "env.log", "tamper.log"].map((name) => {
    const file = NodePath.join(fx.root, name);
    if (!NodeFS.existsSync(file)) NodeFS.writeFileSync(file, "");
    return file;
  });
  const jobs = EditorialJobsService.layerWith({
    artifactExtraWritable: standInFiles,
    prepareArtifactCache: (input) =>
      Effect.sync(() => {
        NodeFS.writeFileSync(input.out, "");
        return input.out;
      }),
    engine:
      options.engine ?? Result.succeed({ cli: fx.engine, defaultConfig: DEFAULT_CONFIG_PATH }),
    jobsDir: NodePath.join(fx.root, "jobs"),
    profilesDir: NodePath.join(fx.root, "profiles"),
    cacheFile: NodePath.join(fx.root, "embeddings.sqlite"),
    modelsDir: null,
    ...EditorialJobsService.DEFAULT_JOB_TIMING,
    pollMs: 50,
    ...options.timing,
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        EditorialSourcesService.layerWithCorpusDir(fx.corpusDir),
        EditorialProfileService.layer,
        importer,
        options.code === undefined
          ? Layer.empty
          : Layer.mock(EnginePromotionService)({
              planEngine: (input) =>
                Effect.sync(() => ({
                  config: { ...input.defaultConfig, sources: [...input.enabled.rank] },
                  manifestHash: options.code!.current.cli === null ? null : "sha256:code-manifest",
                  engineSourceHash: options.code!.current.hash,
                  cli: options.code!.current.cli,
                  blocked: null,
                  stale: [],
                })),
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
            const progress =
              options.draftCapped === true || options.draftProviderDisabled === true
                ? { ...progressOf(runId), ready: 1 }
                : progressOf(runId);
            return hold === null
              ? Effect.succeed(progress)
              : Effect.promise(() => hold).pipe(Effect.as(progress));
          },
          draftingProviderEnabled: Effect.succeed(options.draftProviderDisabled !== true),
          getBudget: Effect.succeed({
            monthlyLimit: 600,
            usedThisMonth: options.draftCapped === true ? 600 : 0,
            month: "2026-11",
          }),
        }),
      ),
    ),
    Layer.provide(withSpawnHooks(fx)),
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

/** Resolves once `file` exists; watches the fixture, never polls. */
const fileAppears = (fx: Fixture, file: string) =>
  Effect.callback<void>((resume) => {
    const watcher = NodeFS.watch(fx.root, { recursive: true }, () => {
      if (NodeFS.existsSync(file)) resume(Effect.void);
    });
    if (NodeFS.existsSync(file)) resume(Effect.void);
    return Effect.sync(() => watcher.close());
  });

/** Pids of live processes whose command line carries `--lock-token <prefix>…`. */
const processesCarrying = (prefix: string) =>
  NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(`--lock-token ${prefix}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

/** Resolves once events.log holds `count` lines equal to `line`; watches, never polls. */
const eventsReach = (fx: Fixture, line: string, count: number) =>
  Effect.callback<void>((resume) => {
    const reached = () => fx.events().filter((entry) => entry === line).length >= count;
    const watcher = NodeFS.watch(fx.root, () => {
      if (reached()) resume(Effect.void);
    });
    if (reached()) resume(Effect.void);
    return Effect.sync(() => watcher.close());
  });

/** The native fixture's cutoff and engine configuration hash. */
const NATIVE_CUTOFF = "2026-10-31T00:00:00.000Z";
const NATIVE_CONFIG_HASH =
  "sha256:290b9ddeec9bf5bc4e0512972d047c106623a3d050789fe0a8c145504d2e9095";

/** A corpus that already reaches yesterday, so the job's first engine command is `run`. */
const corpusUpToDate = (fx: Fixture, job: Pick<EditorialJob, "cutoffAt">) => {
  const today = job.cutoffAt.slice(0, 10);
  NodeFS.mkdirSync(fx.corpusDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(fx.corpusDir, "corpus-manifest.json"),
    JSON.stringify({
      schema_version: "corpus/1",
      from_day: addDays(today, -28),
      to_day: addDays(today, 1),
      files: [],
    }),
  );
};

const engineOf = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const rows = yield* sql<{
    readonly lease_owner: string | null;
    readonly lease_generation: number;
    readonly engine_token: string | null;
    readonly engine_pid: number | null;
    readonly prev_engine_token: string | null;
    readonly prev_engine_pid: number | null;
    readonly accepted_run_id: string | null;
  }>`
    SELECT lease_owner, lease_generation, engine_token, engine_pid, prev_engine_token,
      prev_engine_pid, accepted_run_id
    FROM editorial_jobs
  `;
  const row = rows[0];
  assert.isDefined(row);
  return row!;
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

  it.live("keys the job with the active profile and hands the engine that version's file", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const profiles = yield* EditorialProfileService.EditorialProfileService;
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const v1 = yield* profiles.activeFile;
        const job = yield* jobs.runNow;
        assert.strictEqual(job.profileHash, v1.hash);

        // A new version before the job runs: the pending job is replaced by one of the new key.
        const { active } = yield* profiles.update({
          language: "en",
          name: "SingulariDev",
          audience: "Solo founders building with AI agents",
          include: ["AI coding agents"],
          exclude: [],
        });
        yield* jobs.runDue;
        yield* jobs.runDue;
        const list = (yield* jobs.list).jobs;
        const replaced = list.find((entry) => entry.jobId === job.jobId);
        const current = list.find((entry) => entry.profileHash === active.hash);
        assert.strictEqual(replaced?.status, "skipped");
        assert.strictEqual(current?.status, "done");
        const written = NodeFS.readFileSync(
          NodePath.join(fx.root, "profiles", `${active.hash.slice("sha256:".length)}.json`),
          "utf8",
        );
        assert.strictEqual(written, (yield* profiles.activeFile).bytes);
        assert.include(written, '"version": 2');
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

  it.live("announces the next scheduled time that would run, not one already covered", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        const clock = yield* Clock.Clock;
        const at =
          (iso: string) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(
                Clock.Clock,
                // The live clock's methods sit on its prototype; only wall time is fixed.
                Object.assign(Object.create(clock) as Clock.Clock, {
                  currentTimeMillisUnsafe: () => Date.parse(iso),
                  currentTimeMillis: Effect.sync(() => Date.parse(iso)),
                }),
              ),
            );
        // The evening of 31 Oct in Guayaquil, 1 Nov in UTC, with the run on at 03:00 local.
        const evening = at("2026-11-01T01:18:00.000Z");
        yield* sql`
          INSERT INTO editorial_nightly_settings (
            id, enabled, time_of_day, timezone, workers, enabled_at, updated_at
          ) VALUES (1, 1, '03:00', 'America/Guayaquil', 2, ${PAST}, ${PAST})
        `;
        assert.strictEqual(
          (yield* evening(jobs.getSettings)).nextRunAt,
          "2026-11-01T08:00:00.000Z",
        );

        // Ejecutar ahora took the cutoff of 1 Nov and finished: 03:00 on 1 Nov runs nothing.
        const job = yield* evening(jobs.runNow);
        assert.strictEqual(job.cutoffAt, "2026-11-01T00:00:00.000Z");
        yield* sql`UPDATE editorial_jobs SET status = 'done' WHERE job_id = ${job.jobId}`;
        assert.strictEqual(
          (yield* evening(jobs.getSettings)).nextRunAt,
          "2026-11-02T08:00:00.000Z",
        );
        // Saving the settings answers the same rule, in the zone it stores.
        const saved = yield* evening(jobs.updateSettings({ workers: 2 }));
        assert.strictEqual(saved.nextRunAt, (yield* evening(jobs.getSettings)).nextRunAt);

        // A failed job covers its cutoff too: at 03:00 the Scheduler neither recreates it nor
        // claims it again.
        yield* sql`
          UPDATE editorial_nightly_settings SET timezone = 'America/Guayaquil', enabled_at = ${PAST}
        `;
        yield* sql`UPDATE editorial_jobs SET status = 'failed' WHERE job_id = ${job.jobId}`;
        assert.strictEqual(
          (yield* evening(jobs.getSettings)).nextRunAt,
          "2026-11-02T08:00:00.000Z",
        );
        yield* at("2026-11-01T08:00:30.000Z")(jobs.runDue);
        assert.deepStrictEqual(
          (yield* jobs.list).jobs.map((entry) => entry.status),
          ["failed"],
        );
        assert.deepStrictEqual(fx.trace(), []);
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
        // What the dead claim left: its manifest and profile copy, and the run naming them.
        const runId = "run_crashed";
        const jobDir = job.artifacts.jobDir;
        NodeFS.mkdirSync(jobDir, { recursive: true });
        writeClaimRecord(jobDir, 1, job);
        NodeFS.mkdirSync(NodePath.join(fx.runsDir, runId));
        NodeFS.writeFileSync(
          NodePath.join(fx.runsDir, runId, "run.json"),
          JSON.stringify({
            run_id: runId,
            status: "ok",
            cutoff_at: job.cutoffAt,
            config_hash: job.configHash,
            started_at: "2000-01-01T00:01:00.000Z",
            profile: { hash: job.profileHash, path: NodePath.join(jobDir, "profile.g1.json") },
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

  it.live("finishes with a budget notice when the monthly cap stops drafting", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        yield* jobs.runNow;
        yield* jobs.runDue;
        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.deepStrictEqual(done.artifacts.notices, [
          { code: "presentations_budget", ready: 1, total: 3, used: 600, limit: 600 },
        ]);
      }),
      { draftCapped: true },
    );
  });

  it.live("finishes with a provider notice when the drafting provider is disabled", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        yield* jobs.runNow;
        yield* jobs.runDue;
        const done = yield* onlyJob;
        assert.strictEqual(done.status, "done");
        assert.deepStrictEqual(done.artifacts.notices, [
          { code: "presentations_provider_disabled", ready: 1, total: 3 },
        ]);
      }),
      { draftProviderDisabled: true },
    );
  });

  it.live("records engine_missing on the job when no engine CLI was found", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        yield* jobs.runNow;
        yield* jobs.runDue;
        const failed = yield* onlyJob;
        assert.strictEqual(failed.status, "pending");
        assert.deepStrictEqual(failed.artifacts.failure, { code: "engine_missing" });
        assert.include(failed.error ?? "", "/missing/cli.mjs");
        assert.deepStrictEqual(fx.trace(), []);
      }),
      {
        engine: Result.fail(
          new EngineNotFound({ message: "No trend engine CLI at /missing/cli.mjs" }),
        ),
      },
    );
  });

  it.live(
    "keys the job with the active code: approved code replaces a job whose run already finished (S2)",
    () => {
      const fx = makeFixture();
      const code = { current: { cli: null as string | null, hash: null as string | null } };
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          const sql = yield* EditorialSql;
          // The installed engine runs and its check fails: the job waits with `run` done.
          fx.flag("check", true);
          const before = yield* jobs.runNow;
          yield* jobs.runDue;
          assert.deepStrictEqual(phaseStatuses(yield* onlyJob), [
            "done",
            "done",
            "failed",
            "pending",
            "pending",
          ]);
          // Code approved: its artifact (here, the stand-in engine) is the plan's engine.
          code.current = { cli: fx.engine, hash: engineSourceHash(NodePath.dirname(fx.engine)) };
          const after = yield* jobs.runNow;
          assert.notStrictEqual(after.jobId, before.jobId);
          fx.flag("check", false);
          yield* sql`UPDATE editorial_jobs SET scheduled_for = ${PAST}`;
          yield* jobs.runDue;
          yield* jobs.runDue;
          const { jobs: list } = yield* jobs.list;
          const replaced = list.find((job) => job.jobId === before.jobId);
          assert.strictEqual(replaced?.status, "skipped");
          assert.deepStrictEqual(replaced?.artifacts.notices, [{ code: "config_changed" }]);
          assert.strictEqual(list.find((job) => job.jobId === after.jobId)?.status, "done");
          // The new code ran its own engine run; the installed engine's finished run was not reused.
          assert.strictEqual(fx.trace().filter((line) => line === "run").length, 2);
        }),
        { code },
      );
    },
  );

  it.live(
    "runs approved code in bwrap without the server's environment, and not at all without bwrap (Opus)",
    () => {
      const fx = makeFixture();
      const code = {
        current: { cli: fx.engine, hash: engineSourceHash(NodePath.dirname(fx.engine)) },
      };
      const secret = "EARLYSCRIPT_TEST_SECRET_SHOULD_NOT_LEAK";
      process.env[secret] = "leaked";
      // A file of the server's that no mount covers: the sandbox must not reach it.
      const elsewhere = makeTempDir();
      NodeFS.writeFileSync(NodePath.join(elsewhere, "credentials"), "secret");
      NodeFS.writeFileSync(
        NodePath.join(fx.root, "sentinel-path"),
        NodePath.join(elsewhere, "credentials"),
      );
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          const started = yield* jobs.runNow;
          yield* jobs.runDue;
          const done = (yield* jobs.list).jobs.find((job) => job.jobId === started.jobId);
          assert.strictEqual(done?.status, "done", JSON.stringify(done?.artifacts));
          // The launch line says bwrap; the stand-in engine saw neither the server's
          // environment nor a file outside its mounts.
          const jobDir = NodePath.join(fx.root, "jobs", started.jobId);
          const log = NodeFS.readdirSync(jobDir).find((name) => name.startsWith("run.g"))!;
          assert.match(
            NodeFS.readFileSync(NodePath.join(jobDir, log), "utf8"),
            /^\$ \[bwrap\] node --disallow-code-generation-from-strings --permission /,
          );
          const env = NodeFS.readFileSync(NodePath.join(fx.root, "env.log"), "utf8")
            .split("\n")
            .filter((line) => line.startsWith("env "));
          assert.isNotEmpty(env);
          assert.isTrue(env.every((line) => !line.includes(secret)));
          assert.isTrue(env.every((line) => line.includes("outside=hidden")));
        }),
        { code },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            delete process.env[secret];
            NodeFS.rmSync(elsewhere, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.live(
    "an approved artifact writes only its own output: earlier runs and the shared cache stay as they were (Opus B2, Astra B1)",
    () => {
      const fx = makeFixture();
      const code = { current: { cli: null as string | null, hash: null as string | null } };
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          // An earlier run of the installed engine, and the shared cache.
          const earlier = yield* jobs.runNow;
          yield* jobs.runDue;
          const earlierRun = (yield* jobs.list).jobs.find((job) => job.jobId === earlier.jobId)!
            .artifacts.runId!;
          const witness = NodePath.join(fx.runsDir, earlierRun, "run.json");
          const cache = NodePath.join(fx.root, "embeddings.sqlite");
          NodeFS.writeFileSync(cache, "shared cache");
          const before = [NodeFS.readFileSync(witness, "utf8"), NodeFS.readFileSync(cache, "utf8")];
          // Approved code that tries to write both.
          NodeFS.writeFileSync(NodePath.join(fx.root, "tamper"), JSON.stringify([witness, cache]));
          code.current = { cli: fx.engine, hash: engineSourceHash(NodePath.dirname(fx.engine)) };
          const approved = yield* jobs.runNow;
          yield* jobs.runDue;
          yield* jobs.runDue;
          const done = (yield* jobs.list).jobs.find((job) => job.jobId === approved.jobId);
          assert.strictEqual(done?.status, "done");
          const attempts = NodeFS.readFileSync(NodePath.join(fx.root, "tamper.log"), "utf8")
            .split("\n")
            .filter(Boolean);
          assert.lengthOf(attempts, 2);
          assert.isTrue(attempts.every((line) => line.endsWith(" ERR_ACCESS_DENIED")));
          assert.deepStrictEqual(
            [NodeFS.readFileSync(witness, "utf8"), NodeFS.readFileSync(cache, "utf8")],
            before,
          );
          // Its own run was collected into the runs directory by the trusted side.
          assert.isTrue(NodeFS.existsSync(NodePath.join(fx.runsDir, done!.artifacts.runId!)));
        }),
        { code },
      );
    },
  );

  it.live("never adopts a run it did not launch, even one that matches the job (Opus B2)", () => {
    const fx = makeFixture();
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        const job = yield* jobs.runNow;
        const [row] = yield* sql<{
          cutoff_at: string;
          config_hash: string;
          profile_hash: string;
        }>`SELECT cutoff_at, config_hash, profile_hash FROM editorial_jobs WHERE job_id = ${job.jobId}`;
        // A run with the job's cutoff, configuration and profile, started far ahead, without
        // the claim's own profile path: what code with write access could have left there.
        const planted = "run_20990101_20990101T000000_planted";
        NodeFS.mkdirSync(NodePath.join(fx.runsDir, planted), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(fx.runsDir, planted, "run.json"),
          JSON.stringify({
            run_id: planted,
            status: "ok",
            cutoff_at: row!.cutoff_at,
            config_hash: row!.config_hash,
            started_at: "2099-01-01T00:00:00.000Z",
            profile: { hash: row!.profile_hash },
          }),
        );
        yield* jobs.runDue;
        const done = (yield* jobs.list).jobs.find((entry) => entry.jobId === job.jobId);
        assert.strictEqual(done?.status, "done");
        assert.notStrictEqual(done?.artifacts.runId, planted);
        assert.include(fx.trace(), "run");
      }),
    );
  });

  it.live("fails an approved artifact's run on a machine without bwrap (Opus)", () => {
    const fx = makeFixture();
    const code = {
      current: { cli: fx.engine, hash: engineSourceHash(NodePath.dirname(fx.engine)) },
    };
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const started = yield* jobs.runNow;
        yield* jobs.runDue;
        const job = (yield* jobs.list).jobs.find((entry) => entry.jobId === started.jobId);
        assert.deepStrictEqual(job?.artifacts.failure, { code: "engine_failed", phase: "run" });
        assert.notInclude(fx.trace(), "run");
      }),
      { code, timing: { artifactSandbox: "unavailable" } },
    );
  });

  it.live(
    "a job reactivated after a code revert runs its own engine, never another code's run",
    () => {
      const fx = makeFixture();
      const code = { current: { cli: null as string | null, hash: null as string | null } };
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          const installed = yield* jobs.runNow;
          code.current = { cli: fx.engine, hash: engineSourceHash(NodePath.dirname(fx.engine)) };
          const artifact = yield* jobs.runNow;
          // The oldest due job is the installed one: replaced; then the artifact's job runs.
          yield* jobs.runDue;
          yield* jobs.runDue;
          const ran = (yield* jobs.list).jobs.find((job) => job.jobId === artifact.jobId);
          assert.strictEqual(ran?.status, "done");
          // Reverted: the installed job again, at the same cutoff, configuration and profile.
          code.current = { cli: null, hash: null };
          const again = yield* jobs.runNow;
          assert.strictEqual(again.jobId, installed.jobId);
          yield* jobs.runDue;
          const done = (yield* jobs.list).jobs.find((job) => job.jobId === installed.jobId);
          assert.strictEqual(done?.status, "done");
          assert.notStrictEqual(done?.artifacts.runId, ran?.artifacts.runId);
          assert.strictEqual(fx.trace().filter((line) => line === "run").length, 2);
        }),
        { code },
      );
    },
  );

  it.live(
    "an artifact job retried after a revert and a new approval runs its own code, never the installed run (Sol, B1-R3)",
    () => {
      const fx = makeFixture();
      const code = { current: { cli: null as string | null, hash: null as string | null } };
      const artifactCode = () => ({
        cli: fx.engine,
        hash: engineSourceHash(NodePath.dirname(fx.engine)),
      });
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          const sql = yield* EditorialSql;
          const byId = (id: string) =>
            jobs.list.pipe(Effect.map(({ jobs: list }) => list.find((job) => job.jobId === id)));
          // 1–3: the installed job waits; code approved; the installed job is replaced and the
          // artifact's job fails in `run`, pending a retry.
          const installed = yield* jobs.runNow;
          code.current = artifactCode();
          const artifact = yield* jobs.runNow;
          fx.flag("run", true);
          yield* jobs.runDue;
          yield* jobs.runDue;
          assert.strictEqual((yield* byId(artifact.jobId))?.status, "pending");
          // 4: reverted; the installed engine runs and writes a valid run after that start.
          code.current = { cli: null, hash: null };
          fx.flag("run", false);
          assert.strictEqual((yield* jobs.runNow).jobId, installed.jobId);
          yield* sql`UPDATE editorial_jobs SET scheduled_for = ${FUTURE} WHERE job_id = ${artifact.jobId}`;
          yield* jobs.runDue;
          const installedRun = (yield* byId(installed.jobId))?.artifacts.runId;
          assert.isString(installedRun);
          // 5–6: approved again; the pending artifact job runs its own engine.
          code.current = artifactCode();
          assert.strictEqual((yield* jobs.runNow).jobId, artifact.jobId);
          yield* sql`UPDATE editorial_jobs SET scheduled_for = ${PAST} WHERE job_id = ${artifact.jobId}`;
          const runsBefore = fx.trace().filter((line) => line === "run").length;
          yield* jobs.runDue;
          const done = yield* byId(artifact.jobId);
          assert.strictEqual(done?.status, "done");
          assert.notStrictEqual(done?.artifacts.runId, installedRun);
          assert.strictEqual(fx.trace().filter((line) => line === "run").length, runsBefore + 1);
        }),
        { code },
      );
    },
  );

  it.live("checks the artifact's hash again just before the launch, and runs nothing else", () => {
    const fx = makeFixture();
    // Planned with a hash the artifact no longer has: edited after the plan was made.
    const code = {
      current: {
        cli: fx.engine as string | null,
        hash: "sha256:approved-before-the-edit" as string | null,
      },
    };
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        yield* jobs.runNow;
        yield* jobs.runDue;
        const job = yield* onlyJob;
        assert.include(job.error ?? "", "no longer hashes");
        assert.deepStrictEqual(job.artifacts.failure, { code: "engine_failed", phase: "run" });
        assert.notInclude(fx.trace(), "run");
      }),
      { code },
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
        // Every accepted run actually written, with the generation that wrote it.
        yield* sql`CREATE TABLE accepted_log (generation INTEGER, run_id TEXT)`;
        yield* sql`
          CREATE TRIGGER log_accept AFTER UPDATE OF accepted_run_id ON editorial_jobs
          BEGIN
            INSERT INTO accepted_log VALUES (NEW.lease_generation, NEW.accepted_run_id);
          END
        `;
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
        // The former owner's child wrote the run, but only generation 2 could accept it.
        const accepted = yield* sql<{ readonly generation: number; readonly run_id: string }>`
          SELECT generation, run_id FROM accepted_log
        `;
        assert.isAbove(accepted.length, 0);
        assert.isTrue(accepted.every((row) => row.generation === 2));
        assert.isTrue(accepted.every((row) => row.run_id === done.artifacts.runId));
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
        // The claim's own profile copy and manifest, as the run phase writes them first.
        writeClaimRecord(jobDir, 1, job);
        const profileFile = NodePath.join(jobDir, "profile.g1.json");
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
            engine_token = ${`${job.jobId}:dead-server:1`}, engine_pid = ${orphan.pid ?? null},
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
        const engine = yield* engineOf;
        assert.strictEqual(engine.prev_engine_token, `${job.jobId}:dead-server:1`);
        assert.strictEqual(engine.prev_engine_pid, orphan.pid);
      }),
    );
  });

  it.live("a child published by a claim that lost the job before naming its pid is killed", () => {
    const fx = makeFixture();
    fx.slowRun(1500);
    return withJobs(
      fx,
      Effect.gen(function* () {
        const jobs = yield* EditorialJobsService.EditorialJobsService;
        const sql = yield* EditorialSql;
        const job = yield* jobs.runNow;
        corpusUpToDate(fx, job);
        // Another server claims the job the moment this one publishes its engine.
        yield* sql`
          CREATE TRIGGER take_over AFTER UPDATE OF engine_token ON editorial_jobs
          WHEN NEW.engine_token IS NOT NULL AND OLD.engine_token IS NULL
          BEGIN
            UPDATE editorial_jobs SET lease_owner = 'other-server',
              lease_generation = lease_generation + 1 WHERE job_id = NEW.job_id;
          END
        `;
        yield* jobs.runDue;

        assert.notInclude(fx.events(), "run done");
        assert.deepStrictEqual(fx.runDirs(), []);
        assert.deepStrictEqual(processesCarrying(`${job.jobId}:`), []);
        const engine = yield* engineOf;
        assert.strictEqual(engine.lease_owner, "other-server");
        assert.match(engine.engine_token ?? "", /:1$/);
        assert.isNull(engine.engine_pid);
        assert.strictEqual((yield* onlyJob).status, "running");
      }),
    );
  });

  it.live(
    "a recorded pid that does not carry the former token is neither waited for nor killed",
    () => {
      const fx = makeFixture();
      const stranger = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
      const strangerExited = new Promise<void>((resolve) => stranger.once("exit", () => resolve()));
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          const sql = yield* EditorialSql;
          const job = yield* jobs.runNow;
          yield* sql`
          UPDATE editorial_jobs SET
            status = 'running', attempt = 1, started_at = ${PAST}, lease_until = ${PAST},
            lease_owner = 'dead-server', lease_generation = 1,
            engine_token = ${`${job.jobId}:dead-server:1`}, engine_pid = ${stranger.pid ?? null}
          WHERE job_id = ${job.jobId}
        `;
          yield* jobs.runDue;

          const done = yield* onlyJob;
          assert.strictEqual(done.status, "done");
          assert.deepStrictEqual(done.artifacts.notices, []);
          assert.strictEqual(stranger.exitCode, null);
          assert.isNull(stranger.signalCode);
          const engine = yield* engineOf;
          assert.strictEqual(engine.prev_engine_pid, stranger.pid);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => stranger.kill("SIGKILL")).pipe(
              Effect.andThen(Effect.promise(() => strangerExited)),
            ),
          ),
        ),
      );
    },
  );

  it.live(
    "two claims publishing at nearly the same time: only the current generation stays",
    () => {
      const fx = makeFixture();
      fx.slowRun(1500);
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          const sql = yield* EditorialSql;
          const job = yield* jobs.runNow;
          corpusUpToDate(fx, job);
          // The first claim's lease lapses as it publishes, so a second claim can take the job
          // while the first one is still launching.
          yield* sql`
          CREATE TRIGGER lapse AFTER UPDATE OF engine_token ON editorial_jobs
          WHEN NEW.engine_token IS NOT NULL AND NEW.lease_generation = 1
          BEGIN
            UPDATE editorial_jobs SET lease_until = '2000-01-01T00:00:00.000Z'
            WHERE job_id = NEW.job_id;
          END
        `;
          const first = yield* Effect.forkChild(jobs.runDue);
          yield* fileAppears(fx, NodePath.join(job.artifacts.jobDir, "run.g1.log"));
          yield* jobs.runDue;
          yield* Fiber.join(first);

          const done = yield* onlyJob;
          assert.strictEqual(done.status, "done");
          assert.notInclude(fx.events(), "OVERLAP");
          assert.deepStrictEqual(
            fx.events().filter((line) => line === "run done"),
            ["run done"],
          );
          assert.deepStrictEqual(fx.runDirs(), [done.artifacts.runId]);
          const engine = yield* engineOf;
          assert.strictEqual(engine.lease_generation, 2);
          assert.match(engine.engine_token ?? "", /:2$/);
          assert.isNotNull(engine.engine_pid);
          assert.match(engine.prev_engine_token ?? "", /:1$/);
        }),
      );
    },
  );

  it.live(
    "both children of the accepted window finish: one run is imported, the other superseded",
    () => {
      const fx = makeFixture();
      fx.slowRun(800);
      NodeFS.writeFileSync(
        NodePath.join(fx.root, "native-fixture"),
        NodePath.join(import.meta.dirname, "fixtures", "native-runs", NATIVE_FIXTURE_RUN_ID),
      );
      return withJobs(
        fx,
        Effect.gen(function* () {
          const jobs = yield* EditorialJobsService.EditorialJobsService;
          const importer = yield* EditorialImportService.EditorialImportService;
          const sql = yield* EditorialSql;
          const created = yield* jobs.runNow;
          // The fixture's inputs are the job's: same configuration and profile, its cutoff.
          assert.strictEqual(created.configHash, NATIVE_CONFIG_HASH);
          yield* sql`UPDATE editorial_jobs SET cutoff_at = ${NATIVE_CUTOFF}`;
          corpusUpToDate(fx, { ...created, cutoffAt: NATIVE_CUTOFF });

          // The first claim publishes its engine, then stalls past its lease before spawning
          // and again before naming its child, while a second claim runs its own engine.
          const published = yield* Deferred.make<void>();
          const launch = yield* Deferred.make<void>();
          fx.beforeSpawn = Deferred.succeed(published, undefined).pipe(
            Effect.andThen(Deferred.await(launch)),
          );
          const former = yield* Effect.forkChild(jobs.runDue);
          yield* Deferred.await(published);
          yield* sql`UPDATE editorial_jobs SET lease_until = ${PAST}`;
          const current = yield* Effect.forkChild(jobs.runDue);
          yield* traceReaches(fx, "run");
          fx.afterSpawn = eventsReach(fx, "run done", 2);
          yield* Deferred.succeed(launch, undefined);
          yield* Fiber.join(current);
          yield* Fiber.join(former);

          // Both children finished their runs; the job kept the second claim's.
          assert.strictEqual(fx.trace().filter((line) => line === "run").length, 2);
          assert.strictEqual(fx.runDirs().length, 2);
          const done = yield* onlyJob;
          assert.strictEqual(done.status, "done");
          const accepted = done.artifacts.runId ?? "";
          const other = fx.runDirs().find((name) => name !== accepted) ?? "";
          const report = yield* importer.sync;
          assert.deepStrictEqual(
            report.runs.map((run) => [run.runId, run.outcome]),
            [[other, "superseded"]],
          );
          const runs = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM editorial_runs`;
          assert.deepStrictEqual(
            runs.map((row) => row.run_id),
            [accepted],
          );
          const imported = yield* sql<{ readonly aggregate_id: string }>`
          SELECT aggregate_id FROM editorial_events WHERE type = 'run.imported'
        `;
          assert.strictEqual(imported.length, 1);
          assert.strictEqual((yield* engineOf).accepted_run_id, accepted);
        }),
        { realImport: true },
      );
    },
  );
});
