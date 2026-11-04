import type {
  EditorialResultsAction,
  EditorialResultsMode,
  EditorialResultsStage,
  EditorialVideoClock,
  EditorialVideoDecision,
  EditorialVideoErrorReason,
  EditorialVideoSaveResultInput,
  EditorialVideoState,
} from "@t3tools/contracts";

export const STAGE_LABEL: Readonly<Record<EditorialResultsStage, string>> = {
  explore: "Explorar",
  read: "Leer",
  write: "Escribir",
  decide: "Decidir",
};

export const ACTION_LABEL: Readonly<Record<EditorialResultsAction, string>> = {
  accept: "Aceptar",
  edit: "Editar",
  reject: "Rechazar",
};

export const MODE_LABEL: Readonly<Record<EditorialResultsMode, string>> = {
  assisted: "asistido",
  manual: "manual",
};

/** The stages a thread of this mode moves through, in work order. */
export function stagesOf(mode: EditorialResultsMode): ReadonlyArray<EditorialResultsStage> {
  return mode === "manual" ? ["explore", "write", "decide"] : ["read", "write", "decide"];
}

/** The stage a stopped clock starts again in: the last one recorded, else the first of the mode. */
export function restartStage(
  mode: EditorialResultsMode,
  clock: EditorialVideoClock,
): EditorialResultsStage {
  return clock.unresolved.at(-1)?.stage ?? clock.stages.at(-1)?.stage ?? stagesOf(mode)[0]!;
}

export interface InterpolatedClock {
  readonly activeMs: number;
  /** Active time of the running or paused stage; null when idle. */
  readonly stageMs: number | null;
}

/**
 * The server's summary moved forward to `nowMs`. A running clock gains the time since the
 * client received the summary, measured on the client's own clock so a skew between the two
 * machines never shows; a paused or idle clock does not move.
 */
export function interpolateClock(
  clock: EditorialVideoClock,
  receivedAtMs: number,
  nowMs: number,
): InterpolatedClock {
  const elapsed = clock.state._tag === "running" ? Math.max(0, nowMs - receivedAtMs) : 0;
  const state = clock.state;
  const stageMs =
    state._tag === "idle"
      ? null
      : (clock.stages.find((entry) => entry.stage === state.stage)?.activeMs ?? 0) + elapsed;
  return { activeMs: clock.activeMs + elapsed, stageMs };
}

/** Active time of one stage moved forward to `nowMs`; only the running stage moves. */
export function stageClockMs(
  clock: EditorialVideoClock,
  stage: EditorialResultsStage,
  receivedAtMs: number,
  nowMs: number,
): number {
  const recorded = clock.stages.find((entry) => entry.stage === stage)?.activeMs ?? 0;
  const running = clock.state._tag === "running" && clock.state.stage === stage;
  return recorded + (running ? Math.max(0, nowMs - receivedAtMs) : 0);
}

/** `mm:ss` under an hour, `h:mm:ss` from there; whole seconds, rounded down. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** A recorded duration; "sin registro" when the stage never ran, never a zero by omission. */
export function formatStageDuration(ms: number | null): string {
  return ms === null ? "sin registro" : formatClock(ms);
}

/** The hash without its algorithm prefix, cut to eight characters. */
export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 8);
}

/** Local `HH:mm`, or the date as well when it is not today. */
export function formatSavedAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString("es", { day: "numeric", month: "short" })} ${time}`;
}

export function claimsLabel(claims: number | null, cited: number | null): string | null {
  if (claims === null || cited === null) return null;
  return `${cited} de ${claims} afirmaciones con cita`;
}

export interface DecisionDraft {
  readonly action: EditorialResultsAction | null;
  readonly utility: number | null;
  readonly reason: string;
}

export const EMPTY_DECISION_DRAFT: DecisionDraft = { action: null, utility: null, reason: "" };

/**
 * `decided` is read-only; `unresolved` waits for a recovered segment's resolution;
 * `version-changed` follows a refusal, `to` being the server's version (null until it arrives);
 * `open` is the form with the version it would name and why it cannot be sent yet.
 */
export type DecisionBlockState =
  | { readonly _tag: "decided"; readonly decision: EditorialVideoDecision }
  | {
      readonly _tag: "version-changed";
      readonly from: string | null;
      readonly to: string | null;
    }
  | { readonly _tag: "unresolved"; readonly intervalId: string }
  | {
      readonly _tag: "open";
      readonly versionHash: string | null;
      readonly problem: string | null;
    };

export function decisionBlockState(
  video: EditorialVideoState,
  draft: DecisionDraft,
  /** The version a refused submission named; undefined when nothing was refused. */
  refusedHash: string | null | undefined,
): DecisionBlockState {
  if (video.decision !== null) return { _tag: "decided", decision: video.decision };
  const head = video.script.head?.contentHash ?? null;
  if (refusedHash !== undefined) {
    return { _tag: "version-changed", from: refusedHash, to: head === refusedHash ? null : head };
  }
  // The decision freezes its durations: a segment recovered after a restart is resolved first.
  const unresolved = video.clock.unresolved[0];
  if (unresolved !== undefined) return { _tag: "unresolved", intervalId: unresolved.intervalId };
  return { _tag: "open", versionHash: head, problem: decisionProblem(video, draft) };
}

function decisionProblem(video: EditorialVideoState, draft: DecisionDraft): string | null {
  if (video.script.head === null && video.script.exists) {
    return "Guarda una versión del guion para decidir sobre ella.";
  }
  if (draft.action === null) return "Elige una acción.";
  if (draft.utility === null) return "Elige la utilidad de 1 a 5.";
  if (draft.action !== "accept" && draft.reason.trim().length === 0) {
    return `El motivo es obligatorio para ${draft.action === "edit" ? "editar" : "rechazar"}.`;
  }
  return null;
}

export const RESULT_METRICS = [
  { key: "views", label: "Vistas" },
  { key: "clicks", label: "Clics" },
  { key: "subscribers", label: "Suscripciones" },
  { key: "comments", label: "Comentarios" },
] as const;

export type ResultMetricKey = (typeof RESULT_METRICS)[number]["key"];

export interface ResultDraft {
  readonly metrics: Readonly<Record<ResultMetricKey, string>>;
  /** `YYYY-MM-DD` from a date input. */
  readonly observedOn: string;
}

export function emptyResultDraft(today: Date = new Date()): ResultDraft {
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    metrics: { views: "", clicks: "", subscribers: "", comments: "" },
    observedOn: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
  };
}

export type ResultDraftParse =
  | { readonly _tag: "ok"; readonly input: Omit<EditorialVideoSaveResultInput, "threadId"> }
  | { readonly _tag: "invalid"; readonly problem: string };

/** Blank metrics are omitted; at least one is required, each a whole number from zero. */
export function parseResultDraft(draft: ResultDraft): ResultDraftParse {
  const metrics: Partial<Record<ResultMetricKey, number>> = {};
  for (const { key, label } of RESULT_METRICS) {
    const raw = draft.metrics[key].trim();
    if (raw === "") continue;
    if (!/^\d+$/.test(raw)) {
      return { _tag: "invalid", problem: `${label}: escribe un número entero desde 0.` };
    }
    metrics[key] = Number(raw);
  }
  if (Object.keys(metrics).length === 0) {
    return { _tag: "invalid", problem: "Escribe al menos una métrica." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.observedOn)) {
    return { _tag: "invalid", problem: "Indica la fecha de la observación." };
  }
  // Noon UTC keeps the calendar day the operator picked in every time zone of the Americas.
  return {
    _tag: "ok",
    input: { ...metrics, observedAt: `${draft.observedOn}T12:00:00.000Z` },
  };
}

const FAILURE_TEXT: Readonly<Record<EditorialVideoErrorReason, string>> = {
  unavailable: "Este servidor no tiene los servicios editoriales.",
  "not-found": "Este hilo no tiene asociación editorial.",
  "invalid-input": "El servidor rechazó los datos.",
  "version-changed": "El guion cambió después de la versión que leíste.",
  "clock-state": "El reloj ya estaba en otro estado; la vista se actualizó.",
  decided: "El hilo ya está decidido; su reloj es definitivo.",
  "clock-unresolved": "Resuelve el tramo abierto antes de decidir.",
  "not-decided": "Registra la decisión antes del resultado.",
  "script-file": "No se pudo leer el archivo del guion.",
  "thread-deleted": "El hilo se borró: su registro editorial ya no admite cambios.",
  "thread-live": "Borra primero el hilo; sus datos editoriales se borran después.",
  launch: "No se pudo crear el hilo en T3.",
  storage: "No se pudo escribir en la base editorial.",
};

/** The reason of a video command failure, or null for a transport or authorization failure. */
export function videoFailureReason(error: unknown): EditorialVideoErrorReason | null {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EditorialVideoError" &&
    "reason" in error
    ? (error.reason as EditorialVideoErrorReason)
    : null;
}

/**
 * Spanish text for a failed command; the server detail follows for input and file errors, and a
 * launch failure shows the server's text alone.
 */
export function videoFailureText(error: unknown): string {
  const reason = videoFailureReason(error);
  if (reason !== null) {
    // A launch failure's message is the server's own Spanish text for its cause.
    if (reason === "launch" && typeof error === "object" && error !== null && "message" in error) {
      const message = String(error.message).trim();
      if (message.length > 0) return message;
    }
    const detail =
      (reason === "invalid-input" || reason === "script-file") &&
      typeof error === "object" &&
      error !== null &&
      "message" in error
        ? ` ${String(error.message)}`
        : "";
    return `${FAILURE_TEXT[reason]}${detail}`;
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "EnvironmentAuthorizationError") {
      return "Esta sesión no tiene permiso para operar hilos.";
    }
  }
  return error instanceof Error ? error.message : "El entorno no respondió.";
}

/** `YYYY-MM-DDTHH:mm` in local time, the value of a `datetime-local` input. */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The end of a recovered segment the operator typed, as ISO, kept inside the segment: an input
 * rounded to the minute may fall a few seconds before its start or after its recovery.
 */
export function resolvedEndIso(
  localValue: string,
  interval: { readonly startedAt: string; readonly recoveredAt: string | null },
): string | null {
  const typed = Date.parse(localValue);
  if (!Number.isFinite(typed)) return null;
  const start = Date.parse(interval.startedAt);
  const end =
    interval.recoveredAt === null ? Number.POSITIVE_INFINITY : Date.parse(interval.recoveredAt);
  return new Date(Math.min(Math.max(typed, start), end)).toISOString();
}

/**
 * The first message an operator can send to an assisted thread's agent, placed in the composer
 * and never sent by itself. Citations follow `@earlyscript/editorial-script`: the evidence id in
 * brackets, its URL under Sources.
 */
export function draftRequestPrompt(): string {
  return "Escribe el primer borrador del guion de esta tendencia.";
}

/**
 * The dossier and script paths of an assisted thread whose agent has not been asked anything
 * yet; null once the thread has a run or a message, is decided or deleted, or lacks a dossier.
 */
export function draftRequestPaths(
  video: EditorialVideoState,
  thread: {
    readonly latestRun: object | null;
    readonly latestUserMessageAt: string | null;
  } | null,
): { readonly dossierPath: string; readonly scriptPath: string } | null {
  if (video.thread.mode !== "assisted" || video.thread.deleted || video.decision !== null) {
    return null;
  }
  if (thread === null || thread.latestRun !== null || thread.latestUserMessageAt !== null) {
    return null;
  }
  const { path: scriptPath, dossierPath } = video.script;
  if (scriptPath === null || dossierPath === undefined || dossierPath === null) return null;
  return { dossierPath, scriptPath };
}
