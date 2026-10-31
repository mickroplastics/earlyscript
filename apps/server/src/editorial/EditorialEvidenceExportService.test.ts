// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EDITORIAL_RESULTS_WS_METHODS,
  EditorialResultsRpcGroup,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { EditorialCommandService } from "./EditorialCommandService.ts";
import * as EditorialEvidenceExportService from "./EditorialEvidenceExportService.ts";
import * as EditorialResultsService from "./EditorialResultsService.ts";
import * as EditorialSourcesService from "./EditorialSourcesService.ts";
import {
  EVIDENCE_COLUMNS,
  EVIDENCE_FILES,
  MANIFEST_FILE,
  SHARE_EVENT_DATA,
  shareEventDataWhitelist,
  shareWhitelist,
  type ShareRule,
} from "./evidenceFormat.ts";
import { EditorialEventType } from "./persistence/EditorialModel.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeTempDir, withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";
import { appendEvent } from "./persistence/EditorialEventLog.ts";
import { runFixtureThread, seedResultsFixture } from "./resultsFixture.testkit.ts";
import * as EditorialResultsRpc from "./resultsRpc.ts";

/**
 * The share whitelist, frozen. Adding a column to `--share` must change this list on purpose:
 * the test fails until someone looks at what the new column lets out.
 */
const FROZEN_SHARE_COLUMNS = {
  "decisiones.csv": [
    "hilo",
    "modo",
    "tendencia",
    "corrida",
    "accion",
    "utilidad",
    "vigente",
    "reloj_definitivo",
    "cobertura",
    "explorar_ms",
    "leer_ms",
    "escribir_ms",
    "decidir_ms",
    "total_ms",
    "guion_hash",
    "afirmaciones",
    "con_cita",
    "vistas",
    "suscriptores",
    "clics",
    "comentarios",
    "metricas_observadas",
    "decidida",
  ],
  "tiempos.csv": [
    "hilo",
    "modo",
    "tramo",
    "etapa",
    "estado",
    "inicio",
    "fin",
    "duracion_ms",
    "motivo_fin",
    "fin_pausa",
    "recuperado",
  ],
  "eventos.csv": ["seq", "tipo", "fecha", "agregado", "id", "actor", "datos"],
  "corridas.csv": [
    "corrida",
    "corte",
    "terminada",
    "estado_motor",
    "estado_importacion",
    "version_motor",
    "config_hash",
    "hash_logico",
    "corpus_hash",
    "contenido_hash",
    "perfil_hash",
    "fuentes",
    "expedientes",
    "vistas",
    "descartadas",
    "producidas",
    "omitidos",
  ],
};

/** Field paths `share` keeps of each event type, frozen like the columns. */
const FROZEN_EVENT_PATHS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "browser.visited": ["origin", "titleOnly"],
  "capture.removed": [],
  "capture.saved": [],
  "decision.recorded": ["action", "clockDefinitive", "scriptVersionHash", "utility"],
  "result.saved": ["clicks", "comments", "observedAt", "subscribers", "views"],
  "run.imported": [
    "contentHash",
    "cutoffAt",
    "dossierCount",
    "importState",
    "interpretationVersion",
    "logicalHash",
    "previousContentHash",
    "previousImportState",
    "previousInterpretationVersion",
  ],
  "run.invalidated": ["contentHash", "previousImportState"],
  "run.updated": [
    "contentHash",
    "cutoffAt",
    "dossierCount",
    "importState",
    "interpretationVersion",
    "logicalHash",
    "previousContentHash",
    "previousImportState",
    "previousInterpretationVersion",
  ],
  "script.head-restored": ["contentHash"],
  "script.version-saved": ["bytes", "contentHash"],
  "trend.dismissed": [],
  "trend.production-linked": ["previousThreadId", "threadId"],
  "trend.read": ["runCutoffAt", "runId"],
  "trend.reopened": [],
  "trend.snoozed": ["returnWhen.atLeast", "returnWhen.baseline", "returnWhen.metric", "until"],
  "trend.unsnoozed": ["cause", "observed.metric", "observed.runId", "observed.value"],
  "video-thread.launch-failed": ["previous"],
  "video-thread.launched": ["previous"],
  "video-thread.purged": [
    "captures",
    "decisions",
    "events",
    "mode",
    "results",
    "scriptVersions",
    "versionFiles",
    "visits",
    "workIntervals",
  ],
  "video-thread.registered": ["mode", "runId", "trendKey"],
  "video-thread.t3-deleted": [],
  "work.paused": ["stage"],
  "work.recovery-needed": ["stage", "startedAt"],
  "work.resolved": ["endedAt"],
  "work.resumed": ["stage"],
  "work.stage-changed": ["from", "fromState", "to"],
  "work.started": ["stage"],
  "work.stopped": ["from", "reason", "stage"],
};

const CONFIG_HASH = `sha256:${"c".repeat(64)}`;
const LOGICAL_HASH = `sha256:${"d".repeat(64)}`;
const CONTENT_HASH = "f".repeat(64);

/** Free text and identifiers that must never reach a share package. */
const SECRETS = [
  "NOTA-SECRETA",
  "TITULO-SECRETO",
  "secret.example",
  "VISITA-SECRETA",
  "PAUSA-SECRETA",
  "MOTIVO-SECRETO",
  "Fuera del perfil",
  "Reescribí el gancho",
  "Developers now discuss",
  "thread-assisted",
  "thread-manual",
  "env-fixture",
  "trend:",
  "sesion-secreta",
  "dossiers/",
];

const withEvidence = <A, E, R>(body: Effect.Effect<A, E, R>) => {
  const corpusDir = makeTempDir();
  const reads = Layer.mergeAll(
    EditorialResultsService.layer,
    EditorialSourcesService.layerWithCorpusDir(corpusDir),
  );
  const handlers = Layer.effect(
    EditorialResultsRpc.EditorialResultsRpcHandlers,
    EditorialResultsRpc.makeHandlers,
  );
  return withEditorialDatabase(
    body.pipe(
      Effect.provide(
        handlers.pipe(
          Layer.provideMerge(EditorialEvidenceExportService.layerFromReads),
          Layer.provideMerge(reads),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(corpusDir, { recursive: true }))));
};

/** The Results fixture plus what only the full package may carry, and one indexed run. */
const seedEvidence = Effect.gen(function* () {
  yield* seedResultsFixture;
  const commands = yield* EditorialCommandService;
  const sql = yield* EditorialSql;
  // A seventh, manual thread with a capture, a visit and a pause with its reason.
  yield* TestClock.adjust(Duration.days(1));
  yield* runFixtureThread({
    threadId: "thread-manual-4",
    mode: "manual",
    steps: [
      { stage: "explore", minutes: 20 },
      { pause: 3 },
      { stage: "explore", minutes: 5 },
      { stage: "write", minutes: 25 },
      { stage: "decide", minutes: 2 },
    ],
    script: "# Hook\n\nDevelopers now discuss secrets [itm_hn_1].\n",
    action: "reject",
    utility: 1,
    reason: "MOTIVO-SECRETO",
    gapMinutes: 0,
  });
  yield* commands.saveCapture({
    threadId: "thread-manual-4",
    url: "https://secret.example/page?token=abc",
    title: "TITULO-SECRETO",
    note: "NOTA-SECRETA",
  });
  yield* sql`
    UPDATE editorial_work_intervals SET pause_reason = 'PAUSA-SECRETA'
    WHERE thread_id = 'thread-manual-4' AND end_reason = 'paused'
  `;
  yield* appendEvent(sql, {
    type: "browser.visited",
    aggregateKind: "video_thread",
    aggregateId: "thread-manual-4",
    actor: "system",
    actorSessionId: "sesion-secreta",
    payload: {
      visitId: "visit-1",
      tabId: "tab-1",
      url: "https://secret.example/visit",
      title: "VISITA-SECRETA",
      origin: "desktop",
    },
    createdAt: "2026-10-27T10:00:00.000Z",
  });
  yield* sql`
    INSERT INTO editorial_runs (
      run_id, cutoff_at, finished_at, engine_status, config_hash, logical_hash, sources_json,
      coverage_json, artifact_path, artifact_version, content_hash, dossier_count, import_state,
      skipped_files_json, imported_at, updated_at
    ) VALUES (
      'run-fixture', '2026-10-19T00:00:00.000Z', '2026-10-19T00:05:00.000Z', 'ok', ${CONFIG_HASH},
      ${LOGICAL_HASH}, '["hn","github"]', '{}', '/home/x/dossiers/run-fixture', '{}',
      ${CONTENT_HASH}, 3, 'partial', '[{"file":"dossiers/bad.json","reason":"MOTIVO-SECRETO"}]',
      '2026-10-19T01:00:00.000Z', '2026-10-19T01:00:00.000Z'
    )
  `;
  for (const [index, trendKey] of [
    "trend:local-models",
    "trend:edge-databases",
    "trend:agent-evals",
  ].entries()) {
    yield* sql`
      INSERT INTO editorial_dossiers (
        run_id, dossier_id, trend_key, trend_key_rule, file_path, content_hash, label, items_7d,
        items_28d, authors_7d, score, volume_rank, score_rank
      ) VALUES (
        'run-fixture', ${`d${index}`}, ${trendKey}, 'signal-id', ${`dossiers/d${index}.json`},
        'aaaa', 'LABEL-SECRETO', 5, 9, 3, 0.5, ${index + 1}, ${index + 1}
      )
    `;
  }
});

/** Text an imported run or a stored payload could carry; none may reach share. */
const ADVERSARIAL = [
  "titulo-fuente-sol-unico",
  "TOKEN-FALSO-CLAVE",
  "titulo-secreto",
  "CLAVE-OCULTA",
  "accion-secreta",
  "etapa-secreta",
  "tipo-secreto",
  "TOKEN-TOP",
  "version-secreta",
  "hash-secreto",
  "fuente-secreta",
  "estado-secreto",
  "dia-secreto",
  "bt-secreto",
];

/** Writes what no command of the app writes, straight into the base, as an import could. */
const seedAdversarial = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const run = "titulo-fuente-sol-unico";
  yield* sql`
    INSERT INTO editorial_runs (
      run_id, cutoff_at, finished_at, engine_status, engine_version, config_hash, logical_hash,
      sources_json, coverage_json, artifact_path, artifact_version, content_hash, dossier_count,
      import_state, skipped_files_json, imported_at, updated_at
    ) VALUES (
      ${run}, '2026-10-30T00:00:00.000Z', '2026-10-30T00:05:00.000Z', 'estado-secreto',
      'version-secreta', 'hash-secreto', ${LOGICAL_HASH}, '["hn","fuente-secreta"]', '{}',
      '/x', '{}', ${CONTENT_HASH}, 0, 'imported', '[]', '2026-10-30T01:00:00.000Z',
      '2026-10-30T01:00:00.000Z'
    )
  `;
  const event = (type: string, aggregateKind: string, aggregateId: string, payload: unknown) => sql`
    INSERT INTO editorial_events (type, aggregate_kind, aggregate_id, actor, payload_json, created_at)
    VALUES (${type}, ${aggregateKind}, ${aggregateId}, 'system', ${JSON.stringify(payload)},
      '2026-10-30T02:00:00.000Z')
  `;
  yield* event("run.imported", "run", run, {
    importState: "imported",
    contentHash: "hash-secreto",
  });
  yield* event("trend.read", "trend", "trend:local-models", { runId: run, TOKEN_TOP: "TOKEN-TOP" });
  yield* event("trend.snoozed", "trend", "trend:rust-gui", {
    until: "2026-11-01T00:00:00.000Z",
    returnWhen: { "TOKEN-FALSO-CLAVE": 1, metric: "titulo-secreto", atLeast: 5 },
  });
  yield* event("trend.unsnoozed", "trend", "trend:rust-gui", {
    cause: "growth",
    observed: { runId: run, metric: "items7d", value: 3, "CLAVE-OCULTA": 2 },
  });
  yield* event("decision.recorded", "video_thread", "thread-manual-4", {
    action: "accion-secreta",
    utility: "5",
    "TOKEN-TOP": true,
  });
  yield* event("work.started", "video_thread", "thread-manual-4", { stage: "etapa-secreta" });
  yield* event("tipo-secreto", "trend", "trend:rust-gui", { TOKEN_TOP: "TOKEN-TOP" });
  yield* sql`
    INSERT INTO editorial_source_backtests (
      source, backtest_id, logical_hash, experiment_at, cutoff_from, cutoff_to, status, verdict,
      complete_cutoffs, partial_cutoffs, allow_provisional, recorded_at
    ) VALUES (
      'arxiv', 'bt-secreto', 'hash-secreto', '2026-10-30T00:00:00.000Z', 'dia-secreto',
      'dia-secreto', 'final', 'not-worse', 1, 0, 0, '2026-10-30T00:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO editorial_source_settings (source, collect, rank, backtest_run_id, updated_at)
    VALUES ('arxiv', 1, 1, 'bt-secreto', '2026-10-30T00:00:00.000Z')
  `;
});

/** Minimal CSV reader for the files this module writes (quoted cells, doubled quotes). */
const parseCsv = (csv: string): ReadonlyArray<Record<string, string>> => {
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]!;
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header!.map((name, i) => [name, cells[i] ?? ""])));
};

const exportOf = (
  mode: "full" | "share",
  filters: { readonly since?: string; readonly until?: string } = {},
) =>
  Effect.gen(function* () {
    const evidence = yield* EditorialEvidenceExportService.EditorialEvidenceExportService;
    return yield* evidence.build({ mode, ...filters });
  });

const fileOf = (pkg: EditorialEvidenceExportService.EvidencePackage, name: string) =>
  pkg.files.find((file) => file.name === name)?.content ?? "";

const headerOf = (csv: string) => csv.split("\n")[0]!.split(",");

const rowsOf = (csv: string) => csv.trimEnd().split("\n").slice(1);

const group = EditorialResultsRpcGroup.middleware(RpcScopeAuthorization);

const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const handlers = yield* EditorialResultsRpc.EditorialResultsRpcHandlers;
    return yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(group.toLayer(handlers), RpcAuthorization.layer(scopes))),
    );
  });

describe("editorial.results.export", () => {
  it("needs orchestration:operate", () => {
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_RESULTS_WS_METHODS.export),
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("returns the files without a folder and writes them with one", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        const reader = yield* clientWith([AuthOrchestrationReadScope]);
        const refused = yield* Effect.flip(
          reader[EDITORIAL_RESULTS_WS_METHODS.export]({ mode: "share" }),
        );
        assert.strictEqual(refused._tag, "EnvironmentAuthorizationError");

        const client = yield* clientWith([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        const inline = yield* client[EDITORIAL_RESULTS_WS_METHODS.export]({ mode: "share" });
        assert.isNull(inline.directory);
        assert.deepStrictEqual(
          inline.contents.map((file) => file.name),
          [...EVIDENCE_FILES.share, MANIFEST_FILE],
        );
        assert.match(inline.packageName, /^earlyscript-evidencia-compartir-\d{4}-\d{2}-\d{2}$/);

        const root = makeTempDir();
        try {
          const written = yield* client[EDITORIAL_RESULTS_WS_METHODS.export]({
            mode: "full",
            directory: root,
          });
          assert.deepStrictEqual(written.contents, []);
          assert.strictEqual(written.directory, NodePath.join(root, written.packageName));
          assert.deepStrictEqual(
            NodeFS.readdirSync(written.directory!).toSorted(),
            [...EVIDENCE_FILES.full, MANIFEST_FILE].toSorted(),
          );
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
    ),
  );
});

describe("EditorialEvidenceExportService", () => {
  it.effect("gives the same files and hashes for the same state", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        for (const mode of ["full", "share"] as const) {
          const first = yield* exportOf(mode);
          yield* TestClock.adjust(Duration.days(2));
          const second = yield* exportOf(mode);
          assert.strictEqual(first.packageHash, second.packageHash);
          assert.deepStrictEqual(
            first.files.map((file) => [file.name, file.sha256]),
            second.files.map((file) => [file.name, file.sha256]),
          );
          assert.deepStrictEqual(
            first.files.map((file) => file.name),
            EVIDENCE_FILES[mode],
          );
          const manifest = JSON.parse(first.manifest);
          assert.strictEqual(manifest.schema, "earlyscript.evidence/1");
          assert.strictEqual(manifest.packageHash, first.packageHash);
          assert.deepStrictEqual(
            manifest.files.map((file: { readonly sha256: string }) => file.sha256),
            first.files.map((file) => file.sha256),
          );
        }
      }),
    ),
  );

  it("keeps the share whitelist frozen, every value under a closed rule", () => {
    assert.deepStrictEqual(shareWhitelist(), FROZEN_SHARE_COLUMNS);
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(shareEventDataWhitelist()).map(([type, paths]) => [
          type,
          Object.keys(paths),
        ]),
      ),
      FROZEN_EVENT_PATHS,
    );
    // Free text and raw ids have no share rule at all.
    const fullOnly = [
      "entorno",
      "expediente",
      "decision",
      "motivo",
      "tramo_id",
      "motivo_pausa",
      "operacion",
      "omitidos_motivos",
      "url",
      "titulo",
      "nota",
    ];
    for (const specs of Object.values(EVIDENCE_COLUMNS)) {
      for (const spec of specs) {
        if (fullOnly.includes(spec.name)) assert.isNull(spec.share, spec.name);
      }
    }
    // No rule copies a string as it is: enums carry their values, the rest are formats.
    const leaves = (rule: ShareRule, name: string): ReadonlyArray<[string, ShareRule]> =>
      rule.kind === "object"
        ? Object.entries(rule.fields).flatMap(([key, inner]) => leaves(inner, `${name}.${key}`))
        : [[name, rule]];
    const rules = [
      ...Object.values(EVIDENCE_COLUMNS)
        .flat()
        .flatMap((spec) => (spec.share === null ? [] : leaves(spec.share, spec.name))),
      ...Object.entries(SHARE_EVENT_DATA).flatMap(([type, fields]) =>
        Object.entries(fields).flatMap(([key, rule]) => leaves(rule, `${type}.${key}`)),
      ),
    ];
    for (const [name, rule] of rules) {
      if (rule.kind === "enum") {
        assert.isAbove(rule.values.length, 0, name);
        for (const value of rule.values) assert.match(value, /^[a-z][a-z0-9_.-]*$/, name);
      }
    }
  });

  it("declares every event type", () => {
    assert.deepStrictEqual(
      Object.keys(SHARE_EVENT_DATA).toSorted(),
      [...EditorialEventType.literals].toSorted(),
    );
    // A partial declaration does not compile: a new event type must be classified.
    // @ts-expect-error every EditorialEventType needs its share fields
    const partial: typeof SHARE_EVENT_DATA = { "trend.read": {} };
    assert.isObject(partial);
  });

  it.effect("drops adversarial engine metadata, nested keys and unknown enum values", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        yield* seedAdversarial;
        const share = yield* exportOf("share");
        const text = [...share.files.map((file) => file.content), share.manifest].join("\n");
        for (const marker of ADVERSARIAL) assert.notInclude(text, marker, marker);
        for (const secret of SECRETS) assert.notInclude(text, secret, secret);
        // Key names too: every key of every `datos` is a declared path of its type.
        const allowed = shareEventDataWhitelist();
        const pathsOf = (value: unknown, prefix: string): ReadonlyArray<string> =>
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? Object.entries(value).flatMap(([key, inner]) =>
                typeof inner === "object" && inner !== null
                  ? pathsOf(inner, `${prefix}${key}.`)
                  : [`${prefix}${key}`],
              )
            : [];
        const events = parseCsv(fileOf(share, "eventos.csv"));
        assert.isAbove(events.length, 0);
        for (const event of events) {
          const declared = Object.keys(allowed[event.tipo!] ?? {});
          for (const path of pathsOf(JSON.parse(event.datos!), "")) {
            assert.include(declared, path, `${event.tipo}: ${path}`);
          }
          assert.match(event.id!, /^(h|t|r)\d{3,}$|^$/, `id ${event.id}`);
        }
        // The adversarial run is still there, as an index, with only what passed its rules.
        const runs = parseCsv(fileOf(share, "corridas.csv"));
        const adversarial = runs.find((run) => run.corte === "2026-10-30")!;
        assert.match(adversarial.corrida!, /^r\d{3}$/);
        assert.strictEqual(adversarial.version_motor, "");
        assert.strictEqual(adversarial.config_hash, "");
        assert.strictEqual(adversarial.estado_motor, "");
        assert.strictEqual(adversarial.fuentes, "hn");
        const snoozed = events.find((event) => event.datos!.includes("atLeast"))!;
        assert.deepStrictEqual(JSON.parse(snoozed.datos!), {
          returnWhen: { atLeast: 5 },
          until: "2026-11-01",
        });
        // The full package keeps them: the filter, not an empty base, removed them.
        const full = yield* exportOf("full");
        assert.include(fileOf(full, "corridas.csv"), "titulo-fuente-sol-unico");
      }),
    ),
  );

  it.effect("rounds instant filters to the day in share and says so", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        const share = yield* exportOf("share", { since: "2026-10-24T12:34:56.000Z" });
        const manifest = JSON.parse(share.manifest);
        assert.strictEqual(manifest.filters.since, "2026-10-24");
        assert.isTrue(manifest.filters.roundedToDay);
        const summary = fileOf(share, "resumen.md");
        assert.include(summary, "desde un instante del día 2026-10-24");
        for (const text of [share.manifest, summary]) assert.notInclude(text, "12:34");
        // The rows were filtered with the instant: the decision of the 24th at 15:28 is in.
        assert.strictEqual(rowsOf(fileOf(share, "decisiones.csv")).length, 6);
        const days = yield* exportOf("share", { since: "2026-10-24", until: "2026-10-26" });
        assert.include(
          fileOf(days, "resumen.md"),
          "desde el día 2026-10-24 hasta el día 2026-10-26",
        );
        assert.notProperty(JSON.parse(days.manifest).filters, "roundedToDay");
        const full = yield* exportOf("full", { since: "2026-10-24T12:34:56.000Z" });
        assert.strictEqual(JSON.parse(full.manifest).filters.since, "2026-10-24T12:34:56.000Z");
      }),
    ),
  );

  it.effect("writes only whitelisted columns, no free text and day dates in share", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        const share = yield* exportOf("share");
        const full = yield* exportOf("full");
        for (const [name, columns] of Object.entries(FROZEN_SHARE_COLUMNS)) {
          assert.deepStrictEqual(headerOf(fileOf(share, name)), columns, name);
        }
        const shareText = [...share.files.map((file) => file.content), share.manifest].join("\n");
        for (const secret of SECRETS) assert.notInclude(shareText, secret, secret);
        assert.notMatch(shareText, /https?:\/\//);
        for (const file of share.files) {
          assert.notMatch(file.content, /\d{4}-\d{2}-\d{2}T\d{2}:/, file.name);
        }
        // The full package keeps what share drops, so the test proves the filter, not an empty base.
        const fullText = full.files.map((file) => file.content).join("\n");
        for (const secret of [
          "NOTA-SECRETA",
          "MOTIVO-SECRETO",
          "PAUSA-SECRETA",
          "VISITA-SECRETA",
        ]) {
          assert.include(fullText, secret, secret);
        }
        assert.notInclude(fullText, "sesion-secreta");
        assert.notInclude(fullText, "Developers now discuss");
      }),
    ),
  );

  it.effect("replaces thread and trend ids with stable first-seen indices", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        const share = yield* exportOf("share");
        const decisions = rowsOf(fileOf(share, "decisiones.csv")).map((line) => line.split(","));
        assert.deepStrictEqual(
          decisions.map((row) => [row[0], row[1], row[2]]),
          [
            ["h001", "assisted", "t003"],
            ["h002", "manual", ""],
            ["h003", "assisted", "t001"],
            ["h004", "manual", ""],
            ["h005", "assisted", "t004"],
            ["h006", "manual", ""],
            ["h007", "manual", ""],
          ],
        );
        const runs = rowsOf(fileOf(share, "corridas.csv"));
        assert.deepStrictEqual(runs, [
          `r001,2026-10-19,2026-10-19,ok,partial,,${CONFIG_HASH},${LOGICAL_HASH},,${CONTENT_HASH},,hn;github,3,6,1,0,1`,
        ]);
        const visit = rowsOf(fileOf(share, "eventos.csv")).find((line) =>
          line.includes("browser.visited"),
        );
        assert.include(visit, `h007,system,"{""origin"":""desktop""}"`);
      }),
    ),
  );

  it.effect("filters by UTC day and rejects a bad filter", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        const all = yield* exportOf("share");
        const window = yield* exportOf("share", { since: "2026-10-24", until: "2026-10-26" });
        assert.strictEqual(rowsOf(fileOf(all, "decisiones.csv")).length, 7);
        const days = rowsOf(fileOf(window, "decisiones.csv")).map((line) => line.split(",").at(-1));
        assert.deepStrictEqual(days, ["2026-10-24", "2026-10-25", "2026-10-26"]);
        for (const line of rowsOf(fileOf(window, "eventos.csv"))) {
          const day = line.split(",")[2]!;
          assert.isTrue(day >= "2026-10-24" && day <= "2026-10-26", line);
        }
        assert.deepStrictEqual(rowsOf(fileOf(window, "corridas.csv")), []);
        assert.include(
          fileOf(window, "resumen.md"),
          "desde el día 2026-10-24 hasta el día 2026-10-26",
        );
        const bad = yield* exportOf("share", { since: "ayer" }).pipe(Effect.flip);
        assert.strictEqual(bad.reason, "invalid-filter");
        const reversed = yield* exportOf("share", {
          since: "2026-10-23",
          until: "2026-10-21",
        }).pipe(Effect.flip);
        assert.strictEqual(reversed.reason, "invalid-filter");
      }),
    ),
  );

  it.effect("summarizes per mode and stage like Results", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedResultsFixture;
        const pkg = yield* exportOf("share");
        const summary = fileOf(pkg, "resumen.md");
        // Fixture: assisted write 22, 30 and 26 minutes; manual write 50, 40 and 55.
        assert.include(
          summary,
          "| Asistido | Escribir | 3 | 26,0 min | 24,0 min | 28,0 min | 4,0 min |",
        );
        assert.include(
          summary,
          "| Manual | Escribir | 3 | 50,0 min | 45,0 min | 52,5 min | 7,5 min |",
        );
        assert.include(summary, "| Asistido | 3 | 3 | 4,00 |");
        assert.include(summary, "| Hacker News | sí | sí |");
        assert.notInclude(summary, "ahorro del");
      }),
    ),
  );

  it.effect("writes into a new or earlier package folder and refuses any other", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        const evidence = yield* EditorialEvidenceExportService.EditorialEvidenceExportService;
        const root = makeTempDir();
        try {
          const target = NodePath.join(root, "paquete");
          yield* evidence.write(yield* exportOf("full"), target);
          assert.isTrue(NodeFS.existsSync(NodePath.join(target, "capturas.csv")));
          const share = yield* exportOf("share");
          yield* evidence.write(share, target);
          assert.isFalse(NodeFS.existsSync(NodePath.join(target, "capturas.csv")));
          assert.deepStrictEqual(
            NodeFS.readdirSync(target).toSorted(),
            [...EVIDENCE_FILES.share, MANIFEST_FILE].toSorted(),
          );
          for (const file of share.files) {
            assert.strictEqual(
              NodeFS.readFileSync(NodePath.join(target, file.name), "utf8"),
              file.content,
            );
          }
          const foreign = NodePath.join(root, "otra");
          NodeFS.mkdirSync(foreign);
          NodeFS.writeFileSync(NodePath.join(foreign, "notas.txt"), "mío");
          const refused = yield* evidence.write(share, foreign).pipe(Effect.flip);
          assert.strictEqual(refused.reason, "target");
          assert.deepStrictEqual(NodeFS.readdirSync(foreign), ["notas.txt"]);
          const relative = yield* evidence.write(share, "relativa").pipe(Effect.flip);
          assert.strictEqual(relative.reason, "target");
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("never writes through a symbolic link", () =>
    withEvidence(
      Effect.gen(function* () {
        yield* seedEvidence;
        const evidence = yield* EditorialEvidenceExportService.EditorialEvidenceExportService;
        const share = yield* exportOf("share");
        const root = makeTempDir();
        try {
          const outside = NodePath.join(root, "outside");
          NodeFS.mkdirSync(outside);
          // The destination is a link to another folder.
          const link = NodePath.join(root, "out-link");
          NodeFS.symlinkSync(outside, link, "dir");
          const refused = yield* evidence.write(share, link).pipe(Effect.flip);
          assert.strictEqual(refused.reason, "target");
          assert.deepStrictEqual(NodeFS.readdirSync(outside), []);
          // A dangling link where the folder would go.
          const dangling = NodePath.join(root, "dangling");
          NodeFS.symlinkSync(NodePath.join(root, "nowhere"), dangling, "dir");
          assert.strictEqual(
            (yield* evidence.write(share, dangling).pipe(Effect.flip)).reason,
            "target",
          );
          assert.isFalse(NodeFS.existsSync(NodePath.join(root, "nowhere")));
          // Inside an earlier package, a file of ours replaced by a link: the link goes, the
          // file it pointed to stays as it was.
          const target = NodePath.join(root, "paquete");
          yield* evidence.write(share, target);
          const victim = NodePath.join(outside, "victima.txt");
          NodeFS.writeFileSync(victim, "intacto");
          NodeFS.rmSync(NodePath.join(target, "resumen.md"));
          NodeFS.symlinkSync(victim, NodePath.join(target, "resumen.md"));
          yield* evidence.write(share, target);
          assert.strictEqual(NodeFS.readFileSync(victim, "utf8"), "intacto");
          assert.isFalse(NodeFS.lstatSync(NodePath.join(target, "resumen.md")).isSymbolicLink());
          // The RPC checks its final folder, not only the parent it was given.
          const client = yield* clientWith([
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
          ]);
          const parent = NodePath.join(root, "padre");
          NodeFS.mkdirSync(parent);
          NodeFS.symlinkSync(outside, NodePath.join(parent, share.packageName), "dir");
          const viaRpc = yield* Effect.flip(
            client[EDITORIAL_RESULTS_WS_METHODS.export]({ mode: "share", directory: parent }),
          );
          assert.strictEqual(viaRpc._tag, "EditorialEvidenceExportError");
          assert.deepStrictEqual(NodeFS.readdirSync(outside), ["victima.txt"]);
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
    ),
  );
});
