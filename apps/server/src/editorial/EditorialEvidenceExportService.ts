// @effect-diagnostics nodeBuiltinImport:off -- `git rev-parse` names the fork's commit when no build SHA is set; lstat and realpath guard the destination against links.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { SOURCE_CATALOG } from "@earlyscript/editorial-contracts/sourceCatalog";
import {
  EditorialEvidenceExportError,
  type EditorialEvidenceExportInput,
  type EditorialEvidenceMode,
  type EditorialResultsDecision,
  type EditorialResultsMode,
  type EditorialSourceEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { findT3CodeDirectoryFor } from "../earlyscript/dataDirectory.ts";
import * as EditorialResultsService from "./EditorialResultsService.ts";
import { COUNT_MAX, decisionInDomain } from "./decisionDomain.ts";
import * as EditorialSourcesService from "./EditorialSourcesService.ts";
import {
  ALL_EVIDENCE_FILES,
  CAPTURES_FILE,
  DECISIONS_FILE,
  EVENTS_FILE,
  EVIDENCE_FILES,
  EVIDENCE_SCHEMA,
  INTERVALS_FILE,
  MANIFEST_FILE,
  RUNS_FILE,
  SUMMARY_FILE,
  columnsOf,
  formatDecimal,
  formatMinutes,
  makePseudonyms,
  markdownTable,
  packageHashOf,
  renderCsv,
  sha256Hex,
  describeRule,
  shareEventDataWhitelist,
  shareValue,
  shareWhitelist,
  stableJson,
  utcDay,
  projectRow,
  type CsvRow,
  type CsvValue,
  type ProjectedRow,
} from "./evidenceFormat.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import type { EditorialEventType } from "./persistence/EditorialModel.ts";

export interface EvidenceFile {
  readonly name: string;
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Data rows of a CSV; null for the summary. */
  readonly rows: number | null;
}

export interface EvidencePackage {
  readonly mode: EditorialEvidenceMode;
  /** Folder name: `earlyscript-evidencia-<completa|compartir>-<day>`. */
  readonly packageName: string;
  readonly packageHash: string;
  /** Data files in manifest order; equal state gives equal bytes. */
  readonly files: ReadonlyArray<EvidenceFile>;
  /** `manifest.json`, which also carries the export day and the fork's commit. */
  readonly manifest: string;
}

export type EvidenceExportOptions = Pick<EditorialEvidenceExportInput, "mode" | "since" | "until">;

export interface EditorialEvidenceExportServiceShape {
  readonly build: (
    options: EvidenceExportOptions,
  ) => Effect.Effect<EvidencePackage, EditorialEvidenceExportError>;
  /**
   * Writes the package into `directory`, creating it. A non-empty folder must hold an earlier
   * evidence package; its files are replaced and nothing else is touched.
   */
  readonly write: (
    pkg: EvidencePackage,
    directory: string,
    options?: {
      /**
       * Folder the real path of the destination must stay under, every ancestor resolved. The
       * RPC passes the user's home; the CLI passes nothing and may write anywhere.
       */
      readonly within?: string;
    },
  ) => Effect.Effect<string, EditorialEvidenceExportError>;
}

/** Reproducible evidence package over `editorial.sqlite`, for the thesis report and reviewers. */
export class EditorialEvidenceExportService extends Context.Service<
  EditorialEvidenceExportService,
  EditorialEvidenceExportServiceShape
>()("t3/editorial/EditorialEvidenceExportService") {}

const BUILD_SHA_ENV = "EARLYSCRIPT_BUILD_SHA";

/** The fork's commit: the build's, or the checkout's when running from source; else null. */
const resolveForkSha = (): string | null => {
  const fromEnv = process.env[BUILD_SHA_ENV]?.trim();
  // The build may set it; only a commit hash leaves, never other text.
  if (fromEnv) return /^[0-9a-f]{7,40}$/.test(fromEnv) ? fromEnv : null;
  try {
    const cwd = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
    const sha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
};

const invalidFilter = (message: string) =>
  new EditorialEvidenceExportError({ reason: "invalid-filter", message });

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DateWindow {
  readonly sinceMs: number | null;
  /** Exclusive. */
  readonly untilMs: number | null;
}

/** `YYYY-MM-DD` is a whole UTC day, inclusive at both ends; a date-time is an instant. */
const parseDateWindow = Effect.fn("EditorialEvidenceExportService.parseDateWindow")(function* (
  since: string | undefined,
  until: string | undefined,
) {
  const parse = (value: string, edge: "since" | "until") => {
    const day = DAY.test(value);
    const ms = Date.parse(day ? `${value}T00:00:00.000Z` : value);
    if (Number.isNaN(ms)) return null;
    if (edge === "since") return ms;
    return day ? ms + DAY_MS : ms + 1;
  };
  const sinceMs = since === undefined ? null : parse(since, "since");
  const untilMs = until === undefined ? null : parse(until, "until");
  if (since !== undefined && sinceMs === null) {
    return yield* invalidFilter(`--since is not a date: ${since}`);
  }
  if (until !== undefined && untilMs === null) {
    return yield* invalidFilter(`--until is not a date: ${until}`);
  }
  if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) {
    return yield* invalidFilter("--since must come before --until.");
  }
  return { sinceMs, untilMs } satisfies DateWindow;
});

/** Whether an ISO date-time falls in the window; a missing date only passes an open window. */
const inWindow = (window: DateWindow, value: string | null): boolean => {
  if (window.sinceMs === null && window.untilMs === null) return true;
  if (value === null) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  return (
    (window.sinceMs === null || ms >= window.sinceMs) &&
    (window.untilMs === null || ms < window.untilMs)
  );
};

interface ThreadRow {
  readonly thread_id: string;
  readonly mode: EditorialResultsMode;
}

interface IntervalRow {
  readonly interval_id: string;
  readonly thread_id: string;
  readonly mode: EditorialResultsMode;
  readonly stage: string;
  readonly status: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly end_reason: string | null;
  readonly pause_reason: string | null;
  readonly pause_ended_at: string | null;
  readonly recovered_at: string | null;
}

interface EventRow {
  readonly seq: number;
  readonly type: EditorialEventType;
  readonly aggregate_kind: string;
  readonly aggregate_id: string;
  readonly operation_id: string | null;
  readonly actor: string;
  readonly payload_json: string;
  readonly created_at: string;
}

interface RunRow {
  readonly run_id: string;
  readonly cutoff_at: string | null;
  readonly finished_at: string | null;
  readonly engine_status: string;
  readonly import_state: string;
  readonly engine_version: string | null;
  readonly config_hash: string | null;
  readonly logical_hash: string | null;
  readonly corpus_hash: string | null;
  readonly content_hash: string | null;
  readonly profile_hash: string | null;
  readonly sources_json: string;
  readonly dossier_count: number;
  readonly skipped_files_json: string;
  readonly seen: number;
  readonly dismissed: number;
  readonly produced: number;
}

interface CaptureRow {
  readonly capture_id: string;
  readonly thread_id: string;
  readonly url: string;
  readonly title: string | null;
  readonly note: string | null;
  readonly captured_at: string;
  readonly removed_at: string | null;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const stringList = (text: string): ReadonlyArray<string> => {
  const parsed = parseJson(text);
  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
};

const MODE_LABEL: Readonly<Record<EditorialResultsMode, string>> = {
  assisted: "Asistido",
  manual: "Manual",
};
const STAGE_LABEL: Readonly<Record<string, string>> = {
  explore: "Explorar",
  read: "Leer",
  write: "Escribir",
  decide: "Decidir",
};
const COMPARISON_LABEL: Readonly<Record<string, string>> = {
  explore: "Explorar (asistido: explorar + leer)",
  write: "Escribir",
  total: "Proceso completo (solo cobertura completa)",
  recorded: "Total de etapas registradas (incluye parciales)",
};

const decisionRow = (decision: EditorialResultsDecision, current: boolean): CsvRow => ({
  hilo: decision.threadId,
  entorno: decision.environmentId,
  modo: decision.mode,
  tendencia: decision.trendKey,
  corrida: decision.runId,
  expediente: decision.dossierId,
  decision: decision.decisionId,
  accion: decision.action,
  utilidad: decision.utility,
  motivo: decision.reason,
  vigente: current,
  reloj_definitivo: decision.clockDefinitive,
  cobertura: decision.coverage,
  explorar_ms: decision.durations.exploreMs,
  leer_ms: decision.durations.readMs,
  escribir_ms: decision.durations.writeMs,
  decidir_ms: decision.durations.decideMs,
  total_ms: decision.durations.totalMs,
  guion_hash: decision.script?.versionHash ?? null,
  afirmaciones: decision.script?.claims ?? null,
  con_cita: decision.script?.cited ?? null,
  vistas: decision.video?.views ?? null,
  suscriptores: decision.video?.subscribers ?? null,
  clics: decision.video?.clicks ?? null,
  comentarios: decision.video?.comments ?? null,
  metricas_observadas: decision.video?.observedAt ?? null,
  decidida: decision.decidedAt,
});

const numberOrNull = (value: CsvValue): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const RESULTS_MODES: ReadonlySet<CsvValue> = new Set(["assisted", "manual"]);
const RESULTS_ACTIONS: ReadonlySet<CsvValue> = new Set(["accept", "edit", "reject"]);

/**
 * A decision rebuilt from its projected `decisiones.csv` row, for the summary's aggregates. A
 * row whose mode, action or utility did not pass its rule is left out of them.
 */
const decisionFromRow = (row: ProjectedRow): EditorialResultsDecision | null => {
  const utility = numberOrNull(row.utilidad ?? null);
  if (!RESULTS_MODES.has(row.modo ?? null) || !RESULTS_ACTIONS.has(row.accion ?? null)) {
    return null;
  }
  if (utility === null) return null;
  const mode = row.modo as EditorialResultsMode;
  const durations = {
    exploreMs: numberOrNull(row.explorar_ms ?? null),
    readMs: numberOrNull(row.leer_ms ?? null),
    writeMs: numberOrNull(row.escribir_ms ?? null),
    decideMs: numberOrNull(row.decidir_ms ?? null),
    totalMs: numberOrNull(row.total_ms ?? null),
  };
  const stages = (
    [
      ["explore", durations.exploreMs],
      ["read", durations.readMs],
      ["write", durations.writeMs],
      ["decide", durations.decideMs],
    ] as const
  ).flatMap(([stage, ms]) => (ms === null ? [] : [stage]));
  const claims = numberOrNull(row.afirmaciones ?? null);
  const cited = numberOrNull(row.con_cita ?? null);
  const metrics = {
    views: numberOrNull(row.vistas ?? null),
    subscribers: numberOrNull(row.suscriptores ?? null),
    clicks: numberOrNull(row.clics ?? null),
    comments: numberOrNull(row.comentarios ?? null),
  };
  const observedAt = typeof row.metricas_observadas === "string" ? row.metricas_observadas : null;
  return {
    decisionId: "",
    threadId: String(row.hilo ?? ""),
    environmentId: "",
    mode,
    trendKey: null,
    runId: null,
    dossierId: null,
    action: row.accion as EditorialResultsDecision["action"],
    utility,
    reason: null,
    decidedAt: "",
    current: row.vigente === true,
    clockDefinitive: row.reloj_definitivo === true,
    stages,
    coverage: EditorialResultsService.coverageOf(mode, stages),
    durations,
    script:
      claims === null || cited === null
        ? null
        : { versionHash: String(row.guion_hash ?? ""), claims, cited },
    video: observedAt === null ? null : { ...metrics, observedAt },
  };
};

/**
 * Everything `resumen.md` shows, already projected: decisions and runs are the rows of
 * `decisiones.csv` and `corridas.csv` after `projectRow`, the sequence passed its rule. The
 * summary has no way of its own to read a stored value.
 */
interface SummaryInput {
  readonly mode: EditorialEvidenceMode;
  readonly since: string | null;
  readonly until: string | null;
  readonly lastEventSeq: number | null;
  readonly decisionRows: ReadonlyArray<ProjectedRow>;
  /** Current decisions left out because a stored value is out of its domain. */
  readonly excludedByDomain: number;
  readonly runRows: ReadonlyArray<ProjectedRow>;
  readonly sources: ReadonlyArray<EditorialSourceEntry>;
  readonly fileRows: ReadonlyArray<{ readonly name: string; readonly rows: number }>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Closed formats only: the backtest table is stored text, so each part is checked. */
const backtestSummary = (backtest: NonNullable<EditorialSourceEntry["backtest"]>): string => {
  const verdict =
    backtest.verdict === "not-worse" || backtest.verdict === "worse" ? backtest.verdict : "?";
  const status =
    backtest.status === "final" || backtest.status === "provisional" ? backtest.status : "?";
  const day = (value: string) => (DAY_PATTERN.test(value) ? value : "?");
  const number = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? formatDecimal(value) : "sin datos";
  return `${verdict}, ${status}, ${day(backtest.cutoffFrom)} a ${day(backtest.cutoffTo)}, P@5 ${number(backtest.p5Candidate)} frente a ${number(backtest.p5Baseline)}`;
};

/**
 * The filter as the package states it. `share` rounds an instant to its day (the rows were
 * filtered with the instant as given); `full` keeps it.
 */
const filterBound = (mode: EditorialEvidenceMode, value: string | null): string | null => {
  if (value === null) return null;
  if (DAY_PATTERN.test(value) || mode === "full") return value;
  return utcDay(value);
};

const filterText = (
  mode: EditorialEvidenceMode,
  since: string | null,
  until: string | null,
): string => {
  if (since === null && until === null) return "sin filtro de fechas";
  const bound = (value: string | null, edge: "desde" | "hasta") => {
    if (value === null) return edge === "desde" ? "desde el inicio" : "hasta el final";
    if (DAY_PATTERN.test(value)) return `${edge} el día ${value}`;
    return mode === "full"
      ? `${edge} el instante ${value}`
      : `${edge} un instante del día ${utcDay(value) ?? "?"} (redondeado al día en este paquete)`;
  };
  return `${bound(since, "desde")} ${bound(until, "hasta")} (UTC; los días son inclusivos)`;
};

/** `resumen.md`: aggregates only, no free text and no export timestamp. */
const renderSummary = (input: SummaryInput): string => {
  const rebuilt = input.decisionRows.map(decisionFromRow);
  const summarized = EditorialResultsService.summarizeDecisions(
    rebuilt.flatMap((decision) => decision ?? []),
  );
  const { modes, comparisons } = summarized;
  // Rows that passed the stored check but not their share rule are out of domain too.
  const excludedByDomain =
    input.excludedByDomain +
    summarized.excludedByDomain +
    input.decisionRows.filter((row, index) => rebuilt[index] === null && row.vigente === true)
      .length;
  const filter = filterText(input.mode, input.since, input.until);
  const stageRows = modes.flatMap((mode) => [
    ...mode.stages.map((entry) => [
      MODE_LABEL[mode.mode],
      STAGE_LABEL[entry.stage] ?? entry.stage,
      entry.stats.n,
      formatMinutes(entry.stats.medianMs),
      formatMinutes(entry.stats.q1Ms),
      formatMinutes(entry.stats.q3Ms),
      formatMinutes(
        entry.stats.q1Ms === null || entry.stats.q3Ms === null
          ? null
          : entry.stats.q3Ms - entry.stats.q1Ms,
      ),
    ]),
    [
      MODE_LABEL[mode.mode],
      "Total registrado",
      mode.total.n,
      formatMinutes(mode.total.medianMs),
      formatMinutes(mode.total.q1Ms),
      formatMinutes(mode.total.q3Ms),
      formatMinutes(
        mode.total.q1Ms === null || mode.total.q3Ms === null
          ? null
          : mode.total.q3Ms - mode.total.q1Ms,
      ),
    ],
  ]);
  const comparisonRows = comparisons.map((entry) => [
    COMPARISON_LABEL[entry.key] ?? entry.key,
    `${formatMinutes(entry.assisted.medianMs)} (n = ${entry.assisted.n})`,
    `${formatMinutes(entry.manual.medianMs)} (n = ${entry.manual.n})`,
    `${entry.partial.assisted} / ${entry.partial.manual}`,
  ]);
  const utilityRows = modes.map((mode) => [
    MODE_LABEL[mode.mode],
    mode.threads,
    mode.utility.n,
    formatDecimal(mode.utility.mean),
    ...mode.utility.distribution,
    mode.actions.accept,
    mode.actions.edit,
    mode.actions.reject,
    mode.provisionalClock,
    mode.partialCoverage,
  ]);
  const citationRows = modes.map((mode) => [
    MODE_LABEL[mode.mode],
    mode.citations.threads,
    mode.citations.claims,
    mode.citations.cited,
    mode.citations.ratio === null ? "sin datos" : formatDecimal(mode.citations.ratio),
  ]);
  const cell = (value: CsvValue | undefined): string | number =>
    typeof value === "string" || typeof value === "number" ? value : "";
  const runRows = input.runRows.map((run) => [
    cell(run.corrida),
    utcDay(typeof run.corte === "string" ? run.corte : null) ?? "sin corte",
    cell(run.estado_importacion),
    cell(run.expedientes),
    cell(run.vistas),
    cell(run.descartadas),
    cell(run.producidas),
  ]);
  const yesNo = (value: boolean) => (value ? "sí" : "no");
  // Only catalog sources: their names are constants of this build.
  const sourceRows = input.sources
    .filter((entry) => Object.hasOwn(SOURCE_CATALOG, entry.source))
    .map((entry) => {
      const backtest = entry.backtest;
      const backtestText =
        backtest === null
          ? entry.backtestRunId === null
            ? "ninguno"
            : "registrado (sin resumen)"
          : backtestSummary(backtest);
      const catalog = SOURCE_CATALOG[entry.source as keyof typeof SOURCE_CATALOG];
      return [catalog.name, yesNo(entry.collect), yesNo(entry.rank), backtestText];
    });
  return [
    "# Evidencia de Earlyscript",
    "",
    `Esquema \`${EVIDENCE_SCHEMA}\`, paquete ${input.mode === "full" ? "completo (uso local)" : "para compartir"}. Estado de la base hasta el evento ${input.lastEventSeq ?? "?"}. Filtro: ${filter}. Filas excluidas por dominio: ${excludedByDomain}.`,
    "",
    "Estas cifras son descriptivas: hilos y temas distintos en cada modo, valorados por el operador. La comparación de la tesis es por pares, sobre el mismo tema y con revisores externos. Ningún porcentaje de ahorro se calcula aquí.",
    "",
    "## Tiempos por modo y etapa",
    "",
    "Decisión vigente de cada hilo dentro del filtro. Los hilos con un tramo sin resolver quedan fuera de los tiempos. Una etapa que no corrió no aporta un cero. Cuartiles por interpolación lineal (tipo 7 de R); RIC = Q3 − Q1.",
    "",
    markdownTable(["Modo", "Etapa", "n", "Mediana", "Q1", "Q3", "RIC"], stageRows),
    "",
    "## Comparaciones",
    "",
    markdownTable(["Comparación", "Asistido", "Manual", "Parciales (A / M)"], comparisonRows),
    "",
    "## Utilidad y acciones",
    "",
    "Utilidad 1 a 5 que registró el operador con la decisión. Las valoraciones de revisores externos no están en esta base.",
    "",
    markdownTable(
      [
        "Modo",
        "Hilos",
        "n",
        "Media",
        "1",
        "2",
        "3",
        "4",
        "5",
        "accept",
        "edit",
        "reject",
        "Reloj provisional",
        "Cobertura parcial",
      ],
      utilityRows,
    ),
    "",
    "## Afirmaciones con cita",
    "",
    "Conteo mecánico de oraciones con marcador de cita en el guion decidido; no mide respaldo semántico.",
    "",
    markdownTable(
      ["Modo", "Hilos con guion", "Afirmaciones", "Con cita", "Proporción"],
      citationRows,
    ),
    "",
    "## Tendencias por corrida",
    "",
    "Emitidas: expedientes indexados. Vistas: tendencias abiertas en esa corrida. Descartadas: tendencias de la corrida descartadas en la bandeja actual. Producidas: hilos de video creados desde la corrida.",
    "",
    runRows.length === 0
      ? "Ninguna corrida en el filtro."
      : markdownTable(
          ["Corrida", "Corte", "Importación", "Emitidas", "Vistas", "Descartadas", "Producidas"],
          runRows,
        ),
    "",
    "## Fuentes",
    "",
    "Estado actual de cada fuente del catálogo: captura, entrada al motor y backtest registrado.",
    "",
    markdownTable(["Fuente", "Captura", "Motor", "Backtest"], sourceRows),
    "",
    "## Archivos",
    "",
    markdownTable(
      ["Archivo", "Filas"],
      input.fileRows.map((file) => [file.name, file.rows]),
    ),
    "",
  ].join("\n");
};

const SHARE_RULES = [
  "Solo las columnas listadas en `columns`; cualquier otra columna queda fuera aunque la base la tenga.",
  "Sin texto libre: ni motivos de decisión, descarte o pausa, ni notas, ni resultados escritos a mano.",
  "Sin URL ni títulos de capturas o páginas visitadas, sin rutas de archivos y sin guiones (solo su sha256).",
  "Hilos como h001…, tendencias como t001… y corridas como r001…, por orden de aparición en la base; los hashes de cada corrida se conservan si son sha256 válidos y permiten reproducirla.",
  "Cada valor pasa por la regla de su columna (`columns[].rule`) o de su campo (`eventData`): enumeraciones cerradas, enteros, días, sha256 de 64 hexadecimales, versión x.y.z o engine.vX.Y e ids del catálogo de fuentes. Un valor que no cumple su regla queda vacío.",
  "Fechas redondeadas al día UTC, también las de los filtros (`filters`); las filas se filtraron con el instante pedido.",
  "Sin identificadores de entorno, operación ni sesión, y sin datos crudos de fuentes.",
  "Una celda de texto que empiece por =, +, - o @ lleva delante una comilla simple (') para que una hoja de cálculo no la lea como fórmula; en share no debería haber ninguna.",
];

const FULL_RULES = [
  "Paquete local para el operador: incluye texto libre (motivos, notas de captura, URL, títulos) y la carga íntegra de cada evento.",
  "No incluye la sesión de cada evento ni el texto de los guiones (solo su sha256). Nada está saneado: la carga de cada evento y el texto libre se copian tal cual.",
  "Las celdas no se neutralizan: un texto que empiece por =, +, - o @ es una fórmula para una hoja de cálculo. Al abrirlo, importar sus CSV como texto.",
  "No publicar ni subir a repositorios; para el informe y los revisores, exportar con --share.",
];

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const results = yield* EditorialResultsService.EditorialResultsService;
  const sources = yield* EditorialSourcesService.EditorialSourcesService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const forkSha = resolveForkSha();

  const unreadable = (cause: unknown) =>
    Effect.logWarning("editorial evidence: reading the database failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new EditorialEvidenceExportError({
            reason: "unreadable",
            message: "The editorial database could not be read.",
          }),
        ),
      ),
    );

  /** Every thread, trend and run the base has seen, in first-seen order, filters aside. */
  const readPseudonyms = Effect.gen(function* () {
    const threads = yield* sql<{ readonly id: string }>`
      SELECT id FROM (
        SELECT thread_id AS id, 0 AS bucket, created_at AS at, 0 AS seq
        FROM editorial_video_threads
        UNION ALL
        SELECT aggregate_id, 1, NULL, MIN(seq) FROM editorial_events
        WHERE aggregate_kind = 'video_thread'
        GROUP BY aggregate_id
        UNION ALL
        SELECT CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END, 1, NULL, MIN(seq) FROM editorial_events
        WHERE type = 'trend.production-linked'
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END IS NOT NULL
        GROUP BY 1
        UNION ALL
        SELECT production_thread_id, 1, NULL, 9007199254740991 FROM editorial_trend_inbox
        WHERE production_thread_id IS NOT NULL
      )
      GROUP BY id
      ORDER BY MIN(bucket), MIN(at), MIN(seq), id
    `;
    const trends = yield* sql<{ readonly trend_key: string }>`
      SELECT trend_key FROM (
        SELECT d.trend_key AS trend_key, r.cutoff_at AS at
        FROM editorial_dossiers d JOIN editorial_runs r ON r.run_id = d.run_id
        UNION ALL SELECT trend_key, created_at FROM editorial_trend_inbox
        UNION ALL SELECT trend_key, created_at FROM editorial_video_threads
          WHERE trend_key IS NOT NULL
        UNION ALL SELECT aggregate_id, created_at FROM editorial_events
          WHERE aggregate_kind = 'trend'
      )
      GROUP BY trend_key
      ORDER BY MIN(at), trend_key
    `;
    const runs = yield* sql<{ readonly id: string }>`
      SELECT id FROM (
        SELECT run_id AS id, 0 AS bucket, cutoff_at AS at, 0 AS seq FROM editorial_runs
        UNION ALL
        SELECT aggregate_id, 1, NULL, MIN(seq) FROM editorial_events
        WHERE aggregate_kind = 'run' GROUP BY aggregate_id
        UNION ALL
        SELECT CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.runId') END, 1, NULL, MIN(seq) FROM editorial_events
        WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.runId') END IS NOT NULL GROUP BY 1
        UNION ALL
        SELECT CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.observed.runId') END, 1, NULL, MIN(seq)
        FROM editorial_events
        WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.observed.runId') END IS NOT NULL GROUP BY 1
        UNION ALL
        SELECT run_id, 1, NULL, 9007199254740991 FROM editorial_video_threads
        WHERE run_id IS NOT NULL
      )
      WHERE typeof(id) = 'text'
      GROUP BY id
      ORDER BY MIN(bucket), MIN(at), MIN(seq), id
    `;
    return makePseudonyms({
      threads: threads.map((row) => row.id),
      trends: trends.map((row) => row.trend_key),
      runs: runs.map((row) => row.id),
    });
  });

  const intervalRows = Effect.fn("EditorialEvidenceExportService.intervalRows")(function* (
    window: DateWindow,
  ) {
    const order = yield* sql<ThreadRow>`
        SELECT thread_id, mode FROM editorial_video_threads ORDER BY created_at, thread_id
      `;
    const rows = yield* sql<IntervalRow>`
        SELECT
          i.interval_id, i.thread_id, t.mode, i.stage, i.status, i.started_at, i.ended_at,
          i.end_reason, i.pause_reason, i.pause_ended_at, i.recovered_at
        FROM editorial_work_intervals i
        JOIN editorial_video_threads t ON t.thread_id = i.thread_id
        ORDER BY i.started_at, i.rowid
      `;
    const position = new Map(order.map((thread, index) => [thread.thread_id, index]));
    const ordinal = new Map<string, number>();
    return rows
      .map((row) => {
        const next = (ordinal.get(row.thread_id) ?? 0) + 1;
        ordinal.set(row.thread_id, next);
        return { row, tramo: next };
      })
      .filter(({ row }) => inWindow(window, row.started_at))
      .toSorted(
        (a, b) =>
          (position.get(a.row.thread_id) ?? 0) - (position.get(b.row.thread_id) ?? 0) ||
          a.tramo - b.tramo,
      )
      .map(({ row, tramo }): CsvRow => ({
        hilo: row.thread_id,
        modo: row.mode,
        tramo,
        tramo_id: row.interval_id,
        etapa: row.stage,
        estado: row.status,
        inicio: row.started_at,
        fin: row.ended_at,
        duracion_ms:
          row.status === "closed" && row.ended_at !== null
            ? Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at))
            : null,
        motivo_fin: row.end_reason,
        motivo_pausa: row.pause_reason,
        fin_pausa: row.pause_ended_at,
        recuperado: row.recovered_at,
      }));
  });

  // `datos` is the raw payload; `renderCsv` projects it for share by `tipo`.
  const eventRows = (window: DateWindow) =>
    sql<EventRow>`
      SELECT seq, type, aggregate_kind, aggregate_id, operation_id, actor, payload_json, created_at
      FROM editorial_events ORDER BY seq
    `.pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => inWindow(window, row.created_at))
          .map((row): CsvRow => {
            const payload = parseJson(row.payload_json);
            return {
              seq: row.seq,
              tipo: row.type,
              fecha: row.created_at,
              agregado: row.aggregate_kind,
              id: row.aggregate_id,
              actor: row.actor,
              operacion: row.operation_id,
              datos: stableJson(payload),
            };
          }),
      ),
    );

  const readRuns = (window: DateWindow) =>
    sql<RunRow>`
      SELECT
        r.run_id, r.cutoff_at, r.finished_at, r.engine_status, r.import_state, r.engine_version,
        r.config_hash, r.logical_hash, r.corpus_hash, r.content_hash, r.profile_hash,
        r.sources_json, r.dossier_count, r.skipped_files_json,
        (
          SELECT COUNT(DISTINCT e.aggregate_id) FROM editorial_events e
          WHERE e.type = 'trend.read' AND CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.runId') END = r.run_id
        ) AS seen,
        (
          SELECT COUNT(DISTINCT d.trend_key) FROM editorial_dossiers d
          JOIN editorial_trend_inbox i ON i.trend_key = d.trend_key
          WHERE d.run_id = r.run_id AND i.dismissed_at IS NOT NULL
        ) AS dismissed,
        (SELECT COUNT(*) FROM editorial_video_threads t WHERE t.run_id = r.run_id) AS produced
      FROM editorial_runs r
      ORDER BY r.cutoff_at, r.run_id
    `.pipe(Effect.map((rows) => rows.filter((row) => inWindow(window, row.cutoff_at))));

  const runRow = (run: RunRow): CsvRow => {
    const skipped = parseJson(run.skipped_files_json);
    return {
      corrida: run.run_id,
      corte: run.cutoff_at,
      terminada: run.finished_at,
      estado_motor: run.engine_status,
      estado_importacion: run.import_state,
      version_motor: run.engine_version,
      config_hash: run.config_hash,
      hash_logico: run.logical_hash,
      corpus_hash: run.corpus_hash,
      contenido_hash: run.content_hash,
      perfil_hash: run.profile_hash,
      fuentes: stringList(run.sources_json).join(";"),
      expedientes: run.dossier_count,
      vistas: run.seen,
      descartadas: run.dismissed,
      producidas: run.produced,
      omitidos: Array.isArray(skipped) ? skipped.length : 0,
      omitidos_motivos: stableJson(skipped ?? []),
    };
  };

  const captureRows = (window: DateWindow) =>
    sql<CaptureRow>`
      SELECT capture_id, thread_id, url, title, note, captured_at, removed_at
      FROM editorial_captures ORDER BY captured_at, capture_id
    `.pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => inWindow(window, row.captured_at))
          .map((row): CsvRow => ({
            hilo: row.thread_id,
            captura: row.capture_id,
            url: row.url,
            titulo: row.title,
            nota: row.note,
            capturada: row.captured_at,
            retirada: row.removed_at,
          })),
      ),
    );

  const build: EditorialEvidenceExportServiceShape["build"] = Effect.fn(
    "EditorialEvidenceExportService.build",
  )(function* (options) {
    const window = yield* parseDateWindow(options.since, options.until);
    const { mode } = options;
    const data = yield* Effect.gen(function* () {
      const names = yield* readPseudonyms;
      const lastEvent = yield* sql<{ readonly seq: number | null }>`
        SELECT MAX(seq) AS seq FROM editorial_events
      `;
      return {
        names,
        lastEventSeq: lastEvent[0]?.seq ?? 0,
        intervals: yield* intervalRows(window),
        events: yield* eventRows(window),
        runs: yield* readRuns(window),
        captures: mode === "full" ? yield* captureRows(window) : [],
      };
    }).pipe(Effect.catchTags({ SqlError: unreadable }));

    // Most recent first; the first decision of a thread inside the window is its current one.
    const all = yield* results.allDecisions.pipe(Effect.catch(unreadable));
    const seenThreads = new Set<string>();
    const decisions = all
      .filter((decision) => inWindow(window, decision.decidedAt))
      .map((decision) => {
        const current = !seenThreads.has(decision.threadId);
        seenThreads.add(decision.threadId);
        return { ...decision, current };
      })
      .toReversed();

    const view = yield* sources.list.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("editorial evidence: sources unreadable", { cause }).pipe(
          Effect.as({ sources: [] as ReadonlyArray<EditorialSourceEntry> }),
        ),
      ),
    );

    const csv: Record<string, ReadonlyArray<CsvRow>> = {
      [DECISIONS_FILE]: decisions.map((decision) => decisionRow(decision, decision.current)),
      [INTERVALS_FILE]: data.intervals,
      [EVENTS_FILE]: data.events,
      [RUNS_FILE]: data.runs.map(runRow),
      [CAPTURES_FILE]: data.captures,
    };
    const csvNames = EVIDENCE_FILES[mode].filter((name) => name !== SUMMARY_FILE);
    const project = (file: string) =>
      (csv[file] ?? []).map((row) => projectRow(file, mode, row, data.names));
    // In share the sequence passes its rule like any cell; `full` keeps the stored value.
    const lastEventSeq =
      mode === "share"
        ? numberOrNull(
            shareValue(
              { kind: "int", min: 0, max: COUNT_MAX },
              data.lastEventSeq,
              data.names,
            ) as CsvValue,
          )
        : data.lastEventSeq;
    // R8: the domain is checked on the stored decision, the same way Results does; a row out of
    // its domain leaves the aggregates and is only counted, never shown.
    const inDomain = decisions.map(decisionInDomain);
    const excludedByDomain = decisions.filter(
      (decision, index) => decision.current && !inDomain[index],
    ).length;
    const summary = renderSummary({
      mode,
      since: options.since ?? null,
      until: options.until ?? null,
      lastEventSeq,
      decisionRows: project(DECISIONS_FILE).filter((_row, index) => inDomain[index]),
      excludedByDomain,
      runRows: project(RUNS_FILE),
      sources: view.sources,
      fileRows: csvNames.map((name) => ({ name, rows: csv[name]?.length ?? 0 })),
    });
    const contents = new Map<string, { content: string; rows: number | null }>([
      [SUMMARY_FILE, { content: summary, rows: null }],
      ...csvNames.map(
        (name) =>
          [
            name,
            {
              content: renderCsv(name, mode, csv[name] ?? [], data.names),
              rows: csv[name]?.length ?? 0,
            },
          ] as const,
      ),
    ]);
    const files: ReadonlyArray<EvidenceFile> = EVIDENCE_FILES[mode].map((name) => {
      const entry = contents.get(name)!;
      return {
        name,
        content: entry.content,
        sha256: sha256Hex(entry.content),
        bytes: Buffer.byteLength(entry.content, "utf8"),
        rows: entry.rows,
      };
    });
    const packageHash = packageHashOf(files);
    const now = DateTime.formatIso(yield* DateTime.now);
    const day = now.slice(0, 10);
    const manifest = {
      schema: EVIDENCE_SCHEMA,
      mode,
      exportedAt: mode === "full" ? now : day,
      fork: { sha: forkSha, version: packageJson.version },
      filters: {
        since: filterBound(mode, options.since ?? null),
        until: filterBound(mode, options.until ?? null),
        timezone: "UTC",
        ...(mode === "share" &&
        [options.since, options.until].some(
          (value) => value !== undefined && !DAY_PATTERN.test(value),
        )
          ? { roundedToDay: true }
          : {}),
        appliesTo: {
          [DECISIONS_FILE]: "decidida",
          [INTERVALS_FILE]: "inicio",
          [EVENTS_FILE]: "fecha",
          [RUNS_FILE]: "corte",
          ...(mode === "full" ? { [CAPTURES_FILE]: "capturada" } : {}),
        },
      },
      state: { lastEventSeq },
      domain: {
        excludedDecisions: excludedByDomain,
        rule: "Una decisión vigente con un valor fuera de su dominio (utilidad de 1 a 5, tiempos de 0 a 7 días por etapa, conteos no negativos) queda fuera de los agregados del resumen; solo se cuenta. Las fechas fuera de 2020 a 2099 quedan vacías en share y no excluyen la decisión.",
      },
      packageHash,
      files: files.map((file) => ({
        name: file.name,
        sha256: file.sha256,
        bytes: file.bytes,
        rows: file.rows,
      })),
      columns: Object.fromEntries(
        csvNames.map((name) => [
          name,
          columnsOf(name, mode).map((spec) =>
            mode === "share" && spec.share !== null
              ? { name: spec.name, description: spec.description, rule: describeRule(spec.share) }
              : { name: spec.name, description: spec.description },
          ),
        ]),
      ),
      ...(mode === "share"
        ? { whitelist: shareWhitelist(), eventData: shareEventDataWhitelist() }
        : { eventData: "complete" }),
      rules: mode === "share" ? SHARE_RULES : FULL_RULES,
    };
    return {
      mode,
      packageName: `earlyscript-evidencia-${mode === "full" ? "completa" : "compartir"}-${day}`,
      packageHash,
      files,
      manifest: `${stableJson(manifest, 2)}\n`,
    } satisfies EvidencePackage;
  });

  const targetError = (directory: string, message: string) => (cause: unknown) =>
    Effect.logWarning("editorial evidence: writing failed", { directory, cause }).pipe(
      Effect.andThen(Effect.fail(new EditorialEvidenceExportError({ reason: "target", message }))),
    );

  const write: EditorialEvidenceExportServiceShape["write"] = Effect.fn(
    "EditorialEvidenceExportService.write",
  )(function* (pkg, directory, options) {
    if (!path.isAbsolute(directory)) {
      return yield* new EditorialEvidenceExportError({
        reason: "target",
        message: `The destination must be an absolute path: ${directory}`,
      });
    }
    const target = path.resolve(directory);
    const refuse = (message: string) =>
      Effect.fail(new EditorialEvidenceExportError({ reason: "target", message }));
    const failed = targetError(target, `Could not write the evidence package to ${target}.`);
    const unreachable = (entry: string) => () =>
      new EditorialEvidenceExportError({
        reason: "target",
        message: `Could not inspect ${entry} before writing the evidence package.`,
      });
    const lstat = (entry: string) =>
      Effect.try({
        try: () => NodeFS.lstatSync(entry, { throwIfNoEntry: false }),
        catch: unreachable(entry),
      });
    const realPath = (entry: string) =>
      Effect.try({ try: () => NodeFS.realpathSync(entry), catch: unreachable(entry) });

    const parent = path.dirname(target);
    // Containment: the real path of the deepest existing ancestor (links resolved all the way
    // up) must already be under `within`, before anything is created.
    const within = options?.within === undefined ? null : yield* realPath(options.within);
    const inside = (real: string) =>
      within === null ||
      real === within ||
      real.startsWith(within.endsWith(path.sep) ? within : `${within}${path.sep}`);
    if (within !== null) {
      let existing = target;
      while ((yield* lstat(existing)) === undefined && path.dirname(existing) !== existing) {
        existing = path.dirname(existing);
      }
      if (!inside(yield* realPath(existing))) {
        return yield* refuse(`${target} is outside ${options!.within}. Choose a folder there.`);
      }
    }
    // T3 Code shares the machine; its data folders are never an export destination.
    const t3CodeDirectory = yield* findT3CodeDirectoryFor(target);
    if (t3CodeDirectory !== undefined) {
      return yield* refuse(
        `${target} is inside T3 Code's data folder (${t3CodeDirectory}). Choose another folder.`,
      );
    }
    yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.catch(failed));
    // The destination is a real folder of its parent, never a link to somewhere else.
    const before = yield* lstat(target);
    if (before?.isSymbolicLink()) {
      return yield* refuse(`${target} is a symbolic link. Choose a real folder.`);
    }
    if (before !== undefined && !before.isDirectory()) {
      return yield* refuse(`${target} exists and is not a folder.`);
    }
    // Not recursive: if something appears there meanwhile, this fails instead of following it.
    if (before === undefined) yield* fs.makeDirectory(target).pipe(Effect.catch(failed));
    const resolved = yield* realPath(target);
    if (resolved !== path.join(yield* realPath(parent), path.basename(target))) {
      return yield* refuse(`${target} resolves outside its parent folder.`);
    }
    if (!inside(resolved)) {
      return yield* refuse(`${target} is outside ${options!.within}. Choose a folder there.`);
    }

    const entries = yield* fs.readDirectory(target).pipe(Effect.catch(failed));
    if (entries.length > 0) {
      const manifestPath = path.join(target, MANIFEST_FILE);
      const manifestStat = yield* lstat(manifestPath);
      const previous = manifestStat?.isFile()
        ? yield* fs.readFileString(manifestPath).pipe(
            Effect.map(parseJson),
            Effect.orElseSucceed(() => null),
          )
        : null;
      const ours =
        typeof previous === "object" &&
        previous !== null &&
        (previous as { readonly schema?: unknown }).schema === EVIDENCE_SCHEMA;
      if (!ours) {
        return yield* refuse(
          `${target} is not empty and holds no evidence package. Choose an empty or new folder.`,
        );
      }
      // Replace only our files (a link with one of our names goes, not what it points to), so a
      // share export over a full one leaves no capturas.csv.
      for (const name of ALL_EVIDENCE_FILES) {
        yield* fs.remove(path.join(target, name), { force: true }).pipe(Effect.catch(failed));
      }
    }
    // `wx`: a file that reappears, or a link planted with one of our names, fails the export.
    for (const file of pkg.files) {
      yield* fs
        .writeFileString(path.join(target, file.name), file.content, { flag: "wx" })
        .pipe(Effect.catch(failed));
    }
    // Last, so a folder with a manifest always holds the files it lists.
    yield* fs
      .writeFileString(path.join(target, MANIFEST_FILE), pkg.manifest, { flag: "wx" })
      .pipe(Effect.catch(failed));
    return target;
  });

  return EditorialEvidenceExportService.of({ build, write });
});

/** Needs `EditorialResultsService` and `EditorialSourcesService`; tests pass their own. */
export const layerFromReads = Layer.effect(EditorialEvidenceExportService, make);

/** Over the `EditorialSql` the server publishes; builds its own read services. */
export const layer = layerFromReads.pipe(
  Layer.provide(Layer.mergeAll(EditorialResultsService.layer, EditorialSourcesService.layer)),
);
