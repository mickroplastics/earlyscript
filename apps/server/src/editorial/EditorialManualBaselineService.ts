import {
  EDITORIAL_BASELINE_OUTCOMES,
  EditorialResultsError,
  type EditorialBaselineBlock,
  type EditorialBaselineImportResult,
  type EditorialBaselineMissingDay,
  type EditorialBaselineRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { intInRange } from "./decisionDomain.ts";
import { sha256Hex } from "./evidenceFormat.ts";
import {
  BASELINE_INTERRUPTIONS_MAX,
  BASELINE_MINUTES_MAX,
  blockTotal,
  parseBaselineCsv,
  summarizeGroups,
  summarizeWeeks,
} from "./manualBaselineFormat.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { nowIso } from "./persistence/support.ts";

/** Who writes the log: the operator, through the Results page or the RPC. */
const ACTOR = "operator";

export interface EditorialManualBaselineServiceShape {
  /** The stored log with its missing days and aggregates; `provenance` null when none. */
  readonly read: Effect.Effect<EditorialBaselineRecord, EditorialResultsError>;
  /** Checks the whole CSV and, without errors, replaces the stored log in one transaction. */
  readonly importCsv: (
    csv: string,
  ) => Effect.Effect<EditorialBaselineImportResult, EditorialResultsError>;
}

/**
 * The manual baseline of the Results space over `editorial.sqlite`: the operator's own log of
 * the manual process, kept by hand before the app. A closed record, replaced whole.
 */
export class EditorialManualBaselineService extends Context.Service<
  EditorialManualBaselineService,
  EditorialManualBaselineServiceShape
>()("t3/editorial/EditorialManualBaselineService") {}

interface BlockRow {
  readonly fecha: unknown;
  readonly bloque: unknown;
  readonly inicio: unknown;
  readonly fin: unknown;
  readonly min_busqueda: unknown;
  readonly min_escritura: unknown;
  readonly min_total_sin_separar: unknown;
  readonly modo: unknown;
  readonly resultado: unknown;
  readonly fuente_senal: unknown;
  readonly interrupciones: unknown;
  readonly observaciones: unknown;
  readonly source_hash: unknown;
  readonly imported_at: unknown;
  readonly actor: unknown;
}

interface MissingRow {
  readonly fecha: unknown;
  readonly observaciones: unknown;
  readonly source_hash: unknown;
  readonly imported_at: unknown;
  readonly actor: unknown;
}

const STORED_DAY = /^\d{4}-\d{2}-\d{2}$/;
const STORED_CLOCK = /^[0-2]\d:[0-5]\d$/;

const isDay = (value: unknown): value is string =>
  typeof value === "string" && STORED_DAY.test(value) && !Number.isNaN(Date.parse(value));
const optionalText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const optionalClock = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && STORED_CLOCK.test(value));
const optionalInt = (value: unknown, max: number): value is number | null =>
  value === null || intInRange(value, 0, max);

/**
 * A stored block inside its domain, or null. The tables are not STRICT and a CHECK can be
 * skipped, so the read checks every value before it enters an aggregate (as Results does).
 */
const storedBlock = (row: BlockRow): EditorialBaselineBlock | null => {
  const {
    fecha,
    bloque,
    inicio,
    fin,
    min_busqueda: minBusqueda,
    min_escritura: minEscritura,
    min_total_sin_separar: minTotalSinSeparar,
    modo,
    resultado,
    fuente_senal: fuente,
    interrupciones,
    observaciones,
  } = row;
  if (!isDay(fecha) || !intInRange(bloque, 1, 99)) return null;
  if (!optionalClock(inicio) || !optionalClock(fin)) return null;
  if (
    !optionalInt(minBusqueda, BASELINE_MINUTES_MAX) ||
    !optionalInt(minEscritura, BASELINE_MINUTES_MAX) ||
    !optionalInt(minTotalSinSeparar, BASELINE_MINUTES_MAX)
  ) {
    return null;
  }
  if (modo !== "reconstruido" && modo !== "cronometrado") return null;
  const outcome = EDITORIAL_BASELINE_OUTCOMES.find((entry) => entry === resultado);
  if (outcome === undefined) return null;
  if (!optionalText(fuente) || !optionalText(observaciones)) return null;
  if (!optionalInt(interrupciones, BASELINE_INTERRUPTIONS_MAX)) return null;
  const parts = { minBusqueda, minEscritura, minTotalSinSeparar };
  return {
    fecha,
    bloque,
    inicio,
    fin,
    ...parts,
    minTotal: blockTotal(parts),
    modo,
    resultado: outcome,
    fuente,
    interrupciones,
    observaciones,
  };
};

const storedMissingDay = (row: MissingRow): EditorialBaselineMissingDay | null =>
  isDay(row.fecha) && optionalText(row.observaciones)
    ? { fecha: row.fecha, observaciones: row.observaciones }
    : null;

const text = (value: unknown) => (typeof value === "string" ? value : String(value ?? ""));

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;

  const failWith =
    (reason: "unreadable" | "unwritable", operation: string, message: string) => (cause: unknown) =>
      Effect.logWarning(`editorial manual baseline: ${operation} failed`, { cause }).pipe(
        Effect.andThen(Effect.fail(new EditorialResultsError({ reason, message }))),
      );

  const readRows = Effect.gen(function* () {
    const blocks = yield* sql<BlockRow>`
      SELECT fecha, bloque, inicio, fin, min_busqueda, min_escritura, min_total_sin_separar,
        modo, resultado, fuente_senal, interrupciones, observaciones, source_hash,
        imported_at, actor
      FROM editorial_manual_baseline_blocks
      ORDER BY fecha, bloque, rowid
    `;
    const missing = yield* sql<MissingRow>`
      SELECT fecha, observaciones, source_hash, imported_at, actor
      FROM editorial_manual_baseline_missing_days
      ORDER BY fecha, rowid
    `;
    return { blocks, missing };
  });

  const storedHash = sql<{ readonly source_hash: unknown }>`
    SELECT source_hash FROM editorial_manual_baseline_blocks
    UNION SELECT source_hash FROM editorial_manual_baseline_missing_days
  `;

  const read: EditorialManualBaselineServiceShape["read"] = Effect.gen(function* () {
    const rows = yield* readRows;
    const blocks = rows.blocks.flatMap((row) => storedBlock(row) ?? []);
    const missingDays = rows.missing.flatMap((row) => storedMissingDay(row) ?? []);
    const excludedByDomain =
      rows.blocks.length - blocks.length + rows.missing.length - missingDays.length;
    // One import writes one hash, time and actor on every row; the latest import names them.
    const latest = [...rows.blocks, ...rows.missing].toSorted((a, b) =>
      text(a.imported_at) < text(b.imported_at) ? 1 : -1,
    )[0];
    const days = [
      ...blocks.map((block) => block.fecha),
      ...missingDays.map((day) => day.fecha),
    ].toSorted();
    const from = days[0] ?? null;
    const to = days.at(-1) ?? null;
    return {
      provenance:
        latest === undefined || from === null || to === null
          ? null
          : {
              sourceHash: text(latest.source_hash),
              importedAt: text(latest.imported_at),
              actor: text(latest.actor),
              from,
              to,
            },
      blocks,
      missingDays,
      groups: summarizeGroups(blocks),
      weeks: summarizeWeeks(blocks, missingDays, from, to),
      excludedByDomain,
    } satisfies EditorialBaselineRecord;
  }).pipe(
    Effect.catchTags({
      SqlError: failWith("unreadable", "read", "The editorial database could not be read."),
    }),
    Effect.withSpan("EditorialManualBaselineService.read"),
  );

  const importCsv: EditorialManualBaselineServiceShape["importCsv"] = Effect.fn(
    "EditorialManualBaselineService.importCsv",
  )(
    function* (csv) {
      const parsed = parseBaselineCsv(csv);
      const sourceHash = sha256Hex(csv);
      const outcome = {
        errors: parsed.errors,
        warnings: parsed.warnings,
        blocks: parsed.blocks.length,
        missingDays: parsed.missingDays.length,
        from: parsed.from,
        to: parsed.to,
        sourceHash,
      };
      if (parsed.errors.length > 0) {
        return { ...outcome, status: "rejected", replaced: false } as const;
      }
      const importedAt = yield* nowIso;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const hashes = (yield* storedHash).map((row) => text(row.source_hash));
          if (hashes.length === 1 && hashes[0] === sourceHash) {
            return { ...outcome, status: "unchanged", replaced: false } as const;
          }
          yield* sql`DELETE FROM editorial_manual_baseline_blocks`;
          yield* sql`DELETE FROM editorial_manual_baseline_missing_days`;
          for (const block of parsed.blocks) {
            yield* sql`
              INSERT INTO editorial_manual_baseline_blocks (
                fecha, bloque, inicio, fin, min_busqueda, min_escritura, min_total_sin_separar,
                modo, resultado, fuente_senal, interrupciones, observaciones, source_hash,
                imported_at, actor
              ) VALUES (
                ${block.fecha}, ${block.bloque}, ${block.inicio}, ${block.fin},
                ${block.minBusqueda}, ${block.minEscritura}, ${block.minTotalSinSeparar},
                ${block.modo}, ${block.resultado}, ${block.fuente}, ${block.interrupciones},
                ${block.observaciones}, ${sourceHash}, ${importedAt}, ${ACTOR}
              )
            `;
          }
          for (const day of parsed.missingDays) {
            yield* sql`
              INSERT INTO editorial_manual_baseline_missing_days (
                fecha, observaciones, source_hash, imported_at, actor
              ) VALUES (${day.fecha}, ${day.observaciones}, ${sourceHash}, ${importedAt}, ${ACTOR})
            `;
          }
          return { ...outcome, status: "imported", replaced: hashes.length > 0 } as const;
        }),
      );
    },
    Effect.catchTags({
      SqlError: failWith("unwritable", "import", "The editorial database could not be written."),
    }),
  );

  return EditorialManualBaselineService.of({ read, importCsv });
});

export const layer = Layer.effect(EditorialManualBaselineService, make);
