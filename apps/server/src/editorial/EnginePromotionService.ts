// @effect-diagnostics globalDate:off nodeBuiltinImport:off - compares stored instants with the cutoffs they observed; reads the installed sources a patch was made over.
// The only writer of the active engine pointer. A model may ask for a promotion; only the
// operator's command approves, rejects or reverts, and the nightly plan reads the pointer here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { EnginePromotionView } from "@earlyscript/editorial-contracts/engineLab";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { DevelopmentReport } from "@earlyscript/engine-lab/compare";
import { reportHash } from "@earlyscript/engine-lab/compare";
import { artifactCli, artifactProblem, prepareArtifact } from "@earlyscript/engine-lab/artifact";
import { GATE_RULE, type GateResult } from "@earlyscript/engine-lab/gate";
import {
  diffManifests,
  type EngineManifest,
  feedsHash,
  installedManifest,
  manifestHash,
  type ProductContext,
  staleReasons,
} from "@earlyscript/engine-lab/manifest";
import { unifiedDiff } from "@earlyscript/engine-lab/patch";
import { type JobSpec, resultMismatch, type WorkerResult } from "@earlyscript/engine-lab/result";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { EditorialProfileService } from "./EditorialProfileService.ts";
import { EditorialSourcesService, type EnabledSources } from "./EditorialSourcesService.ts";
import {
  EngineLabOptions,
  filesOf,
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
  /** The source hash of the code the run executes: the installed engine's or the artifact's. */
  readonly engineSourceHash: string | null;
  /** The artifact CLI of a code manifest; null runs the installed engine. */
  readonly cli: string | null;
  /** Set when the active manifest's code cannot run as approved: the run fails instead. */
  readonly blocked: string | null;
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
  /** Operator only: what an approval would activate, the patch and configuration in full. */
  readonly review: (
    requestId: string,
  ) => Effect.Effect<RequestReview, ReturnType<typeof labFailure>>;
}

export interface RequestReview {
  readonly request: EnginePromotionView;
  readonly kind: EngineManifest["kind"];
  /** The configuration change, key by key, against the manifest the candidate came from. */
  readonly configDiff: ReturnType<typeof diffManifests>;
  /** The unified diff a code candidate brings, as the model wrote it; null for config. */
  readonly patch: string | null;
  /** The files it changes, by repository path, with their new sha256. */
  readonly files: Readonly<Record<string, string>>;
  /** What the evidence shows, in words the operator reads before approving. */
  readonly evidence: string;
}

/** Equivalence in development alone needs this many distinct days to skip the labelled shadow. */
const EQUIVALENCE_MIN_DEV_DAYS = 5;

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
    const live = { engineSourceHash: code, cli: null, blocked: null };
    if (current === undefined) return { config: today, manifestHash: null, ...live, stale: [] };
    const row = yield* selectManifest(sql, current.manifest_hash);
    if (Option.isNone(row))
      return { config: today, manifestHash: null, ...live, stale: ["missing-manifest"] };
    const manifest = manifestOf(row.value);
    // The installed manifest records today's engine; it never freezes the product's switches.
    if (manifest.kind === "installed") {
      return { config: today, manifestHash: current.manifest_hash, ...live, stale: [] };
    }
    const context = yield* productContext;
    // Approved code runs from its artifact, verified now; the installed engine stays as it is.
    const patched = Object.keys(manifest.code.files).length > 0;
    const engine = patched
      ? {
          engineSourceHash: manifest.code.engine_source_hash,
          cli: artifactCli(options.artifactsRoot, manifest.code.engine_source_hash),
          blocked: artifactProblem(options.artifactsRoot, manifest.code.engine_source_hash),
        }
      : live;
    // A promoted manifest keeps its configuration; the product's switches stay the sources.
    return {
      config: {
        ...(manifest.config as unknown as Record<string, unknown>),
        sources: [...input.enabled.rank],
      },
      manifestHash: current.manifest_hash,
      ...engine,
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
            cli: null,
            blocked: null,
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
      readonly result_json: string;
      readonly started_at: string | null;
    }>`
      SELECT r.report_id, g.verdict, g.gate_json, r.result_json, j.started_at FROM editorial_engine_campaigns c
      JOIN editorial_engine_jobs j ON j.campaign_id = c.campaign_id
      JOIN editorial_engine_reports r ON r.job_id = j.job_id
      JOIN editorial_engine_gates g ON g.report_id = r.report_id
      WHERE c.kind = 'shadow' AND c.request_id = ${requestId}
      ORDER BY g.created_at DESC LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  /** The latest shadow report of `requestId`, gate or not, with how its job was observed. */
  const shadowReport = (requestId: string) =>
    sql<{
      readonly report_id: string;
      readonly report_json: string;
      readonly result_json: string;
      readonly started_at: string | null;
    }>`
      SELECT r.report_id, r.report_json, r.result_json, j.started_at FROM editorial_engine_campaigns c
      JOIN editorial_engine_jobs j ON j.campaign_id = c.campaign_id
      JOIN editorial_engine_reports r ON r.job_id = j.job_id
      WHERE c.kind = 'shadow' AND c.request_id = ${requestId}
      ORDER BY r.created_at DESC LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  /**
   * Why a stored shadow does not count as observed now: each cutoff after the freeze, viewed by
   * the executor only once it had passed, the job started after the last one, and every cutoff
   * behind this server's clock at approval. Null when it holds.
   */
  const unobserved = (
    stored: { readonly result_json: string; readonly started_at: string | null },
    frozenAt: string,
    nowMs: number,
  ): string | null => {
    const result = parseJson(stored.result_json) as WorkerResult;
    const views = result.views ?? [];
    const cutoffs = result.arms.reference.map((arm) => arm.cutoff);
    if (new Set(cutoffs.map((c) => c.slice(0, 10))).size < GATE_RULE.min_cutoffs)
      return `the shadow has fewer than ${GATE_RULE.min_cutoffs} distinct days`;
    if (cutoffs.some((cutoff) => cutoff.slice(0, 10) <= frozenAt.slice(0, 10)))
      return "a shadow cutoff is not after the request";
    if (views.length !== cutoffs.length || views.some((v, k) => v.cutoff !== cutoffs[k]))
      return "the shadow carries no view of each cutoff";
    if (views.some((view) => !(Date.parse(view.observed_at) >= Date.parse(view.cutoff))))
      return "a shadow cutoff was viewed before it passed";
    const last = Date.parse(cutoffs.at(-1)!);
    if (stored.started_at === null || !(Date.parse(stored.started_at) >= last))
      return "the shadow job started before its last cutoff";
    if (nowMs < last) return "the shadow's last cutoff is still ahead of this server's clock";
    return null;
  };

  /** What the stored evidence supports, and what approval still needs; checks empty when it would pass. */
  const assess = Effect.fn("EnginePromotionService.assess")(function* (
    row: RequestRow,
    candidate: EngineManifest,
    report: ReportRow,
  ) {
    const checks: Array<string> = [];
    const nowMs = yield* Clock.currentTimeMillis;
    const parsed = parseJson(report.report_json) as DevelopmentReport;
    const devDays = new Set(parsed.cutoffs.map((cutoff) => cutoff.slice(0, 10))).size;
    let evidence = "none yet";
    if (candidate.kind === "code" && parsed.kind === "development" && parsed.equivalent) {
      // Outputs unchanged: a performance-only candidate, never shown as a measured improvement.
      if (devDays >= EQUIVALENCE_MIN_DEV_DAYS) {
        evidence = `No change of outputs observed over ${devDays} development days. This is not a measured improvement, and it says nothing about inputs those days did not have.`;
      } else {
        const shadow = yield* shadowReport(row.request_id);
        const shadowParsed = Option.map(
          shadow,
          (value) => parseJson(value.report_json) as DevelopmentReport,
        );
        const why = Option.isNone(shadow)
          ? "no equivalence shadow"
          : unobserved(shadow.value, row.created_at, nowMs);
        if (why === null && Option.isSome(shadowParsed) && shadowParsed.value.equivalent) {
          evidence = `No change of outputs observed over ${GATE_RULE.min_cutoffs}+ shadow days after the request. This is not a measured improvement.`;
        } else {
          checks.push(
            `equivalence: ${devDays} development days; skipping the labelled shadow needs ${EQUIVALENCE_MIN_DEV_DAYS} distinct development days or a ${GATE_RULE.min_cutoffs}-day shadow with unchanged outputs (${why ?? "its outputs changed"}; operator: engine-lab shadow-start)`,
          );
        }
      }
    } else {
      const gate = yield* shadowGate(row.request_id);
      if (Option.isNone(gate)) {
        checks.push(
          "shadow: a prospective shadow of at least 7 daily cutoffs after this request, labelled blind by Miguel (operator: engine-lab shadow-start)",
        );
      } else if (gate.value.verdict !== "pass") {
        checks.push(
          `shadow gate is ${gate.value.verdict}: ${(parseJson(gate.value.gate_json) as GateResult).reasons.join(" ")}`,
        );
      } else {
        const why = unobserved(gate.value, row.created_at, nowMs);
        if (why !== null) checks.push(`shadow: ${why}`);
        else
          evidence = `Shadow gate pass over Miguel's blind labels: ${(parseJson(gate.value.gate_json) as GateResult).reasons.length === 0 ? "every rule met" : "see the gate"}.`;
      }
    }
    checks.push("operator: Miguel approves with engine-lab approve");
    return { checks, evidence };
  });

  const pendingChecks = (row: RequestRow, candidate: EngineManifest, report: ReportRow) =>
    assess(row, candidate, report).pipe(Effect.map(({ checks }) => checks));

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
    // The pointer as it is: reading it must not install anything, or approving would move the
    // very engine the request expects.
    const pointer = yield* sql<{ readonly manifest_hash: string }>`
      SELECT manifest_hash FROM editorial_engine_active WHERE id = 1
    `.pipe(storage);
    const current = { hash: pointer[0]?.manifest_hash ?? "" };
    if (current.hash !== request.expected_active_hash) {
      return yield* markStale(request.request_id, "The active engine changed after the request.");
    }
    const context = yield* productContext;
    const reasons = staleReasons(candidate, context);
    const inputs = reasons.filter((reason) => reason !== "engine-code");
    if (inputs.length > 0) {
      return yield* markStale(
        request.request_id,
        `The product's ${inputs.join(", ")} changed since the candidate was made.`,
      );
    }
    // Another installed engine stales the candidate, unless what was installed is exactly the
    // candidate's own code: then the artifact and the installed engine are the same sources.
    const sameCode = context.engineSourceHash === candidate.code.engine_source_hash;
    if (reasons.includes("engine-code") && !sameCode) {
      return yield* markStale(
        request.request_id,
        "Another engine was installed since the candidate was made.",
      );
    }
    const checks = (yield* pendingChecks(request, candidate, report).pipe(storage)).filter(
      (check) => !check.startsWith("operator:"),
    );
    if (checks.length > 0) return yield* labFailure("insufficient-evidence", checks.join(" "));
    // Code: build its artifact by hash, away from the installed engine, before the pointer moves.
    if (Object.keys(candidate.code.files).length > 0) {
      const engineRoot = options.engineRoot;
      if (engineRoot === null) {
        return yield* labFailure("unsupported-change", "Code artifacts need the engine's sources.");
      }
      const row = Option.getOrThrow(
        yield* selectManifest(sql, request.candidate_hash).pipe(storage),
      );
      yield* Effect.try({
        try: () =>
          prepareArtifact({
            root: options.artifactsRoot,
            engineRoot,
            files: filesOf(row),
            fileHashes: candidate.code.files,
            sourceHash: candidate.code.engine_source_hash,
          }),
        catch: (cause) =>
          labFailure(
            "artifact-mismatch",
            `The code artifact could not be built: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });
    }
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

  const review: EnginePromotionServiceShape["review"] = Effect.fn("EnginePromotionService.review")(
    function* (requestId) {
      const row = yield* selectRequest(requestId).pipe(storage);
      if (Option.isNone(row))
        return yield* labFailure("not-found", `No promotion request ${requestId}.`);
      const stored = Option.getOrThrow(
        yield* selectManifest(sql, row.value.candidate_hash).pipe(storage),
      );
      const candidate = manifestOf(stored);
      const parent =
        candidate.parent === null
          ? Option.none()
          : yield* selectManifest(sql, candidate.parent).pipe(storage);
      const report = Option.getOrThrow(yield* selectReport(row.value.report_id).pipe(storage));
      const files = filesOf(stored);
      // The diff against the files the patch was made over: the installed engine's sources.
      const patch =
        Object.keys(files).length === 0
          ? null
          : Object.entries(files)
              .map(([path, after]) => {
                const base =
                  options.engineRoot === null
                    ? ""
                    : NodeFS.readFileSync(NodePath.join(options.engineRoot, path), "utf8");
                return unifiedDiff(path, base, after);
              })
              .join("");
      const { evidence } = yield* assess(row.value, candidate, report).pipe(storage);
      return {
        request: yield* viewOf(row.value).pipe(storage),
        kind: candidate.kind,
        configDiff: Option.isSome(parent) ? diffManifests(manifestOf(parent.value), candidate) : [],
        patch,
        files: candidate.code.files,
        evidence,
      } satisfies RequestReview;
    },
  );

  return EnginePromotionService.of({
    active,
    review,
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
