// @effect-diagnostics nodeBuiltinImport:off -- sha256 of each exported file.
import * as NodeCrypto from "node:crypto";

import type { EditorialEvidenceMode } from "@t3tools/contracts";

import type { EditorialEventType } from "./persistence/EditorialModel.ts";

// Pure half of the evidence export: column lists, the share whitelist, pseudonyms, CSV and
// hashing. `EditorialEvidenceExportService.ts` reads the database and writes the files.

export const EVIDENCE_SCHEMA = "earlyscript.evidence/1";
export const MANIFEST_FILE = "manifest.json";
export const SUMMARY_FILE = "resumen.md";

/**
 * How a column is written. `text` is free text the operator typed or a page title or URL: it
 * never leaves in `share`. `thread` and `trend` become stable indices in `share`; `date`
 * becomes its UTC day; `value` is copied as is (enums, numbers, hashes, engine run ids).
 * `aggregate-id` follows the row's `agregado`: a thread or trend id becomes its index, a run id
 * stays. `event-data` holds the payload the service already projected for the mode.
 */
export type ColumnKind =
  | "value"
  | "date"
  | "thread"
  | "trend"
  | "text"
  | "aggregate-id"
  | "event-data";

export interface ColumnSpec {
  readonly name: string;
  readonly kind: ColumnKind;
  /** Whether `share` keeps the column. A `text` column never does. */
  readonly share: boolean;
  readonly description: string;
}

export type CsvValue = string | number | boolean | null;
export type CsvRow = Readonly<Record<string, CsvValue>>;

const column = (
  name: string,
  kind: ColumnKind,
  share: boolean,
  description: string,
): ColumnSpec => ({ name, kind, share: kind === "text" ? false : share, description });

export const DECISIONS_FILE = "decisiones.csv";
export const INTERVALS_FILE = "tiempos.csv";
export const EVENTS_FILE = "eventos.csv";
export const RUNS_FILE = "corridas.csv";
export const CAPTURES_FILE = "capturas.csv";

export const EVIDENCE_COLUMNS: Readonly<Record<string, ReadonlyArray<ColumnSpec>>> = {
  [DECISIONS_FILE]: [
    column("hilo", "thread", true, "Hilo de video; en share, índice estable h001…"),
    column("entorno", "value", false, "Entorno de T3 que registró el hilo."),
    column("modo", "value", true, "assisted o manual."),
    column("tendencia", "trend", true, "Clave de tendencia; en share, índice estable t001…"),
    column("corrida", "value", true, "Corrida del motor de la que salió el hilo asistido."),
    column("expediente", "value", false, "Expediente de la corrida."),
    column("decision", "value", false, "Identificador de la decisión."),
    column("accion", "value", true, "accept, edit o reject."),
    column("utilidad", "value", true, "Utilidad 1 a 5 que registró el operador."),
    column("motivo", "text", false, "Motivo escrito con la decisión."),
    column("vigente", "value", true, "1 si es la última decisión del hilo dentro del filtro."),
    column("reloj_definitivo", "value", true, "0 si un tramo esperaba resolución: los tiempos son un piso."),
    column("cobertura", "value", true, "complete si el hilo registró todas las etapas de su modo."),
    column("explorar_ms", "value", true, "Milisegundos activos en Explorar; vacío si no corrió."),
    column("leer_ms", "value", true, "Milisegundos activos en Leer; vacío si no corrió."),
    column("escribir_ms", "value", true, "Milisegundos activos en Escribir; vacío si no corrió."),
    column("decidir_ms", "value", true, "Milisegundos activos en Decidir; vacío si no corrió."),
    column("total_ms", "value", true, "Suma de las etapas registradas."),
    column("guion_hash", "value", true, "sha256 de la versión del guion decidida."),
    column("afirmaciones", "value", true, "Oraciones del guion decidido (conteo mecánico)."),
    column("con_cita", "value", true, "De ellas, con marcador de cita (no mide respaldo)."),
    column("vistas", "value", true, "Última observación registrada a mano."),
    column("suscriptores", "value", true, "Última observación registrada a mano."),
    column("clics", "value", true, "Última observación registrada a mano."),
    column("comentarios", "value", true, "Última observación registrada a mano."),
    column("metricas_observadas", "date", true, "Fecha de esa observación."),
    column("decidida", "date", true, "Fecha de la decisión."),
  ],
  [INTERVALS_FILE]: [
    column("hilo", "thread", true, "Hilo de video; en share, índice estable."),
    column("modo", "value", true, "assisted o manual."),
    column("tramo", "value", true, "Orden del tramo dentro del hilo, desde 1."),
    column("tramo_id", "value", false, "Identificador del tramo."),
    column("etapa", "value", true, "explore, read, write o decide."),
    column("estado", "value", true, "closed, open o needs_resolution."),
    column("inicio", "date", true, "Inicio del tramo."),
    column("fin", "date", true, "Fin del tramo; vacío si sigue abierto o sin resolver."),
    column("duracion_ms", "value", true, "fin − inicio; vacío si el tramo no está cerrado."),
    column("motivo_fin", "value", true, "paused, stage_changed, stopped, decided o resolved."),
    column("motivo_pausa", "text", false, "Motivo escrito al pausar."),
    column("fin_pausa", "date", true, "Fin de la pausa que siguió al tramo."),
    column("recuperado", "date", true, "Momento en que el servidor marcó el tramo para resolver."),
  ],
  [EVENTS_FILE]: [
    column("seq", "value", true, "Orden del evento en la bitácora."),
    column("tipo", "value", true, "Tipo de evento editorial."),
    column("fecha", "date", true, "Momento del evento."),
    column("agregado", "value", true, "trend, video_thread o run."),
    column("id", "aggregate-id", true, "Tendencia, hilo o corrida; en share, índices para tendencia e hilo."),
    column("actor", "value", true, "operator o system."),
    column("operacion", "value", false, "Identificador de operación idempotente."),
    column("datos", "event-data", true, "Carga del evento en JSON; en share, solo los campos de eventData."),
  ],
  [RUNS_FILE]: [
    column("corrida", "value", true, "Identificador de la corrida del motor."),
    column("corte", "date", true, "Corte de la corrida."),
    column("terminada", "date", true, "Fin de la corrida según el motor."),
    column("estado_motor", "value", true, "Estado que declaró el motor."),
    column("estado_importacion", "value", true, "imported, partial o invalid."),
    column("version_motor", "value", true, "Versión del motor."),
    column("config_hash", "value", true, "Hash de la configuración del motor."),
    column("hash_logico", "value", true, "Hash lógico de la corrida (reproducibilidad)."),
    column("corpus_hash", "value", true, "Hash del corpus usado."),
    column("contenido_hash", "value", true, "sha256 de run.json y de los expedientes leídos."),
    column("perfil_hash", "value", true, "Hash del perfil del canal usado por la corrida nocturna."),
    column("fuentes", "value", true, "Fuentes de la corrida, separadas por punto y coma."),
    column("expedientes", "value", true, "Expedientes indexados (tendencias emitidas)."),
    column("vistas", "value", true, "Tendencias distintas abiertas en esta corrida (trend.read)."),
    column("descartadas", "value", true, "Tendencias de la corrida descartadas en la bandeja actual."),
    column("producidas", "value", true, "Hilos de video registrados desde esta corrida."),
    column("omitidos", "value", true, "Archivos de la corrida que no se pudieron leer."),
    column("omitidos_motivos", "text", false, "Archivo y motivo de cada omitido, en JSON."),
  ],
  [CAPTURES_FILE]: [
    column("hilo", "thread", false, "Hilo de video."),
    column("captura", "value", false, "Identificador de la captura."),
    column("url", "text", false, "Página capturada."),
    column("titulo", "text", false, "Título de la página."),
    column("nota", "text", false, "Nota del operador."),
    column("capturada", "date", false, "Momento de la captura."),
    column("retirada", "date", false, "Momento en que se retiró, si se retiró."),
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
  (EVIDENCE_COLUMNS[file] ?? []).filter((spec) => mode === "full" || spec.share);

/** The share whitelist by file, as the manifest documents it. */
export const shareWhitelist = (): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    EVIDENCE_FILES.share
      .filter((file) => file.endsWith(".csv"))
      .map((file) => [file, columnsOf(file, "share").map((spec) => spec.name)]),
  );

/**
 * What `share` keeps of an event payload, by type. Exhaustive over `EditorialEventType`, so a
 * new event type does not compile until someone decides what of it may leave. Anything not
 * named is dropped; free text (reasons, notes, URLs, titles, paths) is never named.
 */
type PayloadRule = "enum" | "number" | "boolean" | "date" | "thread" | "trend" | "id" | "hash" | "flat";

const SLUG = /^[a-z][a-z0-9_-]{0,39}$/;
const ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const HASH = /^(sha256:)?[0-9a-f]{16,128}$/;

const PURGE_COUNTS = {
  visits: "number",
  captures: "number",
  decisions: "number",
  results: "number",
  workIntervals: "number",
  scriptVersions: "number",
  versionFiles: "number",
  events: "number",
} as const;

const RUN_IMPORT = {
  cutoffAt: "date",
  dossierCount: "number",
  importState: "enum",
  previousImportState: "enum",
  contentHash: "hash",
  previousContentHash: "hash",
  logicalHash: "hash",
  interpretationVersion: "number",
  previousInterpretationVersion: "number",
} as const;

export const SHARE_EVENT_DATA: Readonly<
  Record<EditorialEventType, Readonly<Record<string, PayloadRule>>>
> = {
  "trend.read": { runId: "id", runCutoffAt: "date" },
  "trend.snoozed": { until: "date", returnWhen: "flat" },
  "trend.unsnoozed": { cause: "enum", observed: "flat" },
  "trend.dismissed": {},
  "trend.reopened": {},
  "trend.production-linked": { threadId: "thread", previousThreadId: "thread" },
  "video-thread.registered": { mode: "enum", trendKey: "trend", runId: "id" },
  "video-thread.launched": { previous: "enum" },
  "video-thread.launch-failed": { previous: "enum" },
  "video-thread.purged": { mode: "enum", ...PURGE_COUNTS },
  "video-thread.t3-deleted": {},
  "work.started": { stage: "enum" },
  "work.paused": { stage: "enum" },
  "work.resumed": { stage: "enum" },
  "work.stage-changed": { from: "enum", to: "enum", fromState: "enum" },
  "work.stopped": { stage: "enum", reason: "enum", from: "enum" },
  "work.recovery-needed": { stage: "enum", startedAt: "date" },
  "work.resolved": { endedAt: "date" },
  "decision.recorded": {
    action: "enum",
    utility: "number",
    scriptVersionHash: "hash",
    clockDefinitive: "boolean",
  },
  "script.version-saved": { contentHash: "hash", bytes: "number" },
  "script.head-restored": { contentHash: "hash" },
  "capture.saved": {},
  "capture.removed": {},
  "browser.visited": { origin: "enum", titleOnly: "boolean" },
  "result.saved": {
    views: "number",
    subscribers: "number",
    clicks: "number",
    comments: "number",
    observedAt: "date",
  },
  "run.imported": RUN_IMPORT,
  "run.updated": RUN_IMPORT,
  "run.invalidated": { previousImportState: "enum", contentHash: "hash" },
};

/** Field lists of `SHARE_EVENT_DATA`, for the manifest. */
export const shareEventDataWhitelist = (): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    Object.entries(SHARE_EVENT_DATA)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([type, fields]) => [type, Object.keys(fields).toSorted()]),
  );

/** Stable pseudonyms: `h001` for threads and `t001` for trends, in first-seen order. */
export interface Pseudonyms {
  readonly thread: (threadId: string | null) => string | null;
  readonly trend: (trendKey: string | null) => string | null;
}

export const makePseudonyms = (
  threadIds: ReadonlyArray<string>,
  trendKeys: ReadonlyArray<string>,
): Pseudonyms => {
  const index = (prefix: string, ids: ReadonlyArray<string>) => {
    const width = Math.max(3, String(ids.length).length);
    const map = new Map<string, string>();
    for (const id of ids) {
      if (!map.has(id)) map.set(id, `${prefix}${String(map.size + 1).padStart(width, "0")}`);
    }
    // An id outside the universe (should not happen) still never leaves as is.
    return (id: string | null) => (id === null ? null : (map.get(id) ?? `${prefix}?`));
  };
  return { thread: index("h", threadIds), trend: index("t", trendKeys) };
};

/** The UTC day of an ISO date-time, or null when it does not parse. */
export const utcDay = (value: string | null): string | null => {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const applyRule = (rule: PayloadRule, value: unknown, names: Pseudonyms): CsvValue | object => {
  if (value === null || value === undefined) return null;
  switch (rule) {
    case "enum":
      return typeof value === "string" && SLUG.test(value) ? value : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "boolean":
      return typeof value === "boolean" ? value : null;
    case "date":
      return typeof value === "string" ? utcDay(value) : null;
    case "thread":
      return typeof value === "string" ? names.thread(value) : null;
    case "trend":
      return typeof value === "string" ? names.trend(value) : null;
    case "id":
      return typeof value === "string" && ENGINE_ID.test(value) ? value : null;
    case "hash":
      return typeof value === "string" && HASH.test(value) ? value : null;
    case "flat": {
      // A small condition object: only slugs and finite numbers survive.
      if (!isPlainObject(value)) return null;
      const kept: Record<string, CsvValue> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "number" && Number.isFinite(entry)) kept[key] = entry;
        else if (typeof entry === "string" && SLUG.test(entry)) kept[key] = entry;
      }
      return kept;
    }
  }
};

/** The share projection of an event payload: only whitelisted fields, each checked. */
export const shareEventData = (
  type: EditorialEventType,
  payload: unknown,
  names: Pseudonyms,
): Readonly<Record<string, unknown>> => {
  const rules = SHARE_EVENT_DATA[type] ?? {};
  if (!isPlainObject(payload)) return {};
  const kept: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (!(key in payload)) continue;
    const value = applyRule(rule, payload[key], names);
    if (value !== null) kept[key] = value;
  }
  return kept;
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

/**
 * Renders `rows` with the columns of `file` for `mode`, transforming each value by its kind.
 * Only the listed columns are read from a row, so a new field on a row never leaks.
 */
export const renderCsv = (
  file: string,
  mode: EditorialEvidenceMode,
  rows: ReadonlyArray<CsvRow>,
  names: Pseudonyms,
): string => {
  const specs = columnsOf(file, mode);
  const lines = [specs.map((spec) => csvCell(spec.name)).join(",")];
  for (const row of rows) {
    lines.push(
      specs
        .map((spec) => {
          const value = row[spec.name] ?? null;
          if (mode === "full" || value === null) return csvCell(value);
          switch (spec.kind) {
            case "date":
              return csvCell(utcDay(String(value)));
            case "thread":
              return csvCell(names.thread(String(value)));
            case "trend":
              return csvCell(names.trend(String(value)));
            case "aggregate-id":
              return csvCell(
                row.agregado === "video_thread"
                  ? names.thread(String(value))
                  : row.agregado === "trend"
                    ? names.trend(String(value))
                    : value,
              );
            case "text":
              return "";
            case "value":
            case "event-data":
              return csvCell(value);
          }
        })
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
};

export const sha256Hex = (content: string) =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

/** Hash of the package: each data file's name and hash, in name order. */
export const packageHashOf = (files: ReadonlyArray<{ readonly name: string; readonly sha256: string }>) =>
  sha256Hex(
    files
      .map((file) => `${file.sha256}  ${file.name}\n`)
      .toSorted()
      .join(""),
  );

/** Fixed formatting, independent of the host locale: `12,5 min`. */
export const formatMinutes = (ms: number | null): string =>
  ms === null ? "—" : `${(ms / 60_000).toFixed(1).replace(".", ",")} min`;

export const formatDecimal = (value: number | null, digits = 2): string =>
  value === null ? "—" : value.toFixed(digits).replace(".", ",");

export const markdownTable = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string => {
  const escape = (cell: string | number) => String(cell).replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${header.map(escape).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
};
