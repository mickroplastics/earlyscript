// @effect-diagnostics nodeBuiltinImport:off - shadow cards are written for the operator; label files are read from disk.
// Evaluation jobs: a persistent queue with a lease, one heavy job at a time, run by the fixed
// worker command of the local or the operator's remote executor. The worker returns engine
// outputs signed with the job's secret; this service verifies them and computes the report.
import * as NodeFS from "node:fs";

import type { EngineJobView } from "@earlyscript/editorial-contracts/engineLab";
import { developmentReport, reportHash } from "@earlyscript/engine-lab/compare";
import {
  evaluateGate,
  type CardLabel,
  type GateResult,
  shadowCards,
} from "@earlyscript/engine-lab/gate";
import { readLabelSource } from "@earlyscript/engine-lab/labels";
import { type JobSpec, resultMismatch, type WorkerResult } from "@earlyscript/engine-lab/result";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { lastJsonLine } from "./engineProcess.ts";
import { type CampaignRow, policyOf } from "./EngineChangeService.ts";
import {
  EngineLabOptions,
  labFailure,
  parseJson,
  storageFailure,
  toJson,
} from "./engineLabSupport.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId, nowIso } from "./persistence/support.ts";

interface JobRow {
  readonly job_id: string;
  readonly campaign_id: string;
  readonly kind: "development" | "shadow";
  readonly candidate_hash: string;
  readonly reference_hash: string;
  readonly thread_id: string | null;
  readonly status: EngineJobView["status"];
  readonly executor: "local" | "remote";
  readonly token: string;
  readonly secret: string;
  readonly spec_json: string;
  readonly tries: number;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly lease_until: string | null;
  readonly pid: number | null;
  readonly cancel_requested: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly report_id: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

const JOB_COLUMNS =
  "job_id, campaign_id, kind, candidate_hash, reference_hash, thread_id, status, executor, token, secret, " +
  "spec_json, tries, lease_owner, lease_generation, lease_until, pid, cancel_requested, error_code, " +
  "error_message, report_id, created_at, started_at, finished_at";

/** What the worker command answered; an infrastructure failure leaves the job to retry. */
type WorkerOutcome =
  | { readonly _tag: "result"; readonly result: WorkerResult }
  | { readonly _tag: "unavailable"; readonly message: string };

export interface EngineExperimentServiceShape {
  /** One pass: recover a lapsed lease or claim the oldest queued job, and run it to the end. */
  readonly runDue: Effect.Effect<void, ReturnType<typeof labFailure>>;
  readonly job: (input: {
    readonly projectId: string | null;
    readonly jobId: string;
    readonly afterSeq?: number | undefined;
  }) => Effect.Effect<EngineJobView, ReturnType<typeof labFailure>>;
  readonly cancel: (input: {
    readonly projectId: string | null;
    readonly jobId: string;
    readonly reason: string;
  }) => Effect.Effect<EngineJobView, ReturnType<typeof labFailure>>;
  /** A finished development job's rankings per cutoff, with each trend's score components. */
  readonly rankings: (input: {
    readonly projectId: string | null;
    readonly jobId: string;
  }) => Effect.Effect<unknown, ReturnType<typeof labFailure>>;
  /** Operator only: the blind cards of a finished shadow job. */
  readonly shadowCards: (
    jobId: string,
  ) => Effect.Effect<ReadonlyArray<unknown>, ReturnType<typeof labFailure>>;
  /** Operator only: Miguel's labels of those cards, and the gate they give. */
  readonly scoreShadow: (input: {
    readonly jobId: string;
    readonly labelsPath: string;
    readonly actor: string;
  }) => Effect.Effect<GateResult, ReturnType<typeof labFailure>>;
}

export class EngineExperimentService extends Context.Service<
  EngineExperimentService,
  EngineExperimentServiceShape
>()("t3/editorial/EngineExperimentService") {}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const encoder = new TextEncoder();

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const options = yield* EngineLabOptions;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const node = yield* HostProcess.ExecutablePath;
  const newId = yield* makeNewId;
  const storage = Effect.mapError(storageFailure);

  const selectJob = (jobId: string) =>
    sql<JobRow>`SELECT ${sql.literal(JOB_COLUMNS)} FROM editorial_engine_jobs WHERE job_id = ${jobId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const selectCampaign = (campaignId: string) =>
    sql<CampaignRow>`
      SELECT campaign_id, project_id, kind, reference_hash, request_id, policy_json, policy_hash, budget,
        status, created_by, created_at
      FROM editorial_engine_campaigns WHERE campaign_id = ${campaignId}
    `.pipe(Effect.map((rows) => Option.getOrThrow(Option.fromNullishOr(rows[0]))));

  const event = Effect.fn("EngineExperimentService.event")(function* (
    jobId: string,
    kind: string,
    detail: string,
  ) {
    const at = yield* nowIso;
    yield* sql`
        INSERT INTO editorial_engine_job_events (job_id, seq, at, kind, detail)
        SELECT ${jobId}, COALESCE(MAX(seq), 0) + 1, ${at}, ${kind}, ${detail}
        FROM editorial_engine_job_events WHERE job_id = ${jobId}
      `;
  });

  const specOf = (row: JobRow): JobSpec => ({
    ...(parseJson(row.spec_json) as JobSpec),
    secret: row.secret,
  });

  /** The fixed command of the job's executor; the spec, with its secret, only goes on stdin. */
  const workerCommand = (row: JobRow, command: "evaluate" | "cancel") => {
    if (row.executor === "remote") {
      const remote = options.remote;
      if (remote === null) return null;
      return {
        command: "ssh",
        args: [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=15",
          remote.alias,
          "--",
          "nice",
          "-n",
          "10",
          remote.node,
          `${remote.root}/packages/engine-lab/src/cli.ts`,
          command,
          "--jobs-root",
          remote.jobsRoot,
          ...(command === "evaluate" ? ["--engine-root", remote.root] : []),
          "--token",
          row.token,
        ],
      };
    }
    if (options.engineRoot === null) return null;
    return {
      command: node,
      args: [
        `${options.engineRoot}/packages/engine-lab/src/cli.ts`,
        command,
        "--jobs-root",
        options.jobsRoot,
        ...(command === "evaluate" ? ["--engine-root", options.engineRoot] : []),
        "--token",
        row.token,
      ],
    };
  };

  const runWorker = Effect.fn("EngineExperimentService.runWorker")(
    function* (row: JobRow, lease: { owner: string; generation: number }) {
      const command = workerCommand(row, "evaluate");
      if (command === null) {
        return {
          _tag: "unavailable",
          message: `The ${row.executor} executor is not configured here.`,
        } as WorkerOutcome;
      }
      const spec = specOf(row);
      const output = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command.command, command.args, {
              stdin: Stream.make(encoder.encode(toJson(spec))),
              env: { ELECTRON_RUN_AS_NODE: "1" },
              extendEnv: true,
              forceKillAfter: "5 seconds",
            }),
          );
          yield* sql`
            UPDATE editorial_engine_jobs SET pid = ${Number(child.pid)}
            WHERE job_id = ${row.job_id} AND lease_owner = ${lease.owner} AND lease_generation = ${lease.generation}
          `;
          const [stdout] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText, Stream.mkString),
              child.stderr.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runForEach((line) =>
                  event(row.job_id, "progress", line.slice(0, 500)).pipe(Effect.ignore),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );
          return { exitCode: Number(yield* child.exitCode), stdout };
        }),
      );
      const result = lastJsonLine(output.stdout) as WorkerResult | null;
      if (result === null || typeof result !== "object" || !("signature" in result)) {
        return {
          _tag: "unavailable",
          message: `The worker exited with ${output.exitCode} without a result.`,
        } as WorkerOutcome;
      }
      return { _tag: "result", result } as WorkerOutcome;
    },
    Effect.catch((error) =>
      Effect.succeed({
        _tag: "unavailable",
        message: `The executor could not run the job: ${String(error)}`,
      } as WorkerOutcome),
    ),
  );

  const finish = Effect.fn("EngineExperimentService.finish")(function* (
    row: JobRow,
    lease: { owner: string; generation: number },
    status: "succeeded" | "failed" | "cancelled" | "queued",
    error: { code: string; message: string } | null,
    reportId: string | null = null,
  ) {
    const now = yield* nowIso;
    yield* sql`
        UPDATE editorial_engine_jobs SET status = ${status}, error_code = ${error?.code ?? null},
          error_message = ${error?.message ?? null}, report_id = ${reportId},
          finished_at = ${status === "queued" ? null : now}, lease_owner = NULL, lease_until = NULL, pid = NULL
        WHERE job_id = ${row.job_id} AND lease_owner = ${lease.owner} AND lease_generation = ${lease.generation}
      `;
    yield* event(
      row.job_id,
      status,
      error === null ? (reportId ?? "") : `${error.code}: ${error.message}`.slice(0, 1000),
    );
  });

  /** The report of a verified result: labels are read here, never by the worker. */
  const reportOf = (row: JobRow, campaign: CampaignRow, result: WorkerResult) =>
    Effect.try({
      try: () => {
        const policy = policyOf(campaign);
        const base = developmentReport({
          result,
          campaignId: campaign.campaign_id,
          cutoffs: policy.cutoffs,
          human:
            policy.labels === null
              ? null
              : readLabelSource({
                  cardsPath: policy.labels.cards,
                  labelsPath: policy.labels.labels,
                  kind: "human",
                }),
          judge:
            policy.judge === null
              ? null
              : readLabelSource({
                  cardsPath: policy.judge.cards,
                  labelsPath: policy.judge.labels,
                  kind: "judge",
                }),
        });
        if (row.kind !== "shadow") return base;
        const { cards, members } = shadowCards(result);
        return { ...base, kind: "shadow" as const, shadow: { cards, members } };
      },
      catch: (cause) =>
        labFailure("artifact-mismatch", `The report could not be computed: ${String(cause)}`),
    });

  const accept = Effect.fn("EngineExperimentService.accept")(function* (
    row: JobRow,
    lease: { owner: string; generation: number },
    result: WorkerResult,
  ) {
    const spec = specOf(row);
    const mismatch = resultMismatch(spec, result);
    if (mismatch !== null) {
      return yield* finish(row, lease, "failed", {
        code: "artifact-mismatch",
        message: `The worker's result was rejected: ${mismatch}.`,
      });
    }
    if (result.status !== "ok") {
      return yield* finish(
        row,
        lease,
        "failed",
        result.error ?? { code: "engine-failed", message: "The worker failed." },
      );
    }
    const campaign = yield* selectCampaign(row.campaign_id);
    const report = yield* reportOf(row, campaign, result).pipe(Effect.result);
    if (Result.isFailure(report))
      return yield* finish(row, lease, "failed", {
        code: report.failure.code,
        message: report.failure.message,
      });
    const reportId = `rep_${row.job_id.slice(4)}`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const mine = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found FROM editorial_engine_jobs
            WHERE job_id = ${row.job_id} AND status = 'running' AND lease_owner = ${lease.owner}
              AND lease_generation = ${lease.generation}
          `;
        if (mine.length === 0) return;
        yield* sql`
            INSERT INTO editorial_engine_reports (report_id, job_id, kind, report_json, report_hash, result_json, created_at)
            VALUES (${reportId}, ${row.job_id}, ${row.kind}, ${toJson(report.success)}, ${reportHash(report.success)},
              ${toJson(result)}, ${yield* nowIso})
            ON CONFLICT (job_id) DO NOTHING
          `;
        yield* finish(row, lease, "succeeded", null, reportId);
      }),
    );
  });

  const claim = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = isoOf(nowMs);
    const owner = yield* newId;
    const rows = yield* sql<JobRow>`
      UPDATE editorial_engine_jobs SET
        status = 'running',
        tries = tries + 1,
        lease_owner = ${owner},
        lease_generation = lease_generation + 1,
        lease_until = ${isoOf(nowMs + options.leaseMs)},
        started_at = COALESCE(started_at, ${now})
      WHERE job_id = (
        SELECT job_id FROM editorial_engine_jobs
        WHERE status = 'queued' OR (status = 'running' AND lease_until < ${now})
        ORDER BY created_at, job_id LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM editorial_engine_jobs WHERE status = 'running' AND lease_until >= ${now}
      )
      RETURNING ${sql.literal(JOB_COLUMNS)}
    `;
    return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
      row,
      lease: { owner, generation: row.lease_generation },
    }));
  });

  const heartbeat = Effect.fn("EngineExperimentService.heartbeat")(function* (
    row: JobRow,
    lease: { owner: string; generation: number },
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* sql`
        UPDATE editorial_engine_jobs SET lease_until = ${isoOf(nowMs + options.leaseMs)}
        WHERE job_id = ${row.job_id} AND lease_owner = ${lease.owner} AND lease_generation = ${lease.generation}
      `;
  });

  const execute = Effect.fn("EngineExperimentService.execute")(function* (
    row: JobRow,
    lease: { owner: string; generation: number },
  ) {
    if (row.cancel_requested === 1)
      return yield* finish(row, lease, "cancelled", {
        code: "cancelled",
        message: "Cancelled before it ran.",
      });
    yield* event(row.job_id, "running", `try ${row.tries} on ${row.executor}`);
    const beat = yield* Effect.forkChild(
      Effect.ignore(heartbeat(row, lease)).pipe(
        Effect.repeat(Schedule.spaced(options.heartbeatMs)),
      ),
    );
    const outcome = yield* runWorker(row, lease).pipe(Effect.ensuring(Fiber.interrupt(beat)));
    const now = Option.getOrThrow(yield* selectJob(row.job_id));
    if (now.cancel_requested === 1) {
      return yield* finish(row, lease, "cancelled", {
        code: "cancelled",
        message: "Cancelled while it ran; no result was accepted.",
      });
    }
    if (outcome._tag === "unavailable") {
      // Infrastructure: the same seat retries with the same token; the worker deduplicates.
      return row.tries < options.maxTries
        ? yield* finish(row, lease, "queued", {
            code: "executor-unavailable",
            message: outcome.message,
          })
        : yield* finish(row, lease, "failed", {
            code: "executor-unavailable",
            message: outcome.message,
          });
    }
    return yield* accept(row, lease, outcome.result);
  });

  const runDue: EngineExperimentServiceShape["runDue"] = Effect.gen(function* () {
    const claimed = yield* claim;
    if (Option.isNone(claimed)) return;
    yield* execute(claimed.value.row, claimed.value.lease);
  }).pipe(storage);

  const projectOf = (row: JobRow) =>
    sql<{
      readonly project_id: string;
    }>`SELECT project_id FROM editorial_engine_campaigns WHERE campaign_id = ${row.campaign_id}`.pipe(
      Effect.map((rows) => rows[0]?.project_id ?? null),
    );

  const ownedJob = Effect.fn("EngineExperimentService.ownedJob")(function* (
    projectId: string | null,
    jobId: string,
  ) {
    const row = yield* selectJob(jobId).pipe(storage);
    if (Option.isNone(row)) return yield* labFailure("not-found", `No job ${jobId}.`);
    if (projectId !== null && (yield* projectOf(row.value).pipe(storage)) !== projectId) {
      return yield* labFailure("permission-denied", `Job ${jobId} belongs to another project.`);
    }
    return row.value;
  });

  const viewOf = Effect.fn("EngineExperimentService.viewOf")(function* (
    row: JobRow,
    afterSeq: number,
  ) {
    const events = yield* sql<{
      readonly seq: number;
      readonly at: string;
      readonly kind: string;
      readonly detail: string;
    }>`
        SELECT seq, at, kind, detail FROM editorial_engine_job_events
        WHERE job_id = ${row.job_id} AND seq > ${afterSeq} ORDER BY seq LIMIT 50
      `;
    const report =
      row.report_id === null
        ? []
        : yield* sql<{ readonly report_json: string; readonly report_hash: string }>`
              SELECT report_json, report_hash FROM editorial_engine_reports WHERE report_id = ${row.report_id}
            `;
    const parsed =
      report[0] === undefined
        ? null
        : (parseJson(report[0].report_json) as Record<string, unknown>);
    // A shadow's cards and rankings stay with the operator until Miguel has labelled them.
    const visible =
      parsed === null || row.kind !== "shadow"
        ? parsed
        : { kind: "shadow", note: "Shadow results stay hidden from models." };
    return {
      jobId: row.job_id,
      campaignId: row.campaign_id,
      candidateHash: row.candidate_hash,
      referenceHash: row.reference_hash,
      status: row.status,
      executor: row.executor,
      tries: row.tries,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error:
        row.error_code === null ? null : { code: row.error_code, message: row.error_message ?? "" },
      reportId: row.report_id,
      reportHash: report[0]?.report_hash ?? null,
      events: [...events],
      report: visible,
    } satisfies EngineJobView;
  }, storage);

  const job: EngineExperimentServiceShape["job"] = Effect.fn("EngineExperimentService.job")(
    function* (input) {
      const row = yield* ownedJob(input.projectId, input.jobId);
      return yield* viewOf(row, input.afterSeq ?? 0);
    },
  );

  const cancel: EngineExperimentServiceShape["cancel"] = Effect.fn(
    "EngineExperimentService.cancel",
  )(function* (input) {
    const row = yield* ownedJob(input.projectId, input.jobId);
    if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled")
      return yield* viewOf(row, 0);
    yield* sql`UPDATE editorial_engine_jobs SET cancel_requested = 1 WHERE job_id = ${row.job_id}`.pipe(
      storage,
    );
    yield* event(row.job_id, "cancel-requested", input.reason.slice(0, 500)).pipe(storage);
    if (row.status === "queued") {
      yield* sql`
          UPDATE editorial_engine_jobs SET status = 'cancelled', finished_at = ${yield* nowIso},
            error_code = 'cancelled', error_message = ${input.reason.slice(0, 500)}
          WHERE job_id = ${row.job_id} AND status = 'queued'
        `.pipe(storage);
    } else {
      // The worker checks its own command line before it ends its process group.
      const command = workerCommand(row, "cancel");
      if (command !== null) {
        yield* spawner
          .string(
            ChildProcess.make(command.command, command.args, {
              env: { ELECTRON_RUN_AS_NODE: "1" },
              extendEnv: true,
            }),
          )
          .pipe(Effect.ignore);
      }
    }
    return yield* viewOf(Option.getOrThrow(yield* selectJob(row.job_id).pipe(storage)), 0);
  });

  const rankings = Effect.fn("EngineExperimentService.rankings")(function* (input: {
    readonly projectId: string | null;
    readonly jobId: string;
  }) {
    const row = yield* ownedJob(input.projectId, input.jobId);
    if (row.kind === "shadow")
      return yield* labFailure("sealed-partition", "Shadow rankings stay hidden from models.");
    if (row.report_id === null)
      return yield* labFailure(
        "not-found",
        `Job ${input.jobId} has no result yet (${row.status}).`,
      );
    const rows = yield* sql<{ readonly result_json: string }>`
      SELECT result_json FROM editorial_engine_reports WHERE report_id = ${row.report_id}
    `.pipe(storage);
    const result = parseJson(rows[0]!.result_json) as WorkerResult;
    const side = (arms: WorkerResult["arms"]["reference"]) =>
      arms.map((arm) => ({
        cutoff: arm.cutoff,
        run_id: arm.run_id,
        eligible: arm.eligible,
        top: arm.top.map(({ item_ids: _ids, member_keys: _keys, ...trend }) => trend),
      }));
    return {
      jobId: row.job_id,
      reference: side(result.arms.reference),
      candidate: side(result.arms.candidate),
    };
  });

  const shadowReport = Effect.fn("EngineExperimentService.shadowReport")(function* (jobId: string) {
    const row = yield* ownedJob(null, jobId);
    if (row.kind !== "shadow" || row.report_id === null) {
      return yield* labFailure("not-found", `Job ${jobId} is not a finished shadow job.`);
    }
    const rows = yield* sql<{ readonly report_json: string; readonly result_json: string }>`
        SELECT report_json, result_json FROM editorial_engine_reports WHERE report_id = ${row.report_id}
      `.pipe(storage);
    const report = parseJson(rows[0]!.report_json) as { shadow: ReturnType<typeof shadowCards> };
    return { row, report, result: parseJson(rows[0]!.result_json) as WorkerResult };
  });

  const shadowCardsOf: EngineExperimentServiceShape["shadowCards"] = (jobId) =>
    shadowReport(jobId).pipe(Effect.map(({ report }) => report.shadow.cards));

  const scoreShadow: EngineExperimentServiceShape["scoreShadow"] = Effect.fn(
    "EngineExperimentService.scoreShadow",
  )(function* (input) {
    const { row, report, result } = yield* shadowReport(input.jobId);
    const campaign = yield* selectCampaign(row.campaign_id).pipe(storage);
    const request = yield* sql<{ readonly created_at: string }>`
        SELECT created_at FROM editorial_engine_promotions WHERE request_id = ${campaign.request_id}
      `.pipe(storage);
    const file = yield* Effect.try({
      try: () =>
        parseJson(NodeFS.readFileSync(input.labelsPath, "utf8")) as {
          labels?: ReadonlyArray<CardLabel>;
        },
      catch: (cause) =>
        labFailure("invalid-change", `The labels could not be read: ${String(cause)}`),
    });
    const labels = (file.labels ?? []).map((label) => ({
      card_id: label.card_id,
      label: label.label,
      grade: label.grade ?? null,
    }));
    const gate = evaluateGate({
      result,
      members: report.shadow.members,
      labels,
      frozenDay: (request[0]?.created_at ?? "9999").slice(0, 10),
    });
    yield* sql`
        INSERT INTO editorial_engine_gates (gate_id, report_id, labels_hash, verdict, gate_json, recorded_by, created_at)
        VALUES (${`gate_${(yield* newId).replaceAll("-", "").slice(0, 16)}`}, ${row.report_id}, ${gate.labels_hash},
          ${gate.verdict}, ${toJson(gate)}, ${input.actor}, ${yield* nowIso})
      `.pipe(storage);
    return gate;
  });

  return EngineExperimentService.of({
    runDue,
    job,
    cancel,
    rankings,
    shadowCards: shadowCardsOf,
    scoreShadow,
  });
});

export const layer = Layer.effect(EngineExperimentService, make);

/** The server's background runner: one pass every `pollMs`, one job at a time. */
export const layerRunner = Layer.effectDiscard(
  Effect.gen(function* () {
    const experiments = yield* EngineExperimentService;
    const options = yield* EngineLabOptions;
    yield* experiments.runDue.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Engine lab pass failed").pipe(
          Effect.annotateLogs({ error: error.message }),
        ),
      ),
      Effect.repeat(Schedule.spaced(options.pollMs)),
      Effect.forkScoped,
    );
  }),
);
