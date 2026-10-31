// @effect-diagnostics nodeBuiltinImport:off -- sha256 of each exported file.
import * as NodeCrypto from "node:crypto";

import type { EditorialEvidenceMode } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { SOURCE_IDS } from "@earlyscript/editorial-contracts/sourceCatalog";

import {
  COUNT_MAX,
  DATE_MAX,
  DATE_MIN,
  STAGE_MS_MAX,
  TOTAL_MS_MAX,
  UTILITY_MAX,
  UTILITY_MIN,
  dateInRange,
  intInRange,
} from "./decisionDomain.ts";
import { EditorialEventType, WORK_STAGES } from "./persistence/EditorialModel.ts";
import { parseIso } from "./persistence/support.ts";

// Pure half of the evidence export: column lists, the share whitelist, pseudonyms, CSV and
// hashing. `EditorialEvidenceExportService.ts` reads the database and writes the files.

export const EVIDENCE_SCHEMA = "earlyscript.evidence/1";
export const MANIFEST_FILE = "manifest.json";
export const SUMMARY_FILE = "resumen.md";

/**
 * What `share` accepts in a cell or event field. Every rule is a closed format: an enum with
 * its real values, an integer, a UTC day, a 64-hex sha256, a strict engine version, catalog
 * source ids, or an index (`h001`, `t001`, `r001`). A value that fails its rule leaves an
 * empty cell; nothing is copied without passing one.
 */
export type ShareRule =
  | { readonly kind: "enum"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "int"; readonly min: number; readonly max: number }
  | { readonly kind: "number" }
  | { readonly kind: "bool" }
  | { readonly kind: "day" }
  | { readonly kind: "hash" }
  | { readonly kind: "version" }
  | { readonly kind: "sources" }
  | { readonly kind: "thread" }
  | { readonly kind: "trend" }
  | { readonly kind: "run" }
  | { readonly kind: "aggregate-id" }
  | { readonly kind: "event-data" }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ShareRule>> };

const oneOf = (...values: ReadonlyArray<string>): ShareRule => ({ kind: "enum", values });
/** Integers carry their domain, not only their shape (R8): a count is never negative. */
const int = (min: number, max: number): ShareRule => ({ kind: "int", min, max });
const INT = int(0, COUNT_MAX);
const ORDINAL = int(1, COUNT_MAX);
const UTILITY = int(UTILITY_MIN, UTILITY_MAX);
const STAGE_MS = int(0, STAGE_MS_MAX);
const TOTAL_MS = int(0, TOTAL_MS_MAX);
const NUMBER: ShareRule = { kind: "number" };
const BOOL: ShareRule = { kind: "bool" };
const DAY: ShareRule = { kind: "day" };
const HASH: ShareRule = { kind: "hash" };
const THREAD: ShareRule = { kind: "thread" };
const TREND: ShareRule = { kind: "trend" };
const RUN: ShareRule = { kind: "run" };
const object = (fields: Readonly<Record<string, ShareRule>>): ShareRule => ({
  kind: "object",
  fields,
});

const MODES = oneOf("assisted", "manual");
const STAGES = oneOf(...WORK_STAGES);
const IMPORT_STATES = oneOf("imported", "partial", "invalid");
const CLOCK_STATES = oneOf("running", "paused");
const SNOOZE_METRICS = oneOf("items7d", "authors7d", "items28d", "score");

export interface ColumnSpec {
  readonly name: string;
  /** How `share` writes the column; null when only `full` has it (free text, raw ids). */
  readonly share: ShareRule | null;
  readonly description: string;
}

export type CsvValue = string | number | boolean | null;
export type CsvRow = Readonly<Record<string, CsvValue>>;

const column = (name: string, share: ShareRule | null, description: string): ColumnSpec => ({
  name,
  share,
  description,
});

export const DECISIONS_FILE = "decisiones.csv";
export const INTERVALS_FILE = "tiempos.csv";
export const EVENTS_FILE = "eventos.csv";
export const RUNS_FILE = "corridas.csv";
export const CAPTURES_FILE = "capturas.csv";

export const EVIDENCE_COLUMNS: Readonly<Record<string, ReadonlyArray<ColumnSpec>>> = {
  [DECISIONS_FILE]: [
    column("hilo", THREAD, "Hilo de video; en share, índice estable h001…"),
    column("entorno", null, "Entorno de T3 que registró el hilo."),
    column("modo", MODES, "assisted o manual."),
    column("tendencia", TREND, "Clave de tendencia; en share, índice estable t001…"),
    column("corrida", RUN, "Corrida del motor del hilo asistido; en share, índice r001…"),
    column("expediente", null, "Expediente de la corrida."),
    column("decision", null, "Identificador de la decisión."),
    column("accion", oneOf("accept", "edit", "reject"), "accept, edit o reject."),
    column("utilidad", UTILITY, "Utilidad 1 a 5 que registró el operador."),
    column("motivo", null, "Motivo escrito con la decisión."),
    column("vigente", BOOL, "1 si es la última decisión del hilo dentro del filtro."),
    column("reloj_definitivo", BOOL, "0 si un tramo esperaba resolución: los tiempos son un piso."),
    column(
      "cobertura",
      oneOf("complete", "partial"),
      "complete si el hilo registró todas las etapas de su modo.",
    ),
    column("explorar_ms", STAGE_MS, "Milisegundos activos en Explorar; vacío si no corrió."),
    column("leer_ms", STAGE_MS, "Milisegundos activos en Leer; vacío si no corrió."),
    column("escribir_ms", STAGE_MS, "Milisegundos activos en Escribir; vacío si no corrió."),
    column("decidir_ms", STAGE_MS, "Milisegundos activos en Decidir; vacío si no corrió."),
    column("total_ms", TOTAL_MS, "Suma de las etapas registradas."),
    column("guion_hash", HASH, "sha256 de la versión del guion decidida."),
    column("afirmaciones", INT, "Oraciones del guion decidido (conteo mecánico)."),
    column("con_cita", INT, "De ellas, con marcador de cita (no mide respaldo)."),
    column("vistas", INT, "Última observación registrada a mano."),
    column("suscriptores", INT, "Última observación registrada a mano."),
    column("clics", INT, "Última observación registrada a mano."),
    column("comentarios", INT, "Última observación registrada a mano."),
    column("metricas_observadas", DAY, "Fecha de esa observación."),
    column("decidida", DAY, "Fecha de la decisión."),
  ],
  [INTERVALS_FILE]: [
    column("hilo", THREAD, "Hilo de video; en share, índice estable."),
    column("modo", MODES, "assisted o manual."),
    column("tramo", ORDINAL, "Orden del tramo dentro del hilo, desde 1."),
    column("tramo_id", null, "Identificador del tramo."),
    column("etapa", STAGES, "explore, read, write o decide."),
    column(
      "estado",
      oneOf("closed", "open", "needs_resolution"),
      "closed, open o needs_resolution.",
    ),
    column("inicio", DAY, "Inicio del tramo."),
    column("fin", DAY, "Fin del tramo; vacío si sigue abierto o sin resolver."),
    column("duracion_ms", STAGE_MS, "fin − inicio; vacío si el tramo no está cerrado."),
    column(
      "motivo_fin",
      oneOf("paused", "stage_changed", "stopped", "decided", "resolved"),
      "paused, stage_changed, stopped, decided o resolved.",
    ),
    column("motivo_pausa", null, "Motivo escrito al pausar."),
    column("fin_pausa", DAY, "Fin de la pausa que siguió al tramo."),
    column("recuperado", DAY, "Momento en que el servidor marcó el tramo para resolver."),
  ],
  [EVENTS_FILE]: [
    column("seq", ORDINAL, "Orden del evento en la bitácora."),
    column("tipo", oneOf(...EditorialEventType.literals), "Tipo de evento editorial."),
    column("fecha", DAY, "Momento del evento."),
    column("agregado", oneOf("trend", "video_thread", "run"), "trend, video_thread o run."),
    column(
      "id",
      { kind: "aggregate-id" },
      "Tendencia, hilo o corrida; en share, su índice (t001, h001, r001).",
    ),
    column("actor", oneOf("operator", "system"), "operator o system."),
    column("operacion", null, "Identificador de operación idempotente."),
    column(
      "datos",
      { kind: "event-data" },
      "Carga del evento en JSON; en share, solo los campos de eventData, cada uno validado.",
    ),
  ],
  [RUNS_FILE]: [
    column("corrida", RUN, "Identificador de la corrida del motor; en share, índice r001…"),
    column("corte", DAY, "Corte de la corrida."),
    column("terminada", DAY, "Fin de la corrida según el motor."),
    column("estado_motor", oneOf("ok", "failed", "unknown"), "Estado que declaró el motor."),
    column("estado_importacion", IMPORT_STATES, "imported, partial o invalid."),
    column("version_motor", { kind: "version" }, "Versión del motor (x.y.z o engine.vX.Y)."),
    column("config_hash", HASH, "Hash de la configuración del motor."),
    column("hash_logico", HASH, "Hash lógico de la corrida (reproducibilidad)."),
    column("corpus_hash", HASH, "Hash del corpus usado."),
    column("contenido_hash", HASH, "sha256 de run.json y de los expedientes leídos."),
    column("perfil_hash", HASH, "Hash del perfil del canal usado por la corrida nocturna."),
    column(
      "fuentes",
      { kind: "sources" },
      "Fuentes del catálogo usadas por la corrida, separadas por punto y coma.",
    ),
    column("expedientes", INT, "Expedientes indexados (tendencias emitidas)."),
    column("vistas", INT, "Tendencias distintas abiertas en esta corrida (trend.read)."),
    column("descartadas", INT, "Tendencias de la corrida descartadas en la bandeja actual."),
    column("producidas", INT, "Hilos de video registrados desde esta corrida."),
    column("omitidos", INT, "Archivos de la corrida que no se pudieron leer."),
    column("omitidos_motivos", null, "Archivo y motivo de cada omitido, en JSON."),
  ],
  [CAPTURES_FILE]: [
    column("hilo", null, "Hilo de video."),
    column("captura", null, "Identificador de la captura."),
    column("url", null, "Página capturada."),
    column("titulo", null, "Título de la página."),
    column("nota", null, "Nota del operador."),
    column("capturada", null, "Momento de la captura."),
    column("retirada", null, "Momento en que se retiró, si se retiró."),
  ],
};

/** The files of each mode, in manifest order; `capturas.csv` is all free text. */
export const EVIDENCE_FILES: Readonly<Record<EditorialEvidenceMode, ReadonlyArray<string>>> = {
  full: [SUMMARY_FILE, DECISIONS_FILE, INTERVALS_FILE, EVENTS_FILE, RUNS_FILE, CAPTURES_FILE],
  share: [SUMMARY_FILE, DECISIONS_FILE, INTERVALS_FILE, EVENTS_FILE, RUNS_FILE],
};

/** Every name an export may write, so a new export over an old one leaves no stale file. */
export const ALL_EVIDENCE_FILES: ReadonlyArray<string> = [
  ...new Set([...EVIDENCE_FILES.full, ...EVIDENCE_FILES.share, MANIFEST_FILE]),
];

export const columnsOf = (file: string, mode: EditorialEvidenceMode): ReadonlyArray<ColumnSpec> =>
  (EVIDENCE_COLUMNS[file] ?? []).filter((spec) => mode === "full" || spec.share !== null);

/** The share whitelist by file, as the manifest documents it. */
export const shareWhitelist = (): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    EVIDENCE_FILES.share
      .filter((file) => file.endsWith(".csv"))
      .map((file) => [file, columnsOf(file, "share").map((spec) => spec.name)]),
  );

const PURGE_COUNTS = {
  visits: INT,
  captures: INT,
  decisions: INT,
  results: INT,
  workIntervals: INT,
  scriptVersions: INT,
  versionFiles: INT,
  events: INT,
} as const;

const RUN_IMPORT = {
  cutoffAt: DAY,
  dossierCount: INT,
  importState: IMPORT_STATES,
  previousImportState: IMPORT_STATES,
  contentHash: HASH,
  previousContentHash: HASH,
  logicalHash: HASH,
  interpretationVersion: INT,
  previousInterpretationVersion: INT,
} as const;

/**
 * What `share` keeps of an event payload, by type, nested objects included. A `Record` over
 * `EditorialEventType`, so a new event type does not compile until someone declares what of it
 * may leave. Properties not named, at any depth, are dropped with their keys.
 */
export const SHARE_EVENT_DATA: Readonly<
  Record<EditorialEventType, Readonly<Record<string, ShareRule>>>
> = {
  "trend.read": { runId: RUN, runCutoffAt: DAY },
  "trend.snoozed": {
    until: DAY,
    returnWhen: object({ metric: SNOOZE_METRICS, baseline: NUMBER, atLeast: NUMBER }),
  },
  "trend.unsnoozed": {
    cause: oneOf("operator", "growth", "expired"),
    observed: object({ runId: RUN, metric: SNOOZE_METRICS, value: NUMBER }),
  },
  "trend.dismissed": {},
  "trend.reopened": {},
  "trend.production-linked": { threadId: THREAD, previousThreadId: THREAD },
  "video-thread.registered": { mode: MODES, trendKey: TREND, runId: RUN },
  "video-thread.launched": { previous: oneOf("pending", "launched", "failed") },
  "video-thread.launch-failed": { previous: oneOf("pending", "launched", "failed") },
  "video-thread.purged": { mode: MODES, ...PURGE_COUNTS },
  "video-thread.t3-deleted": {},
  "work.started": { stage: STAGES },
  "work.paused": { stage: STAGES },
  "work.resumed": { stage: STAGES },
  "work.stage-changed": { from: STAGES, to: STAGES, fromState: CLOCK_STATES },
  "work.stopped": { stage: STAGES, reason: oneOf("stopped", "decided"), from: CLOCK_STATES },
  "work.recovery-needed": { stage: STAGES, startedAt: DAY },
  "work.resolved": { endedAt: DAY },
  "decision.recorded": {
    action: oneOf("accept", "edit", "reject"),
    utility: UTILITY,
    scriptVersionHash: HASH,
    clockDefinitive: BOOL,
  },
  "script.version-saved": { contentHash: HASH, bytes: INT },
  "script.head-restored": { contentHash: HASH },
  "capture.saved": {},
  "capture.removed": {},
  "browser.visited": { origin: oneOf("desktop", "server", "automation"), titleOnly: BOOL },
  "result.saved": {
    views: INT,
    subscribers: INT,
    clicks: INT,
    comments: INT,
    observedAt: DAY,
  },
  "run.imported": RUN_IMPORT,
  "run.updated": RUN_IMPORT,
  "run.invalidated": { previousImportState: IMPORT_STATES, contentHash: HASH },
};

/** A rule in words, for the manifest. */
export const describeRule = (rule: ShareRule): string => {
  switch (rule.kind) {
    case "enum":
      return `uno de: ${rule.values.join(", ")}`;
    case "int":
      return rule.max === COUNT_MAX
        ? `entero desde ${rule.min}`
        : `entero de ${rule.min} a ${rule.max}`;
    case "number":
      return "número finito";
    case "bool":
      return "1 o 0";
    case "day":
      return `día UTC AAAA-MM-DD entre ${DATE_MIN.slice(0, 10)} y ${DATE_MAX.slice(0, 10)} (exclusivo)`;
    case "hash":
      return "sha256 de 64 hexadecimales, con o sin prefijo sha256:";
    case "version":
      return "x.y.z o engine.vX.Y";
    case "sources":
      return "ids del catálogo de fuentes";
    case "thread":
      return "índice h001…";
    case "trend":
      return "índice t001…";
    case "run":
      return "índice r001…";
    case "aggregate-id":
      return "índice según agregado (t, h o r)";
    case "event-data":
      return "JSON con los campos de eventData";
    case "object":
      return "objeto con propiedades cerradas";
  }
};

/** Every allowed field path of each event type (`returnWhen.metric`), with its rule. */
export const shareEventDataWhitelist = (): Readonly<
  Record<string, Readonly<Record<string, string>>>
> => {
  const paths = (fields: Readonly<Record<string, ShareRule>>, prefix: string) =>
    Object.entries(fields).flatMap(([key, rule]): ReadonlyArray<readonly [string, string]> =>
      rule.kind === "object"
        ? paths(rule.fields, `${prefix}${key}.`)
        : [[`${prefix}${key}`, describeRule(rule)]],
    );
  return Object.fromEntries(
    Object.entries(SHARE_EVENT_DATA)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([type, fields]) => [
        type,
        Object.fromEntries(paths(fields, "").toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ]),
  );
};

/** Stable pseudonyms: `h001` threads, `t001` trends, `r001` runs, in first-seen order. */
export interface Pseudonyms {
  readonly thread: (threadId: string | null) => string | null;
  readonly trend: (trendKey: string | null) => string | null;
  readonly run: (runId: string | null) => string | null;
}

export const makePseudonyms = (ids: {
  readonly threads: ReadonlyArray<string>;
  readonly trends: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<string>;
}): Pseudonyms => {
  const index = (prefix: string, list: ReadonlyArray<string>) => {
    const width = Math.max(3, String(list.length).length);
    const map = new Map<string, string>();
    for (const id of list) {
      if (!map.has(id)) map.set(id, `${prefix}${String(map.size + 1).padStart(width, "0")}`);
    }
    // An id outside the universe (should not happen) still never leaves as is.
    return (id: string | null) => (id === null ? null : (map.get(id) ?? `${prefix}?`));
  };
  return {
    thread: index("h", ids.threads),
    trend: index("t", ids.trends),
    run: index("r", ids.runs),
  };
};

/** The UTC day of an ISO date-time, or null when it does not parse. */
export const utcDay = (value: string | null): string | null =>
  value === null ? null : Option.getOrNull(Option.map(parseIso(value), (iso) => iso.slice(0, 10)));

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const HASH_FORMAT = /^(sha256:)?[0-9a-f]{64}$/;
const VERSION_FORMAT = /^(\d{1,4}\.\d{1,4}\.\d{1,4}|engine\.v\d{1,4}\.\d{1,4})$/;
const CATALOG_SOURCES: ReadonlySet<string> = new Set(SOURCE_IDS);

const sharedObject = (
  fields: Readonly<Record<string, ShareRule>>,
  value: unknown,
  names: Pseudonyms,
): Record<string, unknown> => {
  const kept: Record<string, unknown> = {};
  if (!isPlainObject(value)) return kept;
  for (const [key, rule] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = shareValue(rule, value[key], names);
    if (entry !== null) kept[key] = entry;
  }
  return kept;
};

/**
 * The share form of one value under its rule, or null when it does not pass. The only way a
 * value reaches a share file.
 */
export const shareValue = (
  rule: ShareRule,
  value: unknown,
  names: Pseudonyms,
  context?: { readonly aggregate?: unknown; readonly eventType?: unknown },
): CsvValue | Record<string, unknown> => {
  if (value === null || value === undefined) return null;
  switch (rule.kind) {
    case "enum":
      return typeof value === "string" && rule.values.includes(value) ? value : null;
    case "int":
      return intInRange(value, rule.min, rule.max) ? value : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "bool":
      return typeof value === "boolean" ? value : value === 1 ? true : value === 0 ? false : null;
    case "day":
      return dateInRange(value) ? utcDay(value) : null;
    case "hash":
      return typeof value === "string" && HASH_FORMAT.test(value) ? value : null;
    case "version":
      return typeof value === "string" && VERSION_FORMAT.test(value) ? value : null;
    case "sources": {
      if (typeof value !== "string") return null;
      const kept = value.split(";").filter((source) => CATALOG_SOURCES.has(source));
      return kept.length === 0 ? null : kept.join(";");
    }
    case "thread":
      return typeof value === "string" ? names.thread(value) : null;
    case "trend":
      return typeof value === "string" ? names.trend(value) : null;
    case "run":
      return typeof value === "string" ? names.run(value) : null;
    case "aggregate-id": {
      if (typeof value !== "string") return null;
      switch (context?.aggregate) {
        case "video_thread":
          return names.thread(value);
        case "trend":
          return names.trend(value);
        case "run":
          return names.run(value);
        default:
          return null;
      }
    }
    case "event-data": {
      const type = context?.eventType;
      if (typeof type !== "string" || !Object.hasOwn(SHARE_EVENT_DATA, type)) return "{}";
      const payload = typeof value === "string" ? parseJson(value) : value;
      return stableJson(sharedObject(SHARE_EVENT_DATA[type as EditorialEventType], payload, names));
    }
    case "object": {
      const kept = sharedObject(rule.fields, value, names);
      return Object.keys(kept).length === 0 ? null : kept;
    }
  }
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** JSON with object keys sorted at every level, so equal data gives equal bytes. */
export const stableJson = (value: unknown, indent?: number): string =>
  JSON.stringify(
    value,
    (_key, entry: unknown) =>
      isPlainObject(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .toSorted()
              .map((key) => [key, entry[key]]),
          )
        : entry,
    indent,
  );

const csvCell = (value: CsvValue): string => {
  if (value === null) return "";
  const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
};

/** A projected row: only the columns of `file` for `mode`, each value as it will be written. */
export type ProjectedRow = Readonly<Record<string, CsvValue>>;

/**
 * The one projection of a row: `full` copies the listed columns, `share` passes each through
 * its rule with `shareValue`. CSV files and `resumen.md` both read rows from here, so there is
 * no second way for a stored value to reach a share file. Only the listed columns are read, so
 * a new field on a row never leaks. `datos` holds the raw payload; `share` projects it by `tipo`.
 */
export const projectRow = (
  file: string,
  mode: EditorialEvidenceMode,
  row: CsvRow,
  names: Pseudonyms,
): ProjectedRow =>
  Object.fromEntries(
    columnsOf(file, mode).map((spec) => {
      const value = row[spec.name] ?? null;
      if (mode === "full" || spec.share === null) return [spec.name, value];
      const shared = shareValue(spec.share, value, names, {
        aggregate: row.agregado,
        eventType: row.tipo,
      });
      return [
        spec.name,
        typeof shared === "object" && shared !== null ? stableJson(shared) : shared,
      ];
    }),
  );

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * A share cell. Share holds no free text, but a string that a spreadsheet would read as a
 * formula still gets a leading `'` (defense in depth); numbers stay numbers. `full` is not
 * neutralized: import its CSV as text.
 */
export const shareCsvCell = (value: CsvValue): string =>
  typeof value === "string" && FORMULA_START.test(value) ? csvCell(`'${value}`) : csvCell(value);

/** Renders `rows` of `file` for `mode` from their projection. */
export const renderCsv = (
  file: string,
  mode: EditorialEvidenceMode,
  rows: ReadonlyArray<CsvRow>,
  names: Pseudonyms,
): string => {
  const specs = columnsOf(file, mode);
  const cell = mode === "share" ? shareCsvCell : csvCell;
  const lines = [specs.map((spec) => csvCell(spec.name)).join(",")];
  for (const row of rows) {
    const projected = projectRow(file, mode, row, names);
    lines.push(specs.map((spec) => cell(projected[spec.name] ?? null)).join(","));
  }
  return `${lines.join("\n")}\n`;
};

export const sha256Hex = (content: string) =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

/** Hash of the package: each data file's name and hash, in name order. */
export const packageHashOf = (
  files: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
) =>
  sha256Hex(
    files
      .map((file) => `${file.sha256}  ${file.name}\n`)
      .toSorted()
      .join(""),
  );

/** Fixed formatting, independent of the host locale: `12,5 min`. */
export const formatMinutes = (ms: number | null): string =>
  ms === null ? "sin datos" : `${(ms / 60_000).toFixed(1).replace(".", ",")} min`;

export const formatDecimal = (value: number | null, digits = 2): string =>
  value === null ? "sin datos" : value.toFixed(digits).replace(".", ",");

export const markdownTable = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string => {
  const escape = (cell: string | number) =>
    String(cell).replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${header.map(escape).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
};
