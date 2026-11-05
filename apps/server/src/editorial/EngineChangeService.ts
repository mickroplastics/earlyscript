// @effect-diagnostics nodeBuiltinImport:off - a code candidate's base files are read from the installed engine.
// Candidates, campaigns and the budget of evaluations. A candidate is an immutable manifest of
// the project that made it; an evaluation takes one seat of an operator's campaign, in one
// transaction, whatever thread or key asks for it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  EngineCampaignView,
  EngineManifestView,
} from "@earlyscript/editorial-contracts/engineLab";
import { canonicalJson, sha256 } from "@earlyscript/engine-lab/hash";
import { GATE_RULE, GATE_RULE_HASH } from "@earlyscript/engine-lab/gate";
import { assertUnderRoots, canonicalInputs } from "@earlyscript/engine-lab/inputs";
import { engineSourceHash } from "@earlyscript/engine-lab/hash";
import {
  codeCandidate,
  configCandidate,
  diffManifests,
  type EngineManifest,
  manifestHash,
} from "@earlyscript/engine-lab/manifest";
import { applyFilePatch, parsePatch } from "@earlyscript/engine-lab/patch";
import {
  applyConfigChange,
  assertNotSealed,
  CODE_FILES,
  cutoffDays,
  LAB_POLICY_VERSION,
  RANK_VALUE_NAMES,
  UNSUPPORTED_CHANGE_KINDS,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from "@earlyscript/engine-lab/policy";
import { JOB_SPEC_SCHEMA, type JobSpec } from "@earlyscript/engine-lab/result";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { EnginePromotionService } from "./EnginePromotionService.ts";
import {
  EngineLabOptions,
  filesOf,
  fromPolicy,
  insertManifest,
  labFailure,
  type ManifestRow,
  manifestIdOf,
  manifestOf,
  manifestView,
  parseJson,
  selectManifest,
  storageFailure,
  toJson,
} from "./engineLabSupport.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId, nowIso } from "./persistence/support.ts";

const CAMPAIGN_SCHEMA = "earlyscript.engine-lab-campaign/1";

/** What the operator fixes before the first evaluation; a model never sets any of it. */
export interface CampaignPolicy {
  readonly schema: typeof CAMPAIGN_SCHEMA;
  readonly policy_version: typeof LAB_POLICY_VERSION;
  readonly gate_rule_hash: string;
  readonly cutoffs: ReadonlyArray<string>;
  readonly executor: "local" | "remote";
  readonly corpus_dir: string;
  readonly profile_path: string;
  readonly cache_file: string | null;
  readonly cache_only: boolean;
  readonly models_dir: string | null;
  readonly embedder: "local" | "synthetic";
  readonly workers: number;
  /** Card and label files on this server, read only by the evaluator. */
  readonly labels: { readonly cards: string; readonly labels: string } | null;
  readonly judge: { readonly cards: string; readonly labels: string } | null;
  /** Roots the executor may read inputs from; it resolves every input against them again. */
  readonly input_roots: ReadonlyArray<string>;
  /** Roots on this server the label and card files must resolve inside. */
  readonly label_roots: ReadonlyArray<string>;
}

export interface CampaignRow {
  readonly campaign_id: string;
  readonly project_id: string;
  readonly kind: "development" | "shadow";
  readonly reference_hash: string;
  readonly request_id: string | null;
  readonly policy_json: string;
  readonly policy_hash: string;
  readonly budget: number;
  readonly status: "open" | "closed";
  readonly created_by: string;
  readonly created_at: string;
}

const CAMPAIGN_COLUMNS =
  "campaign_id, project_id, kind, reference_hash, request_id, policy_json, policy_hash, budget, status, created_by, created_at";

export const policyOf = (row: CampaignRow) => parseJson(row.policy_json) as CampaignPolicy;

export interface CreateCampaignInput {
  readonly projectId: string;
  readonly kind: "development" | "shadow";
  readonly budget: number;
  readonly policy: Omit<CampaignPolicy, "schema" | "policy_version" | "gate_rule_hash">;
  readonly actor: string;
  /** Shadow only: the promotion request whose candidate it runs against the active engine. */
  readonly requestId?: string;
  /** Shadow only: the reference is the request's expected active engine. */
  readonly referenceHash?: string;
}

export interface CandidateChangeInput {
  readonly projectId: string;
  readonly threadId: string | null;
  readonly base: string;
  readonly intent: string;
  readonly hypothesis: string;
  readonly idempotencyKey: string;
  readonly change: Readonly<Record<string, unknown>>;
}

export interface CandidateResult {
  readonly candidate: EngineManifestView;
  readonly created: boolean;
  readonly diff: ReturnType<typeof diffManifests>;
  readonly risks: ReadonlyArray<string>;
}

export interface EngineChangeServiceShape {
  readonly createCampaign: (
    input: CreateCampaignInput,
  ) => Effect.Effect<EngineCampaignView, ReturnType<typeof labFailure>>;
  readonly closeCampaign: (
    campaignId: string,
    actor: string,
  ) => Effect.Effect<EngineCampaignView, ReturnType<typeof labFailure>>;
  readonly campaigns: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<EngineCampaignView>, ReturnType<typeof labFailure>>;
  readonly campaign: (
    campaignId: string,
  ) => Effect.Effect<Option.Option<CampaignRow>, ReturnType<typeof labFailure>>;
  readonly createCandidate: (
    input: CandidateChangeInput,
  ) => Effect.Effect<CandidateResult, ReturnType<typeof labFailure>>;
  readonly candidate: (
    projectId: string,
    ref: string,
  ) => Effect.Effect<
    EngineManifestView & { readonly diff: ReturnType<typeof diffManifests> },
    ReturnType<typeof labFailure>
  >;
  /** Reserves a seat and queues the job; the same candidate or key answers the same job. */
  readonly evaluate: (input: {
    readonly projectId: string;
    readonly threadId: string | null;
    readonly candidate: string;
    readonly campaignId: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<
    { readonly jobId: string; readonly created: boolean; readonly remaining: number },
    ReturnType<typeof labFailure>
  >;
  /** Operator only: queues the shadow job of a shadow campaign. */
  readonly startShadow: (
    campaignId: string,
  ) => Effect.Effect<{ readonly jobId: string }, ReturnType<typeof labFailure>>;
  /** What a candidate may change and within which bounds. */
  readonly editable: (base: EngineManifest) => Record<string, unknown>;
  /** The active engine's pure computation files, for a code patch. */
  readonly codeFiles: Effect.Effect<
    { readonly baseSourceHash: string; readonly files: Readonly<Record<string, string>> },
    ReturnType<typeof labFailure>
  >;
}

export class EngineChangeService extends Context.Service<
  EngineChangeService,
  EngineChangeServiceShape
>()("t3/editorial/EngineChangeService") {}

const MAX_TEXT = 2_000;

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const options = yield* EngineLabOptions;
  const promotion = yield* EnginePromotionService;
  const crypto = yield* Crypto.Crypto;
  const newId = yield* makeNewId;
  const storage = Effect.mapError(storageFailure);

  const selectCampaign = (campaignId: string) =>
    sql<CampaignRow>`SELECT ${sql.literal(CAMPAIGN_COLUMNS)} FROM editorial_engine_campaigns WHERE campaign_id = ${campaignId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const usedSeats = (campaignId: string) =>
    sql<{
      readonly used: number;
    }>`SELECT COUNT(*) AS used FROM editorial_engine_attempts WHERE campaign_id = ${campaignId}`.pipe(
      Effect.map((rows) => rows[0]?.used ?? 0),
    );

  const campaignView = Effect.fn("EngineChangeService.campaignView")(function* (row: CampaignRow) {
    const policy = policyOf(row);
    const used = row.kind === "development" ? yield* usedSeats(row.campaign_id) : 0;
    return {
      campaignId: row.campaign_id,
      kind: row.kind,
      referenceHash: row.reference_hash,
      budget: row.budget,
      used,
      remaining: Math.max(0, row.budget - used),
      status: row.status,
      cutoffs: policy.cutoffs,
      executor: policy.executor,
      labels: policy.labels === null ? null : "operator labels (human)",
      judge: policy.judge === null ? null : "judge labels (not validated item by item)",
      createdAt: row.created_at,
    } satisfies EngineCampaignView;
  });

  const createCampaign: EngineChangeServiceShape["createCampaign"] = Effect.fn(
    "EngineChangeService.createCampaign",
  )(function* (input) {
    if (!Number.isInteger(input.budget) || input.budget < 0)
      return yield* labFailure("invalid-change", "The budget is a whole number.");
    if (input.policy.cutoffs.length === 0)
      return yield* labFailure("invalid-change", "A campaign needs cutoffs.");
    const cutoffs = yield* Effect.try({
      try: () => cutoffDays(input.policy.cutoffs),
      catch: fromPolicy,
    });
    const labelFiles = [input.policy.labels, input.policy.judge].flatMap((entry) =>
      entry === null ? [] : [entry.cards, entry.labels],
    );
    const executorPaths = [
      input.policy.corpus_dir,
      input.policy.profile_path,
      ...(input.policy.cache_file === null ? [] : [input.policy.cache_file]),
      ...(input.policy.models_dir === null ? [] : [input.policy.models_dir]),
    ];
    yield* Effect.try({
      try: () => assertNotSealed({ cutoffs, paths: [...executorPaths, ...labelFiles] }),
      catch: fromPolicy,
    });
    if (input.policy.executor === "remote" && options.remote === null) {
      return yield* labFailure(
        "executor-unavailable",
        "No remote executor is configured (EARLYSCRIPT_ENGINE_LAB_REMOTE).",
      );
    }
    // Canonical paths: a link may name an innocent path and point at the frozen evaluation.
    // The executor's inputs are resolved here when it is this machine, and always by the
    // executor itself; the label files are always this server's.
    const executorReal = yield* Effect.try({
      try: () => {
        if (input.policy.executor === "remote") {
          assertUnderRoots(input.policy.input_roots, executorPaths);
          return new Map(executorPaths.map((path) => [path, path]));
        }
        return canonicalInputs(input.policy.input_roots, [
          { path: input.policy.corpus_dir, kind: "tree" },
          { path: input.policy.profile_path, kind: "file" },
          ...(input.policy.cache_file === null
            ? []
            : [{ path: input.policy.cache_file, kind: "optional-file" as const }]),
          ...(input.policy.models_dir === null
            ? []
            : [{ path: input.policy.models_dir, kind: "tree" as const }]),
        ]);
      },
      catch: fromPolicy,
    });
    const labelReal = yield* Effect.try({
      try: () =>
        labelFiles.length === 0
          ? new Map<string, string>()
          : canonicalInputs(
              input.policy.label_roots,
              labelFiles.map((path) => ({ path, kind: "file" as const })),
            ),
      catch: fromPolicy,
    });
    if (input.kind === "shadow") {
      // The gate's minimum, checked before anything runs: distinct days after the request.
      const request = yield* sql<{ readonly created_at: string }>`
        SELECT created_at FROM editorial_engine_promotions WHERE request_id = ${input.requestId ?? ""}
      `.pipe(storage);
      const frozenDay = request[0]?.created_at.slice(0, 10);
      if (frozenDay === undefined)
        return yield* labFailure("not-found", "A shadow needs its promotion request.");
      const future = cutoffs.filter((cutoff) => cutoff.slice(0, 10) > frozenDay);
      if (future.length !== cutoffs.length || future.length < GATE_RULE.min_cutoffs) {
        return yield* labFailure(
          "insufficient-evidence",
          `A shadow needs at least ${GATE_RULE.min_cutoffs} distinct days after ${frozenDay}; ${future.length} of ${cutoffs.length} are.`,
        );
      }
    }
    const reference = input.referenceHash ?? (yield* promotion.active).hash;
    const policy: CampaignPolicy = {
      schema: CAMPAIGN_SCHEMA,
      policy_version: LAB_POLICY_VERSION,
      gate_rule_hash: GATE_RULE_HASH,
      ...input.policy,
      cutoffs,
      corpus_dir: executorReal.get(input.policy.corpus_dir)!,
      profile_path: executorReal.get(input.policy.profile_path)!,
      cache_file:
        input.policy.cache_file === null ? null : executorReal.get(input.policy.cache_file)!,
      models_dir:
        input.policy.models_dir === null ? null : executorReal.get(input.policy.models_dir)!,
      labels:
        input.policy.labels === null
          ? null
          : {
              cards: labelReal.get(input.policy.labels.cards)!,
              labels: labelReal.get(input.policy.labels.labels)!,
            },
      judge:
        input.policy.judge === null
          ? null
          : {
              cards: labelReal.get(input.policy.judge.cards)!,
              labels: labelReal.get(input.policy.judge.labels)!,
            },
    };
    const campaignId = `cmp_${(yield* newId).replaceAll("-", "").slice(0, 16)}`;
    yield* sql`
        INSERT INTO editorial_engine_campaigns (
          campaign_id, project_id, kind, reference_hash, request_id, policy_json, policy_hash, budget,
          status, created_by, created_at
        ) VALUES (
          ${campaignId}, ${input.projectId}, ${input.kind}, ${reference}, ${input.requestId ?? null},
          ${toJson(policy)}, ${sha256(canonicalJson(policy))}, ${input.budget}, 'open', ${input.actor}, ${yield* nowIso}
        )
      `.pipe(storage);
    return yield* campaignView(
      Option.getOrThrow(yield* selectCampaign(campaignId).pipe(storage)),
    ).pipe(storage);
  });

  const closeCampaign: EngineChangeServiceShape["closeCampaign"] = Effect.fn(
    "EngineChangeService.closeCampaign",
  )(function* (campaignId) {
    yield* sql`UPDATE editorial_engine_campaigns SET status = 'closed', closed_at = ${yield* nowIso} WHERE campaign_id = ${campaignId}`.pipe(
      storage,
    );
    const row = yield* selectCampaign(campaignId).pipe(storage);
    if (Option.isNone(row)) return yield* labFailure("not-found", `No campaign ${campaignId}.`);
    return yield* campaignView(row.value).pipe(storage);
  });

  const campaigns: EngineChangeServiceShape["campaigns"] = (projectId) =>
    sql<CampaignRow>`
      SELECT ${sql.literal(CAMPAIGN_COLUMNS)} FROM editorial_engine_campaigns
      WHERE project_id = ${projectId} ORDER BY created_at DESC
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, campaignView)),
      storage,
    );

  /** The manifest `ref` of the project, or the active engine; nothing of another project. */
  const projectManifest = Effect.fn("EngineChangeService.projectManifest")(function* (
    projectId: string,
    ref: string,
  ) {
    const row = yield* selectManifest(sql, ref).pipe(storage);
    if (Option.isNone(row)) return yield* labFailure("not-found", `No engine manifest ${ref}.`);
    if (row.value.project_id !== null && row.value.project_id !== projectId) {
      return yield* labFailure("permission-denied", `${ref} belongs to another project.`);
    }
    if (row.value.project_id === null) {
      const current = yield* promotion.active;
      if (row.value.manifest_hash !== current.hash) {
        return yield* labFailure(
          "stale-base",
          `The active engine is ${manifestIdOf(current.hash)}, not ${ref}.`,
        );
      }
    }
    return row.value;
  });

  const requireOpenCampaign = (projectId: string) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM editorial_engine_campaigns
      WHERE project_id = ${projectId} AND kind = 'development' AND status = 'open' LIMIT 1
    `.pipe(
      storage,
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.fail(
              labFailure(
                "permission-denied",
                "The operator has not opened an engine lab campaign for this project.",
              ),
            )
          : Effect.void,
      ),
    );

  const codeFiles: EngineChangeServiceShape["codeFiles"] = Effect.gen(function* () {
    if (options.engineRoot === null) {
      return yield* labFailure(
        "unsupported-change",
        "Code candidates need the engine's sources, which this installation has not.",
      );
    }
    const root = options.engineRoot;
    const files = Object.fromEntries(
      CODE_FILES.map((path) => [path, NodeFS.readFileSync(NodePath.join(root, path), "utf8")]),
    );
    return {
      baseSourceHash: engineSourceHash(NodePath.join(root, "packages/trend-engine/src")),
      files,
    };
  });

  const editable: EngineChangeServiceShape["editable"] = (base) => ({
    config: {
      weights: {
        current: base.config.rank.weighted.weights,
        names: RANK_VALUE_NAMES,
        min: WEIGHT_MIN,
        max: WEIGHT_MAX,
        rule: "finite, at least one positive, never normalized; set a weight to 0 to drop it",
      },
      relevance:
        base.config.relevance === undefined
          ? "not available: this engine has no relevance model"
          : {
              item_min: base.config.relevance.item_min,
              signal_min: base.config.relevance.signal_min,
              min: 0,
              max: 1,
            },
    },
    code: {
      files: CODE_FILES,
      baseSourceHash: base.code.engine_source_hash,
      format: "unified diff (--- a/<path> / +++ b/<path>), in-place edits of these files only",
    },
    unsupported: UNSUPPORTED_CHANGE_KINDS,
  });

  const createCandidate: EngineChangeServiceShape["createCandidate"] = Effect.fn(
    "EngineChangeService.createCandidate",
  )(function* (input) {
    if (input.intent.length > MAX_TEXT || input.hypothesis.length > MAX_TEXT) {
      return yield* labFailure(
        "invalid-change",
        `intent and hypothesis take at most ${MAX_TEXT} characters.`,
      );
    }
    yield* requireOpenCampaign(input.projectId);
    const baseRow = yield* projectManifest(input.projectId, input.base);
    const base = manifestOf(baseRow);
    const kind = input.change["kind"];
    const { kind: _kind, ...body } = input.change;
    let manifest: EngineManifest;
    let files: Record<string, string> = {};
    const risks: Array<string> = [];
    if (kind === "config") {
      const changed = yield* Effect.try({
        try: () => applyConfigChange(base.config, body),
        catch: fromPolicy,
      });
      manifest = configCandidate(base, changed.config);
      // A configuration child of a code manifest runs the same patched files.
      files = { ...filesOf(baseRow) };
    } else if (kind === "code") {
      const extra = Object.keys(body).filter((key) => key !== "baseSourceHash" && key !== "patch");
      if (extra.length > 0)
        return yield* labFailure(
          "invalid-change",
          `Unknown keys ${extra.join(", ")}; a code change takes baseSourceHash and patch.`,
        );
      const patch = body["patch"];
      if (typeof patch !== "string")
        return yield* labFailure("invalid-change", "patch is a unified diff string.");
      if (body["baseSourceHash"] !== base.code.engine_source_hash) {
        return yield* labFailure(
          "stale-base",
          `The base's engine source hash is ${base.code.engine_source_hash}; patch that one.`,
        );
      }
      const current = yield* codeFiles;
      if (current.baseSourceHash !== base.code.base_source_hash) {
        return yield* labFailure(
          "stale-base",
          "The installed engine changed since this base was made.",
        );
      }
      const parsed = yield* Effect.try({ try: () => parsePatch(patch), catch: fromPolicy });
      const baseFiles = { ...current.files, ...filesOf(baseRow) };
      files = { ...filesOf(baseRow) };
      for (const file of parsed) {
        files[file.path] = yield* Effect.try({
          try: () => applyFilePatch(baseFiles[file.path]!, file),
          catch: fromPolicy,
        });
      }
      const overrides = new Map(
        Object.entries(files).map(([path, text]) => [
          path.replace("packages/trend-engine/src/", ""),
          text,
        ]),
      );
      const root = options.engineRoot!;
      manifest = codeCandidate(base, {
        engineSourceHash: engineSourceHash(
          NodePath.join(root, "packages/trend-engine/src"),
          overrides,
        ),
        patch,
        files: Object.fromEntries(
          Object.entries(files).map(([path, text]) => [path, sha256(text)]),
        ),
      });
      risks.push(
        "Runs only inside the executor's sandbox; it reaches the product only after review, deploy and Miguel's approval.",
      );
    } else if (
      typeof kind === "string" &&
      (UNSUPPORTED_CHANGE_KINDS as ReadonlyArray<string>).includes(kind)
    ) {
      return yield* labFailure(
        "unsupported-change",
        `Changes to ${kind} are recorded in the manifest but not created by the lab yet.`,
      );
    } else {
      return yield* labFailure("invalid-change", "change.kind is config or code.");
    }
    const hash = manifestHash(manifest);
    const existingKey = yield* sql<{ readonly manifest_hash: string }>`
        SELECT manifest_hash FROM editorial_engine_manifests
        WHERE project_id = ${input.projectId} AND idempotency_key = ${input.idempotencyKey}
      `.pipe(storage);
    if (existingKey[0] !== undefined && existingKey[0].manifest_hash !== hash) {
      return yield* labFailure(
        "invalid-change",
        "That idempotency key already made another candidate.",
      );
    }
    const existing = yield* selectManifest(sql, hash).pipe(storage);
    if (Option.isSome(existing) && existing.value.project_id !== input.projectId) {
      return yield* labFailure("permission-denied", "That manifest belongs to another project.");
    }
    const row = Option.isSome(existing)
      ? existing.value
      : yield* insertManifest(sql, {
          hash,
          manifest,
          files,
          projectId: input.projectId,
          threadId: input.threadId,
          intent: input.intent,
          hypothesis: input.hypothesis,
          idempotencyKey: input.idempotencyKey,
          createdAt: yield* nowIso,
        }).pipe(storage);
    if (row.kind === "config") {
      risks.push(
        "Development cutoffs only; promoting it needs a prospective shadow labelled blind by Miguel.",
      );
    }
    return {
      candidate: manifestView(row),
      created: Option.isNone(existing),
      diff: diffManifests(base, manifest),
      risks,
    };
  });

  const candidate: EngineChangeServiceShape["candidate"] = Effect.fn(
    "EngineChangeService.candidate",
  )(function* (projectId, ref) {
    const row = yield* projectManifest(projectId, ref);
    const manifest = manifestOf(row);
    const parent =
      manifest.parent === null
        ? Option.none()
        : yield* selectManifest(sql, manifest.parent).pipe(storage);
    return {
      ...manifestView(row),
      diff: Option.isSome(parent) ? diffManifests(manifestOf(parent.value), manifest) : [],
    };
  });

  /** The candidate descends from the campaign's reference engine. */
  const descendsFrom = Effect.fn("EngineChangeService.descendsFrom")(function* (
    hash: string,
    ancestor: string,
  ) {
    let current: string | null = hash;
    for (let depth = 0; current !== null && depth < 64; depth++) {
      if (current === ancestor) return true;
      const row: Option.Option<ManifestRow> = yield* selectManifest(sql, current).pipe(storage);
      current = Option.isSome(row) ? row.value.parent_hash : null;
    }
    return false;
  });

  const buildSpec = Effect.fn("EngineChangeService.buildSpec")(function* (input: {
    readonly campaign: CampaignRow;
    readonly candidate: string;
    readonly token: string;
    readonly secret: string;
  }) {
    const policy = policyOf(input.campaign);
    const ref = Option.getOrThrow(
      yield* selectManifest(sql, input.campaign.reference_hash).pipe(storage),
    );
    const cand = Option.getOrThrow(yield* selectManifest(sql, input.candidate).pipe(storage));
    const armOf = (row: typeof ref) => {
      const stored = filesOf(row);
      return { manifest_hash: row.manifest_hash, manifest: manifestOf(row), files: stored };
    };
    return {
      schema: JOB_SPEC_SCHEMA,
      token: input.token,
      secret: input.secret,
      kind: input.campaign.kind,
      cutoffs: policy.cutoffs,
      input_roots: policy.input_roots,
      corpus_dir: policy.corpus_dir,
      profile_path: policy.profile_path,
      profile_hash: manifestOf(ref).profile_hash,
      cache_file: policy.cache_file,
      cache_only: policy.cache_only,
      models_dir: policy.models_dir,
      embedder: policy.embedder,
      workers: policy.workers,
      top: 10,
      sandbox: Object.keys(filesOf(cand)).length > 0 ? "required" : "if-available",
      reference: armOf(ref),
      candidate: armOf(cand),
    } satisfies JobSpec;
  });

  const secretOf = Effect.gen(function* () {
    return (
      (yield* crypto.randomUUIDv4().pipe(Effect.orDie)) +
      (yield* crypto.randomUUIDv4().pipe(Effect.orDie))
    );
  });

  const insertJob = Effect.fn("EngineChangeService.insertJob")(function* (input: {
    readonly jobId: string;
    readonly campaign: CampaignRow;
    readonly candidate: string;
    readonly threadId: string | null;
  }) {
    const token = `job-${input.jobId.replace(/^job_/, "")}`;
    const secret = yield* secretOf;
    const spec = yield* buildSpec({
      campaign: input.campaign,
      candidate: input.candidate,
      token,
      secret,
    });
    const createdAt = yield* nowIso;
    yield* sql`
        INSERT INTO editorial_engine_jobs (
          job_id, campaign_id, kind, candidate_hash, reference_hash, thread_id, status, executor, token,
          secret, spec_json, created_at
        ) VALUES (
          ${input.jobId}, ${input.campaign.campaign_id}, ${input.campaign.kind}, ${input.candidate},
          ${input.campaign.reference_hash}, ${input.threadId}, 'queued', ${policyOf(input.campaign).executor},
          ${token}, ${secret}, ${toJson({ ...spec, secret: null })}, ${createdAt}
        )
      `;
    yield* sql`
        INSERT INTO editorial_engine_job_events (job_id, seq, at, kind, detail)
        VALUES (${input.jobId}, 1, ${createdAt}, 'queued', ${`campaign ${input.campaign.campaign_id}`})
      `;
  });

  const evaluate: EngineChangeServiceShape["evaluate"] = Effect.fn("EngineChangeService.evaluate")(
    function* (input) {
      const campaign = yield* selectCampaign(input.campaignId).pipe(storage);
      if (Option.isNone(campaign) || campaign.value.project_id !== input.projectId) {
        return yield* labFailure(
          "permission-denied",
          `No campaign ${input.campaignId} in this project.`,
        );
      }
      if (campaign.value.kind !== "development" || campaign.value.status !== "open") {
        return yield* labFailure(
          "permission-denied",
          `Campaign ${input.campaignId} is not an open development campaign.`,
        );
      }
      const row = yield* projectManifest(input.projectId, input.candidate);
      if (row.project_id === null)
        return yield* labFailure("invalid-change", "Evaluate a candidate, not the active engine.");
      if (!(yield* descendsFrom(row.manifest_hash, campaign.value.reference_hash))) {
        return yield* labFailure(
          "stale-base",
          "The candidate does not descend from the campaign's reference engine.",
        );
      }
      const jobId = `job_${(yield* newId).replaceAll("-", "").slice(0, 16)}`;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const same = yield* sql<{ readonly job_id: string; readonly candidate_hash: string }>`
              SELECT job_id, candidate_hash FROM editorial_engine_attempts
              WHERE campaign_id = ${input.campaignId}
                AND (idempotency_key = ${input.idempotencyKey} OR candidate_hash = ${row.manifest_hash})
            `;
            const used = yield* usedSeats(input.campaignId);
            const remaining = Math.max(0, campaign.value.budget - used);
            const hit = same.find((entry) => entry.candidate_hash === row.manifest_hash) ?? same[0];
            if (hit !== undefined) {
              if (hit.candidate_hash !== row.manifest_hash) {
                return yield* labFailure(
                  "invalid-change",
                  "That idempotency key already evaluated another candidate.",
                );
              }
              return { jobId: hit.job_id, created: false, remaining };
            }
            if (used >= campaign.value.budget) {
              return yield* labFailure(
                "budget-exhausted",
                `Campaign ${input.campaignId} has used its ${campaign.value.budget} evaluations.`,
              );
            }
            yield* insertJob({
              jobId,
              campaign: campaign.value,
              candidate: row.manifest_hash,
              threadId: input.threadId,
            });
            // The seat is taken by this insert: a second one past the budget fails the check above
            // in its own transaction, which SQLite runs after this one.
            yield* sql`
              INSERT INTO editorial_engine_attempts (
                attempt_id, campaign_id, candidate_hash, idempotency_key, thread_id, job_id, created_at
              )
              SELECT ${`att_${jobId.slice(4)}`}, ${input.campaignId}, ${row.manifest_hash}, ${input.idempotencyKey},
                ${input.threadId}, ${jobId}, ${yield* nowIso}
              WHERE (SELECT COUNT(*) FROM editorial_engine_attempts WHERE campaign_id = ${input.campaignId}) < ${campaign.value.budget}
            `;
            const seated = yield* sql<{
              readonly found: number;
            }>`SELECT 1 AS found FROM editorial_engine_attempts WHERE job_id = ${jobId}`;
            if (seated.length === 0)
              return yield* labFailure("budget-exhausted", "The campaign's budget is used up.");
            return { jobId, created: true, remaining: remaining - 1 };
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(storageFailure(error)) }));
    },
  );

  const startShadow: EngineChangeServiceShape["startShadow"] = Effect.fn(
    "EngineChangeService.startShadow",
  )(function* (campaignId) {
    const campaign = yield* selectCampaign(campaignId).pipe(storage);
    if (
      Option.isNone(campaign) ||
      campaign.value.kind !== "shadow" ||
      campaign.value.request_id === null
    ) {
      return yield* labFailure("not-found", `No shadow campaign ${campaignId}.`);
    }
    const request = yield* sql<{ readonly candidate_hash: string }>`
        SELECT candidate_hash FROM editorial_engine_promotions WHERE request_id = ${campaign.value.request_id}
      `.pipe(storage);
    const candidateHash = request[0]?.candidate_hash;
    if (candidateHash === undefined)
      return yield* labFailure("not-found", "The shadow's request is gone.");
    const existing = yield* sql<{
      readonly job_id: string;
    }>`SELECT job_id FROM editorial_engine_jobs WHERE campaign_id = ${campaignId}`.pipe(storage);
    if (existing[0] !== undefined) return { jobId: existing[0].job_id };
    const jobId = `job_${(yield* newId).replaceAll("-", "").slice(0, 16)}`;
    yield* insertJob({
      jobId,
      campaign: campaign.value,
      candidate: candidateHash,
      threadId: null,
    }).pipe(storage);
    return { jobId };
  });

  const campaign: EngineChangeServiceShape["campaign"] = (campaignId) =>
    selectCampaign(campaignId).pipe(storage);

  return EngineChangeService.of({
    createCampaign,
    closeCampaign,
    campaigns,
    campaign,
    createCandidate,
    candidate,
    evaluate,
    startShadow,
    editable,
    codeFiles,
  });
});

export const layer = Layer.effect(EngineChangeService, make);
