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
  shareWhitelist,
} from "./evidenceFormat.ts";
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
      'run-fixture', '2026-10-19T00:00:00.000Z', '2026-10-19T00:05:00.000Z', 'ok', 'cfg1',
      'abcdef0123456789', '["hn","github"]', '{}', '/home/x/dossiers/run-fixture', '{}',
      'ffffffffffffffff', 3, 'partial', '[{"file":"dossiers/bad.json","reason":"MOTIVO-SECRETO"}]',
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

  it("keeps the share whitelist frozen and free of text columns", () => {
    assert.deepStrictEqual(shareWhitelist(), FROZEN_SHARE_COLUMNS);
    for (const specs of Object.values(EVIDENCE_COLUMNS)) {
      for (const spec of specs) {
        if (spec.kind === "text") assert.isFalse(spec.share, spec.name);
      }
    }
    const forbidden = /reason|url|title|note|path|directory|session|tab|environment|dossier/i;
    // Only rules that keep a string can carry a word; `work.stopped.reason` is the enum
    // `stopped` | `decided`, never typed text.
    const enumNamedLikeText = new Set(["work.stopped.reason"]);
    const textFree = new Set(["boolean", "number", "date", "hash", "thread", "trend"]);
    for (const [type, fields] of Object.entries(SHARE_EVENT_DATA)) {
      for (const [field, rule] of Object.entries(fields)) {
        const name = `${type}.${field}`;
        if (textFree.has(rule)) continue;
        if (enumNamedLikeText.has(name)) assert.strictEqual(rule, "enum", name);
        else assert.notMatch(field, forbidden, name);
      }
    }
  });

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
          "run-fixture,2026-10-19,2026-10-19,ok,partial,,cfg1,abcdef0123456789,,ffffffffffffffff,,hn;github,3,6,1,0,1",
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
        assert.include(fileOf(window, "resumen.md"), "desde 2026-10-24 hasta 2026-10-26");
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
});
