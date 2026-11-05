// The only writer of the active engine pointer. A model may ask for a promotion; only the
// operator's command approves, rejects or reverts, and the nightly plan reads the pointer here.
import type { EnginePromotionView } from "@earlyscript/editorial-contracts/engineLab";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { DevelopmentReport } from "@earlyscript/engine-lab/compare";
import { reportHash } from "@earlyscript/engine-lab/compare";
import type { GateResult } from "@earlyscript/engine-lab/gate";
import {
  diffManifests,
  type EngineManifest,
  feedsHash,
  installedManifest,
  manifestHash,
  type ProductContext,
  staleReasons,
} from "@earlyscript/engine-lab/manifest";
import { type JobSpec, resultMismatch, type WorkerResult } from "@earlyscript/engine-lab/result";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { EditorialProfileService } from "./EditorialProfileService.ts";
import { EditorialSourcesService, type EnabledSources } from "./EditorialSourcesService.ts";
import {
  EngineLabOptions,
  insertManifest,
  installedSourceHash,
  labFailure,
  manifestIdOf,
  manifestOf,
  parseJson,
  readDefaultConfig,
  selectManifest,
  storageFailure,
} from "./engineLabSupport.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId, nowIso } from "./persistence/support.ts";

export interface ActiveEngine {
  readonly hash: string;
  readonly manifest: EngineManifest;
  readonly activationId: string;
}

/** What the nightly plan runs with, and which active manifest it came from. */
export interface PlannedEngine {
  readonly config: Record<string, unknown>;
  /** Null while the lab was never used: the plan is exactly the one before the lab. */
  readonly manifestHash: string | null;
  readonly engineSourceHash: string | null;
  /** Why the active manifest no longer matches the product's inputs; empty when it does. */
  readonly stale: ReadonlyArray<string>;
}

export interface ActivationRow {
  readonly activation_id: string;
  readonly seq: number;
  readonly kind: "install" | "promote" | "revert";
  readonly manifest_hash: string;
  readonly previous_hash: string | null;
  readonly request_id: string | null;
  readonly report_id: string | null;
  readonly actor: string;
  readonly reason: string;
  readonly created_at: string;
}

interface RequestRow {
  readonly request_id: string;
  readonly project_id: string;
  readonly candidate_hash: string;
  readonly report_id: string;
  readonly expected_active_hash: string;
  readonly reason: string;
  readonly thread_id: string | null;
  readonly status: EnginePromotionView["status"];
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
  readonly decided_at: string | null;
  readonly created_at: string;
}

interface ReportRow {
  readonly report_id: string;
  readonly job_id: string;
  readonly kind: "development" | "shadow";
  readonly report_json: string;
  readonly report_hash: string;
  readonly result_json: string;
}

export interface EnginePromotionServiceShape {
  /** The active manifest; installs the running engine as the first one on first use. */
  readonly active: Effect.Effect<ActiveEngine, ReturnType<typeof labFailure>>;
  readonly productContext: Effect.Effect<ProductContext, ReturnType<typeof labFailure>>;
  /** For EditorialJobsService.plan: never fails the nightly run, falls back to today's plan. */
  readonly planEngine: (input: {
    readonly defaultConfig: Record<string, unknown>;
    readonly enabled: EnabledSources;
  }) => Effect.Effect<PlannedEngine>;
  readonly request: (input: {
    readonly projectId: string;
    readonly threadId: string | null;
    readonly candidate: string;
    readonly reportId: string;
    readonly expectedActive: string;
    readonly reason: string;
  }) => Effect.Effect<EnginePromotionView, ReturnType<typeof labFailure>>;
  readonly listRequests: (
    projectId: string | null,
  ) => Effect.Effect<ReadonlyArray<EnginePromotionView>, ReturnType<typeof labFailure>>;
  /** Operator only: never reachable from an MCP tool. */
  readonly approve: (input: {
    readonly requestId: string;
    readonly actor: string;
    readonly reason: string;
  }) => Effect.Effect<ActivationRow, ReturnType<typeof labFailure>>;
  readonly reject: (input: {
    readonly requestId: string;
    readonly actor: string;
    readonly reason: string;
  }) => Effect.Effect<EnginePromotionView, ReturnType<typeof labFailure>>;
  /** Operator only: a new activation of the manifest the current one replaced. */
  readonly revert: (input: {
    readonly actor: string;
    readonly reason: string;
    readonly expectedActive: string;
  }) => Effect.Effect<ActivationRow, ReturnType<typeof labFailure>>;
  readonly history: Effect.Effect<ReadonlyArray<ActivationRow>, ReturnType<typeof labFailure>>;
}

export class EnginePromotionService extends Context.Service<
  EnginePromotionService,
  EnginePromotionServiceShape
>()("t3/editorial/EnginePromotionService") {}

const ACTIVATION_COLUMNS =
  "activation_id, seq, kind, manifest_hash, previous_hash, request_id, report_id, actor, reason, created_at";
const REQUEST_COLUMNS =
  "request_id, project_id, candidate_hash, report_id, expected_active_hash, reason, thread_id, status, " +
  "decided_by, decision_reason, decided_at, created_at";

/** Verifies a stored report against its signed worker result; null when it holds. */
function reportTampering(row: ReportRow, spec: JobSpec): string | null {
  const report = parseJson(row.report_json) as DevelopmentReport;
  if (reportHash(report) !== row.report_hash) return "the stored report differs from its hash";
  const result = parseJson(row.result_json) as WorkerResult;
  const mismatch = resultMismatch(spec, result);
  if (mismatch !== null) return mismatch;
  if (report.result_signature !== result.signature)
    return "the report was not computed from its result";
  return null;
}

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const options = yield* EngineLabOptions;
  const sources = yield* EditorialSourcesService;
  const profiles = yield* EditorialProfileService;
  const newId = yield* makeNewId;
  const storage = Effect.mapError(storageFailure);

  const productContext = Effect.gen(function* () {
    const enabled = yield* sources.enabledSources;
    const profile = yield* profiles.activeFile;
    return {
      profileHash: profile.hash,
      rank: [...enabled.rank],
      collect: [...enabled.collect],
      feedsHash: feedsHash(enabled.rssFeeds),
      engineSourceHash: installedSourceHash(options) ?? "unknown",
    } satisfies ProductContext;
  }).pipe(Effect.mapError(storageFailure));

  const defaultConfig = Effect.suspend(() =>
    Result.isSuccess(options.engine)
      ? Effect.try({
          try: () => readDefaultConfig(Result.getOrThrow(options.engine)),
          catch: storageFailure,
        })
      : Effect.fail(labFailure("executor-unavailable", "No trend engine is installed.")),
  );

  const selectActivation = (id: string) =>
    sql<ActivationRow>`SELECT ${sql.literal(ACTIVATION_COLUMNS)} FROM editorial_engine_activations WHERE activation_id = ${id}`;

  const appendActivation = Effect.fn("EnginePromotionService.appendActivation")(function* (
    input: Omit<ActivationRow, "seq" | "activation_id" | "created_at">,
  ) {
    const activationId = `act_${(yield* newId).replaceAll("-", "").slice(0, 16)}`;
    const createdAt = yield* nowIso;
    const seqRows = yield* sql<{
      readonly top: number | null;
    }>`SELECT MAX(seq) AS top FROM editorial_engine_activations`;
    const seq = (seqRows[0]?.top ?? 0) + 1;
    yield* sql`
        INSERT INTO editorial_engine_activations (
          activation_id, seq, kind, manifest_hash, previous_hash, request_id, report_id, actor, reason, created_at
        ) VALUES (
          ${activationId}, ${seq}, ${input.kind}, ${input.manifest_hash}, ${input.previous_hash},
          ${input.request_id}, ${input.report_id}, ${input.actor}, ${input.reason}, ${createdAt}
        )
      `;
    return {
      ...input,
      activation_id: activationId,
      seq,
      created_at: createdAt,
    } satisfies ActivationRow;
  });

  /**
   * The installed engine as a manifest: today's default configuration with the product's rank
   * sources, profile, feeds and code. It follows the product: when an input changes through
   * another flow, the next read installs the new one as another activation.
   */
  const active: EnginePromotionServiceShape["active"] = Effect.gen(function* () {
    const context = yield* productContext;
    const base = yield* defaultConfig;
    const enabled = yield* sources.enabledSources.pipe(Effect.mapError(storageFailure));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly manifest_hash: string;
            readonly activation_id: string;
          }>`
            SELECT manifest_hash, activation_id FROM editorial_engine_active WHERE id = 1
          `;
          const current = rows[0];
          if (current !== undefined) {
            const row = Option.getOrThrow(yield* selectManifest(sql, current.manifest_hash));
            const manifest = manifestOf(row);
            const stale = staleReasons(manifest, context);
            if (manifest.kind !== "installed" || stale.length === 0) {
              return { hash: current.manifest_hash, manifest, activationId: current.activation_id };
            }
          }
          const installed = installedManifest({
            config: { ...base, sources: [...enabled.rank] } as EngineConfig,
            profileHash: context.profileHash,
            sources: { rank: context.rank, collect: context.collect },
            feeds: enabled.rssFeeds,
            engineSourceHash: context.engineSourceHash,
          });
          const hash = manifestHash(installed);
          yield* insertManifest(sql, {
            hash,
            manifest: installed,
            files: {},
            projectId: null,
            threadId: null,
            intent: "The engine the product runs.",
            hypothesis: null,
            idempotencyKey: null,
            createdAt: yield* nowIso,
          });
          if (current?.manifest_hash === hash) {
            return { hash, manifest: installed, activationId: current.activation_id };
          }
          const activation = yield* appendActivation({
            kind: "install",
            manifest_hash: hash,
            previous_hash: current?.manifest_hash ?? null,
            request_id: null,
            report_id: null,
            actor: "system",
            reason:
              current === undefined
                ? "The engine running when the lab was first used."
                : "The product's profile, sources, feeds or engine changed outside the lab.",
          });
          yield* sql`
            INSERT INTO editorial_engine_active (id, manifest_hash, activation_id, updated_at)
            VALUES (1, ${hash}, ${activation.activation_id}, ${activation.created_at})
            ON CONFLICT (id) DO UPDATE SET
              manifest_hash = excluded.manifest_hash,
              activation_id = excluded.activation_id,
              updated_at = excluded.updated_at
          `;
          return { hash, manifest: installed, activationId: activation.activation_id };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(storageFailure(error)) }));
  });

  const planActive = Effect.fn("EnginePromotionService.planActive")(function* (
    input: Parameters<EnginePromotionServiceShape["planEngine"]>[0],
  ) {
    const today = { ...input.defaultConfig, sources: [...input.enabled.rank] };
    const code = installedSourceHash(options);
    const rows = yield* sql<{ readonly manifest_hash: string }>`
        SELECT manifest_hash FROM editorial_engine_active WHERE id = 1
      `;
    const current = rows[0];
    if (current === undefined)
      return { config: today, manifestHash: null, engineSourceHash: code, stale: [] };
    const row = yield* selectManifest(sql, current.manifest_hash);
    if (Option.isNone(row))
      return {
        config: today,
        manifestHash: null,
        engineSourceHash: code,
        stale: ["missing-manifest"],
      };
    const manifest = manifestOf(row.value);
    // The installed manifest records today's engine; it never freezes the product's switches.
    if (manifest.kind === "installed") {
      return {
        config: today,
        manifestHash: current.manifest_hash,
        engineSourceHash: code,
        stale: [],
      };
    }
    const context = yield* productContext;
    // A promoted manifest keeps its configuration; the product's switches stay the sources.
    return {
      config: {
        ...(manifest.config as unknown as Record<string, unknown>),
        sources: [...input.enabled.rank],
      },
      manifestHash: current.manifest_hash,
      engineSourceHash: code,
      stale: staleReasons(manifest, context),
    } satisfies PlannedEngine;
  });

  const planEngine: EnginePromotionServiceShape["planEngine"] = (input) =>
    planActive(input).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "The active engine manifest could not be read; the nightly run uses the default.",
        ).pipe(
          Effect.annotateLogs({ error: String(error) }),
          Effect.as({
            config: { ...input.defaultConfig, sources: [...input.enabled.rank] },
            manifestHash: null,
            engineSourceHash: installedSourceHash(options),
            stale: ["unreadable"],
          }),
        ),
      ),
    );

  const selectRequest = (requestId: string) =>
    sql<RequestRow>`SELECT ${sql.literal(REQUEST_COLUMNS)} FROM editorial_engine_promotions WHERE request_id = ${requestId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const selectReport = (reportId: string) =>
    sql<ReportRow>`
      SELECT report_id, job_id, kind, report_json, report_hash, result_json
      FROM editorial_engine_reports WHERE report_id = ${reportId}
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const jobSpec = (jobId: string) =>
    sql<{ readonly spec_json: string; readonly secret: string; readonly project_id: string }>`
      SELECT j.spec_json, j.secret, c.project_id FROM editorial_engine_jobs j
      JOIN editorial_engine_campaigns c ON c.campaign_id = j.campaign_id WHERE j.job_id = ${jobId}
    `.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return Option.none<{ spec: JobSpec; projectId: string }>();
        return Option.some({
          spec: { ...(parseJson(row.spec_json) as JobSpec), secret: row.secret },
          projectId: row.project_id,
        });
      }),
    );

  /** The shadow report and gate run for `requestId` by the operator, latest first. */
  const shadowGate = (requestId: string) =>
    sql<{
      readonly report_id: string;
      readonly verdict: GateResult["verdict"];
      readonly gate_json: string;
    }>`
      SELECT r.report_id, g.verdict, g.gate_json FROM editorial_engine_campaigns c
      JOIN editorial_engine_jobs j ON j.campaign_id = c.campaign_id
      JOIN editorial_engine_reports r ON r.job_id = j.job_id
      JOIN editorial_engine_gates g ON g.report_id = r.report_id
      WHERE c.kind = 'shadow' AND c.request_id = ${requestId}
      ORDER BY g.created_at DESC LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  /** What approval still needs, from the stored evidence; empty when it would pass. */
  const pendingChecks = Effect.fn("EnginePromotionService.pendingChecks")(function* (
    row: RequestRow,
    candidate: EngineManifest,
    report: ReportRow,
  ) {
    const checks: Array<string> = [];
    const parsed = parseJson(report.report_json) as DevelopmentReport;
    const performanceOnly =
      candidate.kind === "code" && parsed.kind === "development" && parsed.equivalent;
    if (!performanceOnly) {
      const gate = yield* shadowGate(row.request_id);
      if (Option.isNone(gate)) {
        checks.push(
          "shadow: a prospective shadow of at least 7 daily cutoffs after this request, labelled blind by Miguel (operator: engine-lab shadow-start)",
        );
      } else if (gate.value.verdict !== "pass") {
        checks.push(
          `shadow gate is ${gate.value.verdict}: ${(parseJson(gate.value.gate_json) as GateResult).reasons.join(" ")}`,
        );
      }
    }
    if (candidate.kind === "code") {
      const installed = installedSourceHash(options);
      if (installed !== candidate.code.engine_source_hash) {
        checks.push(
          "deploy: install the reviewed engine code whose source hash is the candidate's",
        );
      }
    }
    checks.push("operator: Miguel approves with engine-lab approve");
    return checks;
  });

  const viewOf = Effect.fn("EnginePromotionService.viewOf")(function* (row: RequestRow) {
    const candidate = manifestOf(Option.getOrThrow(yield* selectManifest(sql, row.candidate_hash)));
    const parent =
      candidate.parent === null ? Option.none() : yield* selectManifest(sql, candidate.parent);
    const report = Option.getOrThrow(yield* selectReport(row.report_id));
    return {
      requestId: row.request_id,
      candidateHash: row.candidate_hash,
      reportId: row.report_id,
      expectedActiveHash: row.expected_active_hash,
      status: row.status,
      reason: row.reason,
      pendingChecks: row.status === "requested" ? yield* pendingChecks(row, candidate, report) : [],
      diff: Option.isSome(parent) ? diffManifests(manifestOf(parent.value), candidate) : [],
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
    } satisfies EnginePromotionView;
  });

  const request: EnginePromotionServiceShape["request"] = Effect.fn(
    "EnginePromotionService.request",
  )(function* (input) {
    const candidate = yield* selectManifest(sql, input.candidate).pipe(storage);
    if (Option.isNone(candidate) || candidate.value.project_id !== input.projectId) {
      return yield* labFailure("not-found", `No candidate ${input.candidate} in this project.`);
    }
    const report = yield* selectReport(input.reportId).pipe(storage);
    if (Option.isNone(report))
      return yield* labFailure("not-found", `No report ${input.reportId}.`);
    const spec = yield* jobSpec(report.value.job_id).pipe(storage);
    if (Option.isNone(spec) || spec.value.projectId !== input.projectId) {
      return yield* labFailure("permission-denied", "That report belongs to another project.");
    }
    const parsed = parseJson(report.value.report_json) as DevelopmentReport;
    if (parsed.candidate_hash !== candidate.value.manifest_hash) {
      return yield* labFailure("artifact-mismatch", "That report evaluated another candidate.");
    }
    const tampered = reportTampering(report.value, spec.value.spec);
    if (tampered !== null)
      return yield* labFailure("artifact-mismatch", `The report does not verify: ${tampered}.`);
    const current = yield* active;
    const expected = yield* selectManifest(sql, input.expectedActive).pipe(storage);
    if (Option.isNone(expected) || expected.value.manifest_hash !== current.hash) {
      return yield* labFailure(
        "stale-base",
        `The active engine is ${manifestIdOf(current.hash)}; read it again before asking.`,
      );
    }
    if (parsed.reference_hash !== current.hash) {
      return yield* labFailure(
        "stale-base",
        "The report compared the candidate with an engine that is no longer active.",
      );
    }
    const requestId = `req_${(yield* newId).replaceAll("-", "").slice(0, 16)}`;
    yield* sql`
        INSERT INTO editorial_engine_promotions (
          request_id, project_id, candidate_hash, report_id, expected_active_hash, reason, thread_id, status, created_at
        ) VALUES (
          ${requestId}, ${input.projectId}, ${candidate.value.manifest_hash}, ${input.reportId}, ${current.hash},
          ${input.reason}, ${input.threadId}, 'requested', ${yield* nowIso}
        )
      `.pipe(storage);
    return yield* viewOf(Option.getOrThrow(yield* selectRequest(requestId).pipe(storage))).pipe(
      storage,
    );
  });

  const listRequests: EnginePromotionServiceShape["listRequests"] = Effect.fn(
    "EnginePromotionService.listRequests",
  )(function* (projectId) {
    const rows =
      projectId === null
        ? yield* sql<RequestRow>`SELECT ${sql.literal(REQUEST_COLUMNS)} FROM editorial_engine_promotions ORDER BY created_at DESC`
        : yield* sql<RequestRow>`SELECT ${sql.literal(REQUEST_COLUMNS)} FROM editorial_engine_promotions WHERE project_id = ${projectId} ORDER BY created_at DESC`;
    return yield* Effect.forEach(rows, viewOf);
  }, storage);

  const markStale = Effect.fn("EnginePromotionService.markStale")(function* (
    requestId: string,
    why: string,
  ) {
    yield* sql`
      UPDATE editorial_engine_promotions SET status = 'stale', decided_by = 'system', decision_reason = ${why},
        decided_at = ${yield* nowIso}
      WHERE request_id = ${requestId} AND status = 'requested'
    `.pipe(storage);
    return yield* labFailure("stale-base", why);
  });

  const approve: EnginePromotionServiceShape["approve"] = Effect.fn(
    "EnginePromotionService.approve",
  )(function* (input) {
    const row = yield* selectRequest(input.requestId).pipe(storage);
    if (Option.isNone(row))
      return yield* labFailure("not-found", `No promotion request ${input.requestId}.`);
    if (row.value.status !== "requested") {
      return yield* labFailure("stale-base", `Request ${input.requestId} is ${row.value.status}.`);
    }
    const request = row.value;
    const candidate = manifestOf(
      Option.getOrThrow(yield* selectManifest(sql, request.candidate_hash).pipe(storage)),
    );
    const report = Option.getOrThrow(yield* selectReport(request.report_id).pipe(storage));
    const spec = Option.getOrThrow(yield* jobSpec(report.job_id).pipe(storage));
    const tampered = reportTampering(report, spec.spec);
    if (tampered !== null)
      return yield* labFailure("artifact-mismatch", `The report does not verify: ${tampered}.`);
    const current = yield* active;
    if (current.hash !== request.expected_active_hash) {
      return yield* markStale(request.request_id, "The active engine changed after the request.");
    }
    const reasons = staleReasons(candidate, yield* productContext);
    const inputs = reasons.filter((reason) => reason !== "engine-code");
    if (inputs.length > 0) {
      return yield* markStale(
        request.request_id,
        `The product's ${inputs.join(", ")} changed since the candidate was made.`,
      );
    }
    if (reasons.includes("engine-code")) {
      return yield* candidate.kind === "code"
        ? labFailure(
            "artifact-mismatch",
            "The installed engine is not the candidate's code: deploy the reviewed code first.",
          )
        : markStale(
            request.request_id,
            "Another engine was installed since the candidate was made.",
          );
    }
    const checks = (yield* pendingChecks(request, candidate, report).pipe(storage)).filter(
      (check) => !check.startsWith("operator:"),
    );
    if (checks.length > 0) return yield* labFailure("insufficient-evidence", checks.join(" "));
    const gate = yield* shadowGate(request.request_id).pipe(storage);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const activation = yield* appendActivation({
            kind: "promote",
            manifest_hash: request.candidate_hash,
            previous_hash: current.hash,
            request_id: request.request_id,
            report_id: Option.match(gate, {
              onNone: () => request.report_id,
              onSome: (g) => g.report_id,
            }),
            actor: input.actor,
            reason: input.reason,
          });
          const moved = yield* sql<{ readonly manifest_hash: string }>`
              UPDATE editorial_engine_active SET manifest_hash = ${request.candidate_hash},
                activation_id = ${activation.activation_id}, updated_at = ${activation.created_at}
              WHERE id = 1 AND manifest_hash = ${request.expected_active_hash}
              RETURNING manifest_hash
            `;
          if (moved.length !== 1)
            return yield* labFailure(
              "stale-base",
              "Another promotion moved the active engine first.",
            );
          const decided = yield* sql<{ readonly request_id: string }>`
              UPDATE editorial_engine_promotions SET status = 'approved', decided_by = ${input.actor},
                decision_reason = ${input.reason}, decided_at = ${activation.created_at}
              WHERE request_id = ${request.request_id} AND status = 'requested'
              RETURNING request_id
            `;
          if (decided.length !== 1)
            return yield* labFailure("stale-base", "The request was decided meanwhile.");
          return activation;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(storageFailure(error)) }));
  });

  const reject: EnginePromotionServiceShape["reject"] = Effect.fn("EnginePromotionService.reject")(
    function* (input) {
      const decided = yield* sql<{ readonly request_id: string }>`
        UPDATE editorial_engine_promotions SET status = 'rejected', decided_by = ${input.actor},
          decision_reason = ${input.reason}, decided_at = ${yield* nowIso}
        WHERE request_id = ${input.requestId} AND status = 'requested'
        RETURNING request_id
      `.pipe(storage);
      if (decided.length !== 1)
        return yield* labFailure("not-found", `No open request ${input.requestId}.`);
      return yield* viewOf(
        Option.getOrThrow(yield* selectRequest(input.requestId).pipe(storage)),
      ).pipe(storage);
    },
  );

  const revert: EnginePromotionServiceShape["revert"] = Effect.fn("EnginePromotionService.revert")(
    function* (input) {
      const current = yield* active;
      const expected = yield* selectManifest(sql, input.expectedActive).pipe(storage);
      if (Option.isNone(expected) || expected.value.manifest_hash !== current.hash) {
        return yield* labFailure(
          "stale-base",
          `The active engine is ${manifestIdOf(current.hash)}.`,
        );
      }
      const activation = Option.fromNullishOr(
        (yield* selectActivation(current.activationId).pipe(storage))[0],
      );
      const previous = Option.flatMap(activation, (row) => Option.fromNullishOr(row.previous_hash));
      if (Option.isNone(previous))
        return yield* labFailure("not-found", "The active engine replaced none.");
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const next = yield* appendActivation({
              kind: "revert",
              manifest_hash: previous.value,
              previous_hash: current.hash,
              request_id: null,
              report_id: null,
              actor: input.actor,
              reason: input.reason,
            });
            const moved = yield* sql<{ readonly manifest_hash: string }>`
              UPDATE editorial_engine_active SET manifest_hash = ${previous.value},
                activation_id = ${next.activation_id}, updated_at = ${next.created_at}
              WHERE id = 1 AND manifest_hash = ${current.hash}
              RETURNING manifest_hash
            `;
            if (moved.length !== 1)
              return yield* labFailure("stale-base", "The active engine moved meanwhile.");
            return next;
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(storageFailure(error)) }));
    },
  );

  const history = sql<ActivationRow>`
    SELECT ${sql.literal(ACTIVATION_COLUMNS)} FROM editorial_engine_activations ORDER BY seq DESC
  `.pipe(storage);

  return EnginePromotionService.of({
    active,
    productContext,
    planEngine,
    request,
    listRequests,
    approve,
    reject,
    revert,
    history,
  });
});

export const layer = Layer.effect(EnginePromotionService, make);
