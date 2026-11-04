import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EDITORIAL_RESULTS_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { EditorialManualBaselineService } from "./EditorialManualBaselineService.ts";
import * as EditorialManualBaseline from "./EditorialManualBaselineService.ts";
import { sha256Hex } from "./evidenceFormat.ts";
import { BASELINE_FIXTURE_CSV, seedBaselineFixture } from "./manualBaseline.testkit.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";

const withBaseline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withEditorialDatabase(effect.pipe(Effect.provide(EditorialManualBaseline.layer)));

const SECOND_LOG = [
  "fecha,bloque,inicio,fin,min_busqueda,min_escritura,min_total_sin_separar,modo,resultado,fuente_senal,interrupciones,observaciones",
  "2026-11-02,1,08:00,09:00,30,30,,cronometrado,ficha escrita,GitHub,0,",
  "",
].join("\n");

describe("EditorialManualBaselineService", () => {
  it.effect("reads nothing before an import: no provenance, no zeros", () =>
    withBaseline(
      Effect.gen(function* () {
        const baseline = yield* EditorialManualBaselineService;
        const record = yield* baseline.read;
        assert.isNull(record.provenance);
        assert.deepStrictEqual(record.blocks, []);
        assert.deepStrictEqual(record.missingDays, []);
        assert.deepStrictEqual(record.weeks, []);
        assert.strictEqual(record.groups.find((group) => group.key === "conjunto")!.search.n, 0);
      }),
    ),
  );

  it.effect("imports the log, keeps its hash and reads it back with the missing days", () =>
    withBaseline(
      Effect.gen(function* () {
        const result = yield* seedBaselineFixture;
        assert.strictEqual(result.status, "imported");
        assert.isFalse(result.replaced);
        assert.strictEqual(result.blocks, 17);
        assert.strictEqual(result.missingDays, 2);
        assert.strictEqual(result.sourceHash, sha256Hex(BASELINE_FIXTURE_CSV));

        const baseline = yield* EditorialManualBaselineService;
        const record = yield* baseline.read;
        assert.deepStrictEqual(
          record.provenance && {
            sourceHash: record.provenance.sourceHash,
            actor: record.provenance.actor,
            from: record.provenance.from,
            to: record.provenance.to,
          },
          {
            sourceHash: sha256Hex(BASELINE_FIXTURE_CSV),
            actor: "operator",
            from: "2026-10-01",
            to: "2026-10-14",
          },
        );
        assert.strictEqual(record.blocks.length, 17);
        assert.deepStrictEqual(
          record.missingDays.map((day) => day.fecha),
          ["2026-10-04", "2026-10-10"],
        );
        assert.strictEqual(record.weeks.length, 2);
        assert.strictEqual(record.excludedByDomain, 0);
        const both = record.groups.find((group) => group.key === "conjunto")!;
        assert.strictEqual(both.searchMinutes, 1000);
        assert.strictEqual(both.knownMinutes, 1815);
      }),
    ),
  );

  it.effect("finds the same hash unchanged and replaces the whole log with another", () =>
    withBaseline(
      Effect.gen(function* () {
        yield* seedBaselineFixture;
        const baseline = yield* EditorialManualBaselineService;
        const before = yield* baseline.read;
        const again = yield* baseline.importCsv(BASELINE_FIXTURE_CSV);
        assert.strictEqual(again.status, "unchanged");
        assert.deepStrictEqual(yield* baseline.read, before);

        const replaced = yield* baseline.importCsv(SECOND_LOG);
        assert.strictEqual(replaced.status, "imported");
        assert.isTrue(replaced.replaced);
        const record = yield* baseline.read;
        assert.strictEqual(record.blocks.length, 1);
        assert.deepStrictEqual(record.missingDays, []);
        assert.strictEqual(record.provenance!.sourceHash, sha256Hex(SECOND_LOG));
      }),
    ),
  );

  it.effect("rejects a log with errors and leaves the stored one untouched", () =>
    withBaseline(
      Effect.gen(function* () {
        yield* seedBaselineFixture;
        const baseline = yield* EditorialManualBaselineService;
        const before = yield* baseline.read;
        const rejected = yield* baseline.importCsv(SECOND_LOG.replace("cronometrado", "a ojo"));
        assert.strictEqual(rejected.status, "rejected");
        assert.deepStrictEqual(
          rejected.errors.map((error) => [error.line, error.column]),
          [[2, "modo"]],
        );
        assert.deepStrictEqual(yield* baseline.read, before);
      }),
    ),
  );

  it.effect("leaves stored rows out of their domain out of every aggregate and counts them", () =>
    withBaseline(
      Effect.gen(function* () {
        yield* seedBaselineFixture;
        const sql = yield* EditorialSql;
        yield* sql`PRAGMA ignore_check_constraints = ON`;
        yield* sql`
          UPDATE editorial_manual_baseline_blocks SET min_busqueda = 'mucho'
          WHERE fecha = '2026-10-01' AND bloque = 1
        `;
        yield* sql`
          UPDATE editorial_manual_baseline_blocks SET resultado = 'inventado'
          WHERE fecha = '2026-10-14'
        `;
        yield* sql`UPDATE editorial_manual_baseline_missing_days SET fecha = 'ayer' WHERE fecha = '2026-10-04'`;
        yield* sql`PRAGMA ignore_check_constraints = OFF`;
        const baseline = yield* EditorialManualBaselineService;
        const record = yield* baseline.read;
        assert.strictEqual(record.excludedByDomain, 3);
        assert.strictEqual(record.blocks.length, 15);
        assert.deepStrictEqual(
          record.missingDays.map((day) => day.fecha),
          ["2026-10-10"],
        );
        assert.strictEqual(record.groups.find((group) => group.key === "conjunto")!.blocks, 15);
      }),
    ),
  );
});

describe("editorial.results.baseline RPCs", () => {
  it("reads with orchestration:read and imports with orchestration:operate", () => {
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_RESULTS_WS_METHODS.baseline),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_RESULTS_WS_METHODS.baselineImport),
      AuthOrchestrationOperateScope,
    );
  });
});
