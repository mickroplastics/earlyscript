import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

// Manual baseline of the Results space: the operator's hand-kept log from before the app, a
// closed record that an import replaces whole. Descriptive only, never a computed "saving".
// Re-exported by `editorialResults.ts`, whose RPC group carries its two methods.

/** Largest CSV the import accepts, in UTF-8 bytes. */
export const EDITORIAL_BASELINE_CSV_MAX_BYTES = 64 * 1024;

/** The columns of the CSV, in the order the original log uses. Every one is required. */
export const EDITORIAL_BASELINE_CSV_COLUMNS = [
  "fecha",
  "bloque",
  "inicio",
  "fin",
  "min_busqueda",
  "min_escritura",
  "min_total_sin_separar",
  "modo",
  "resultado",
  "fuente_senal",
  "interrupciones",
  "observaciones",
] as const;

/**
 * How a block's minutes were obtained: `cronometrado` timed at the moment (an observation),
 * `reconstruido` estimated afterwards from history and notes (an estimate).
 */
export const EditorialBaselineMode = Schema.Literals(["reconstruido", "cronometrado"]);
export type EditorialBaselineMode = typeof EditorialBaselineMode.Type;

/** What a block ended in, closed so the counts by outcome mean the same thing every time. */
export const EDITORIAL_BASELINE_OUTCOMES = [
  "idea descartada",
  "idea en espera",
  "ficha escrita",
  "ficha revisada",
  "guion borrador",
  "guion terminado",
] as const;
export const EditorialBaselineOutcome = Schema.Literals(EDITORIAL_BASELINE_OUTCOMES);
export type EditorialBaselineOutcome = typeof EditorialBaselineOutcome.Type;

/** `YYYY-MM-DD`, a calendar day of the log (the operator's local day, not UTC). */
const BaselineDay = Schema.String;

export const EditorialBaselineBlock = Schema.Struct({
  fecha: BaselineDay,
  bloque: PositiveInt,
  /** `HH:MM`, or null when not noted. */
  inicio: Schema.NullOr(Schema.String),
  fin: Schema.NullOr(Schema.String),
  minBusqueda: Schema.NullOr(NonNegativeInt),
  minEscritura: Schema.NullOr(NonNegativeInt),
  /** Only when search and writing were not kept apart. */
  minTotalSinSeparar: Schema.NullOr(NonNegativeInt),
  /**
   * The block's minutes: `minTotalSinSeparar` when present, else search plus writing when
   * both are known, else null (an incomplete block, never estimated).
   */
  minTotal: Schema.NullOr(NonNegativeInt),
  modo: EditorialBaselineMode,
  resultado: EditorialBaselineOutcome,
  fuente: Schema.NullOr(Schema.String),
  /** Interruptions noted, not discounted from the minutes; null when not noted. */
  interrupciones: Schema.NullOr(NonNegativeInt),
  observaciones: Schema.NullOr(Schema.String),
});
export type EditorialBaselineBlock = typeof EditorialBaselineBlock.Type;

/** A day of the log's range without any block: missing, never zero. */
export const EditorialBaselineMissingDay = Schema.Struct({
  fecha: BaselineDay,
  observaciones: Schema.NullOr(Schema.String),
});
export type EditorialBaselineMissingDay = typeof EditorialBaselineMissingDay.Type;

/** Minutes over blocks, as order statistics in milliseconds like the assisted ones. */
const BaselineStats = Schema.Struct({
  n: NonNegativeInt,
  medianMs: Schema.NullOr(Schema.Finite),
  q1Ms: Schema.NullOr(Schema.Finite),
  q3Ms: Schema.NullOr(Schema.Finite),
  minMs: Schema.NullOr(Schema.Finite),
  maxMs: Schema.NullOr(Schema.Finite),
});

export const EditorialBaselineGroupKey = Schema.Literals([
  "cronometrado",
  "reconstruido",
  "conjunto",
]);
export type EditorialBaselineGroupKey = typeof EditorialBaselineGroupKey.Type;

/**
 * Aggregates over the blocks of one mode, or of both (`conjunto`). Only stored values count:
 * a missing cell leaves that block out of that statistic's n, and a block with only
 * `minTotalSinSeparar` enters the total but neither search nor writing.
 */
export const EditorialBaselineGroup = Schema.Struct({
  key: EditorialBaselineGroupKey,
  blocks: NonNegativeInt,
  /** Distinct days with at least one block. */
  daysRecorded: NonNegativeInt,
  search: BaselineStats,
  /** Every block with a writing value, pure discard blocks (0 min) included. */
  writing: BaselineStats,
  /** Only blocks where something was written (more than 0 min). */
  writingNonZero: BaselineStats,
  /** Blocks with a known total. */
  total: BaselineStats,
  searchMinutes: NonNegativeInt,
  writingMinutes: NonNegativeInt,
  /** Sum of the known block totals. */
  completeMinutes: NonNegativeInt,
  /** `completeMinutes` plus the known parts of incomplete blocks: a lower bound. */
  knownMinutes: NonNegativeInt,
  /** Blocks without a total (a part not measured). */
  incompleteBlocks: NonNegativeInt,
  interruptions: NonNegativeInt,
  blocksWithInterruptions: NonNegativeInt,
  /** Count per outcome, in `EDITORIAL_BASELINE_OUTCOMES` order, zeros included. */
  outcomes: Schema.Array(
    Schema.Struct({ resultado: EditorialBaselineOutcome, blocks: NonNegativeInt }),
  ),
});
export type EditorialBaselineGroup = typeof EditorialBaselineGroup.Type;

/** Seven calendar days from the first day of the range; the last one may be shorter. */
export const EditorialBaselineWeek = Schema.Struct({
  from: BaselineDay,
  to: BaselineDay,
  days: PositiveInt,
  daysRecorded: NonNegativeInt,
  daysMissing: NonNegativeInt,
  blocks: NonNegativeInt,
  /** Modes of the week's blocks, in `EditorialBaselineMode` order. */
  modes: Schema.Array(EditorialBaselineMode),
  completeMinutes: NonNegativeInt,
  knownMinutes: NonNegativeInt,
  incompleteBlocks: NonNegativeInt,
});
export type EditorialBaselineWeek = typeof EditorialBaselineWeek.Type;

export const EditorialBaselineProvenance = Schema.Struct({
  /** sha256 of the CSV text as imported, UTF-8. */
  sourceHash: Schema.String,
  importedAt: IsoDateTime,
  actor: Schema.String,
  /** First and last day of the log (blocks and missing days). */
  from: BaselineDay,
  to: BaselineDay,
});
export type EditorialBaselineProvenance = typeof EditorialBaselineProvenance.Type;

export const EditorialBaselineRecord = Schema.Struct({
  /** Null when no log was imported: the page shows the import, not zeros. */
  provenance: Schema.NullOr(EditorialBaselineProvenance),
  /** By day, then block. */
  blocks: Schema.Array(EditorialBaselineBlock),
  missingDays: Schema.Array(EditorialBaselineMissingDay),
  /** `cronometrado`, `reconstruido` and `conjunto`, in that order. */
  groups: Schema.Array(EditorialBaselineGroup),
  weeks: Schema.Array(EditorialBaselineWeek),
  /** Stored rows left out because a value is out of its domain (the tables are not STRICT). */
  excludedByDomain: NonNegativeInt,
});
export type EditorialBaselineRecord = typeof EditorialBaselineRecord.Type;

export const EditorialBaselineInput = Schema.Struct({});

export const EditorialBaselineImportInput = Schema.Struct({
  /** The CSV as text; the server checks its UTF-8 size against the limit. */
  csv: Schema.String.check(Schema.isMaxLength(EDITORIAL_BASELINE_CSV_MAX_BYTES)),
});
export type EditorialBaselineImportInput = typeof EditorialBaselineImportInput.Type;

/** A problem in the CSV: its line in the file (1 is the header) and column, when known. */
export const EditorialBaselineImportIssue = Schema.Struct({
  line: Schema.NullOr(PositiveInt),
  column: Schema.NullOr(Schema.String),
  message: Schema.String,
});
export type EditorialBaselineImportIssue = typeof EditorialBaselineImportIssue.Type;

/**
 * `imported` replaced the stored log; `unchanged` found the same hash already stored and wrote
 * nothing; `rejected` found errors and wrote nothing (all or none). Warnings never block.
 */
export const EditorialBaselineImportResult = Schema.Struct({
  status: Schema.Literals(["imported", "unchanged", "rejected"]),
  errors: Schema.Array(EditorialBaselineImportIssue),
  warnings: Schema.Array(EditorialBaselineImportIssue),
  blocks: NonNegativeInt,
  missingDays: NonNegativeInt,
  from: Schema.NullOr(BaselineDay),
  to: Schema.NullOr(BaselineDay),
  sourceHash: Schema.String,
  /** True when a log with another hash was stored before and this import replaced it. */
  replaced: Schema.Boolean,
});
export type EditorialBaselineImportResult = typeof EditorialBaselineImportResult.Type;
