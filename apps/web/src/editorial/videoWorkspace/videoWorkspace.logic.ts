import { checkScript, citationsIn, parseScript } from "@earlyscript/editorial-script";
import type {
  EditorialEvidenceItem,
  EditorialResultsAction,
  EditorialResultsStage,
  EditorialVideoState,
} from "@t3tools/contracts";

import { formatClock } from "../videoThread.logic";

/** The three steps of an assisted thread: exactly the stages its work clock measures. */
export const ASSISTED_STEPS = ["read", "write", "decide"] as const;
export type AssistedStage = (typeof ASSISTED_STEPS)[number];

export const STEP_TITLE: Readonly<Record<EditorialResultsStage, string>> = {
  explore: "Explorar",
  read: "Leer el tema",
  write: "Escribir y revisar",
  decide: "Decidir",
};

const ACTION_PAST: Readonly<Record<EditorialResultsAction, string>> = {
  accept: "aceptado",
  edit: "editado",
  reject: "rechazado",
};

/** Sections of the script with prose, out of its sections (Sources aside). */
export interface DraftParts {
  readonly done: number;
  readonly total: number;
}

export function draftParts(contents: string): DraftParts {
  const sections = parseScript(contents).sections.filter((s) => s.kind !== "sources");
  return {
    done: sections.filter((s) => s.paragraphs.length > 0).length,
    total: sections.length,
  };
}

export type StepStatus = "done" | "active" | "paused" | "open" | "pending";

export interface StepView {
  readonly stage: AssistedStage;
  readonly number: 1 | 2 | 3;
  readonly title: string;
  readonly status: StepStatus;
  readonly detail: string;
}

export type NowAction = "decide" | "back-to-write" | "resume" | "restart" | "resolve" | null;

export interface NowView {
  readonly tone: "now" | "pause" | "open" | "done";
  readonly label: string;
  readonly text: string;
  readonly action: NowAction;
}

export interface StepperModel {
  /** The step the operator is in; null once decided. */
  readonly current: AssistedStage | null;
  readonly steps: ReadonlyArray<StepView>;
  readonly now: NowView;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const clockOf = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const dayOf = (date: Date, now: Date) =>
  date.toDateString() === now.toDateString()
    ? "de hoy"
    : `del ${date.getDate()} de ${MONTHS[date.getMonth()]}`;

/** «17:05 de hoy» or «17:05 del 9 de nov»: a time of day never read as a measured duration. */
export function timeOfDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  return `${clockOf(date)} ${dayOf(date, now)}`;
}

/** «10 nov 2026 a las 00:11», for recorded dates. */
export function dateAndTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} a las ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const asAssisted = (stage: EditorialResultsStage): AssistedStage =>
  stage === "explore" ? "read" : stage;

/**
 * Where an assisted thread stands, as its three steps and the «Ahora» line. Times are left to
 * the caller, which reads the running second in a leaf so the tree does not repaint each tick.
 */
export function stepperModel(input: {
  readonly video: EditorialVideoState;
  readonly parts: DraftParts;
  readonly agentWorking: boolean;
  readonly now?: Date;
}): StepperModel {
  const { video, parts, agentWorking } = input;
  const { clock, decision } = video;
  const drafted = parts.done > 0;
  const openStages = new Set(clock.unresolved.map((interval) => asAssisted(interval.stage)));

  if (decision !== null) {
    const total = decision.durations.totalMs;
    return {
      current: null,
      steps: ASSISTED_STEPS.map((stage, index) => ({
        stage,
        number: (index + 1) as 1 | 2 | 3,
        title: STEP_TITLE[stage],
        status: "done",
        detail:
          stage === "read"
            ? "Hecho"
            : stage === "write"
              ? "Hecho · borrador y revisión"
              : `Hecho · ${ACTION_PAST[decision.action]}`,
      })),
      now: {
        tone: "done",
        label: "Listo",
        text: `Decidido · ${total === null ? "tiempo pendiente" : `${formatClock(total)} en total`}. Cuando publiques el video, anota sus métricas en el resumen.`,
        action: null,
      },
    };
  }

  const state = clock.state;
  const current: AssistedStage =
    state._tag !== "idle"
      ? asAssisted(state.stage)
      : clock.unresolved.length > 0
        ? asAssisted(clock.unresolved.at(-1)!.stage)
        : drafted
          ? "write"
          : "read";
  const currentIndex = ASSISTED_STEPS.indexOf(current);

  // The step says where things stand; the «Ahora» line alone says what to do.
  const activeDetail = (stage: AssistedStage): string => {
    if (stage !== "write") return "En curso";
    if (agentWorking && !drafted) return "En curso · el asistente escribe el borrador";
    if (agentWorking) return "En curso · el asistente atiende tu pedido";
    if (drafted) return "En curso · borrador listo, en revisión";
    return "En curso · sin borrador todavía";
  };
  const laterDetail: Readonly<Record<AssistedStage, string>> = {
    read: "Después",
    write: "Después · el asistente escribe, tú revisas",
    decide: "Después · aceptar, editar o rechazar",
  };

  const steps = ASSISTED_STEPS.map((stage, index): StepView => {
    const base = { stage, number: (index + 1) as 1 | 2 | 3, title: STEP_TITLE[stage] };
    if (openStages.has(stage)) {
      return { ...base, status: "open", detail: "Tramo abierto · falta la hora en que paraste" };
    }
    if (index === currentIndex) {
      if (state._tag === "paused") {
        return { ...base, status: "paused", detail: "En pausa" };
      }
      if (state._tag === "idle") {
        return { ...base, status: "paused", detail: "Reloj detenido" };
      }
      return { ...base, status: "active", detail: activeDetail(stage) };
    }
    if (index < currentIndex) {
      return {
        ...base,
        status: "done",
        detail: stage === "write" ? "Hecho · borrador y revisión" : "Hecho",
      };
    }
    return { ...base, status: "pending", detail: laterDetail[stage] };
  });

  const unresolved = clock.unresolved[0];
  const now: NowView =
    unresolved !== undefined
      ? {
          tone: "open",
          label: "Falta un dato",
          text: `Un tramo de «${STEP_TITLE[unresolved.stage]}» empezó a las ${timeOfDay(unresolved.startedAt, input.now)} y quedó abierto: la app se cerró con el reloj en marcha. No cuenta hasta que digas cuándo dejaste de trabajar.`,
          action: "resolve",
        }
      : state._tag === "paused"
        ? {
            tone: "pause",
            label: "Pausa",
            text: `El reloj está en pausa desde las ${timeOfDay(state.since, input.now)}. Ese tiempo no cuenta hasta que reanudes${current === "read" ? "; escribir al asistente no lo reanuda" : ""}.`,
            action: "resume",
          }
        : state._tag === "idle"
          ? {
              tone: "pause",
              label: "Detenido",
              text: `El reloj está detenido y no mide. Al reanudarlo, cuenta en «${STEP_TITLE[current]}».`,
              action: "restart",
            }
          : current === "read"
            ? {
                tone: "now",
                label: "Ahora",
                text: "Lee el tema. Tu primer mensaje al asistente empieza el paso 2, pida o no el borrador.",
                action: null,
              }
            : current === "decide"
              ? {
                  tone: "now",
                  label: "Ahora",
                  text: "Decide qué haces con este guion: elige una opción, califícalo y explica por qué.",
                  action: "back-to-write",
                }
              : agentWorking
                ? {
                    tone: "now",
                    label: "Ahora",
                    text: drafted
                      ? "El asistente trabaja en tu pedido. El guion se actualiza cuando termine."
                      : "El asistente está escribiendo el borrador. Aparecerá en Guion cuando lo guarde.",
                    action: null,
                  }
                : drafted
                  ? {
                      tone: "now",
                      label: "Ahora",
                      text: "Lee el guion. Pide cambios al asistente o toca un número para abrir su fuente.",
                      action: "decide",
                    }
                  : {
                      tone: "now",
                      label: "Ahora",
                      text: "Pide el borrador al asistente: elige una sugerencia o escríbele con tus palabras.",
                      action: null,
                    };

  return { current, steps, now };
}

/** Something in the script to look at before recording: a blank to fill or a note to self. */
export interface ScriptNotice {
  readonly kind: "hole" | "operator";
  /** File line of the paragraph that holds it. */
  readonly line: number;
  readonly text: string;
}

const OPERATOR_NOTE = /^<!--\s*OPERATOR\b:?\s*([\s\S]*?)\s*-->$/;
const HOLE = /\{\{([^{}]*)\}\}/g;

/** The operator note a paragraph is, or null; the note's text without the comment markers. */
export function operatorNoteOf(paragraph: string): string | null {
  return OPERATOR_NOTE.exec(paragraph.trim())?.[1] ?? null;
}

export function scriptNotices(contents: string): ReadonlyArray<ScriptNotice> {
  const notices: ScriptNotice[] = [];
  for (const section of parseScript(contents).sections) {
    if (section.kind === "sources") continue;
    for (const paragraph of section.paragraphs) {
      const note = operatorNoteOf(paragraph.text);
      if (note !== null) {
        notices.push({ kind: "operator", line: paragraph.line, text: note });
        continue;
      }
      for (const match of paragraph.text.matchAll(HOLE)) {
        notices.push({ kind: "hole", line: paragraph.line, text: match[1]?.trim() ?? "" });
      }
    }
  }
  return notices;
}

/**
 * The citation verifier's count, as the server records it per version: sentences without a
 * source marker. It says nothing about whether a source supports its sentence.
 */
export function uncitedSentences(contents: string): {
  readonly claims: number;
  readonly uncited: ReadonlyArray<{ readonly line: number; readonly text: string }>;
} {
  const report = checkScript(contents);
  return {
    claims: report.counts.claims,
    uncited: report.uncitedClaims.map((claim) => ({ line: claim.line, text: claim.text })),
  };
}

/** One citation marker of the script: its paragraph's file line and a key unique to it. */
export interface SourceOccurrence {
  readonly line: number;
  /** `line:offset:id`, the offset of the marker in its paragraph's text. */
  readonly key: string;
}

export interface NumberedSource {
  readonly id: string;
  readonly number: number;
  readonly evidence: EditorialEvidenceItem | null;
  /** Citation markers naming it in the script body. */
  readonly uses: number;
  /** Headings of the script sections that cite it, in order. */
  readonly sections: ReadonlyArray<string>;
  /** Each marker naming it, in document order. */
  readonly occurrences: ReadonlyArray<SourceOccurrence>;
  /** Paragraphs holding at least one of those markers. */
  readonly paragraphs: number;
}

export const citationKey = (line: number, offset: number, id: string) => `${line}:${offset}:${id}`;

/**
 * One numbering for the topic, the script and the browser: the sources the script cites in
 * the order it first cites them, then the rest of the dossier in its own order.
 */
export function numberSources(
  contents: string,
  evidence: ReadonlyArray<EditorialEvidenceItem>,
): ReadonlyArray<NumberedSource> {
  const markers = parseScript(contents)
    .sections.filter((section) => section.kind !== "sources")
    .flatMap((section) =>
      section.paragraphs.flatMap((paragraph) =>
        citationsIn(paragraph.text).flatMap((citation) =>
          citation.ids.map((id) => ({
            id,
            heading: section.heading,
            line: paragraph.line,
            key: citationKey(paragraph.line, citation.offset, id),
          })),
        ),
      ),
    );
  const order = [
    ...new Set([...markers.map((marker) => marker.id), ...evidence.map((item) => item.itemId)]),
  ];
  return order.map((id, index) => {
    const mine = markers.filter((marker) => marker.id === id);
    return {
      id,
      number: index + 1,
      evidence: evidence.find((item) => item.itemId === id) ?? null,
      uses: mine.length,
      sections: [...new Set(mine.map((marker) => marker.heading))],
      occurrences: mine.map(({ line, key }) => ({ line, key })),
      paragraphs: new Set(mine.map((marker) => marker.line)).size,
    };
  });
}

export type InlineToken =
  | { readonly kind: "text"; readonly text: string; readonly offset: number }
  | { readonly kind: "hole"; readonly text: string; readonly offset: number }
  | { readonly kind: "cite"; readonly ids: ReadonlyArray<string>; readonly offset: number };

/**
 * A span of script prose as text, blanks to fill (`{{…}}`) and citation markers, read with the
 * parser's own rules so `[hn:1]` and `[itm_hn_1]` both name `itm_hn_1`. Offsets are in `text`.
 */
export function inlineTokens(text: string): ReadonlyArray<InlineToken> {
  const marks = [
    ...citationsIn(text).map((citation) => ({
      offset: citation.offset,
      length: citation.raw.length,
      token: { kind: "cite" as const, ids: citation.ids, offset: citation.offset },
    })),
    ...[...text.matchAll(HOLE)].map((match) => ({
      offset: match.index,
      length: match[0].length,
      token: { kind: "hole" as const, text: match[0], offset: match.index },
    })),
  ].sort((left, right) => left.offset - right.offset);
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.offset < cursor) continue;
    if (mark.offset > cursor) {
      tokens.push({ kind: "text", text: text.slice(cursor, mark.offset), offset: cursor });
    }
    tokens.push(mark.token);
    cursor = mark.offset + mark.length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor), offset: cursor });
  return tokens;
}

export type SummarySegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "cite"; readonly id: string; readonly number: number };

/**
 * The trend's summary with its citations numbered by the script's numbering, never by position:
 * a source the dossier lacks keeps its number elsewhere. Unknown markers stay as written.
 */
export function summarySegments(
  text: string,
  numbers: ReadonlyMap<string, number>,
): ReadonlyArray<SummarySegment> {
  const segments: SummarySegment[] = [];
  const pushText = (value: string) => {
    if (value.length === 0) return;
    const last = segments.at(-1);
    if (last?.kind === "text")
      segments[segments.length - 1] = { kind: "text", text: last.text + value };
    else segments.push({ kind: "text", text: value });
  };
  let cursor = 0;
  for (const citation of citationsIn(text)) {
    if (!citation.ids.every((id) => numbers.has(id))) continue;
    // The number sits against its claim.
    pushText(text.slice(cursor, citation.offset).replace(/\s+$/, ""));
    for (const id of citation.ids) segments.push({ kind: "cite", id, number: numbers.get(id)! });
    cursor = citation.offset + citation.raw.length;
  }
  pushText(text.slice(cursor));
  return segments;
}

/**
 * Which script the thread shows: the working file before the decision, the version the
 * decision names after it, or none when the decision was recorded without a saved version.
 */
export function scriptSource(
  video: EditorialVideoState,
):
  | { readonly kind: "live" }
  | { readonly kind: "decided"; readonly hash: string }
  | { readonly kind: "none" } {
  if (video.decision === null) return { kind: "live" };
  const hash = video.decision.scriptVersionHash;
  return hash === null ? { kind: "none" } : { kind: "decided", hash };
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * The local calendar days an open segment covers, from its start to its detection (or now):
 * the days the operator can say they stopped on.
 */
export function stopDays(
  interval: { readonly startedAt: string; readonly recoveredAt: string | null },
  now: Date = new Date(),
): ReadonlyArray<{ readonly value: string; readonly label: string }> {
  const start = new Date(interval.startedAt);
  const end = interval.recoveredAt === null ? now : new Date(interval.recoveredAt);
  const days: Array<{ value: string; label: string }> = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cursor <= end) {
    days.push({
      value: dayKey(cursor),
      label: `${WEEKDAYS[cursor.getDay()]} ${cursor.getDate()} de ${MONTHS[cursor.getMonth()]}`,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * The moment the operator names for the end of an open segment: the day they picked
 * (`YYYY-MM-DD`, local) and the time they typed («23:52», «0:05», «23.55»). Null when it is not
 * a time or falls outside the segment. The minute the segment started counts, never before it.
 */
export function stopTimeIso(
  day: string,
  typed: string,
  interval: { readonly startedAt: string; readonly recoveredAt: string | null },
  now: Date = new Date(),
): string | null {
  const time = /^(\d{1,2})[:.h](\d{2})$/.exec(typed.trim());
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!time || !date) return null;
  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  if (hours > 23 || minutes > 59) return null;
  const candidate = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), hours, minutes);
  const start = new Date(interval.startedAt);
  const floor = new Date(start);
  floor.setSeconds(0, 0);
  const end = interval.recoveredAt === null ? now : new Date(interval.recoveredAt);
  if (candidate < floor || candidate > end) return null;
  return new Date(Math.max(candidate.getTime(), start.getTime())).toISOString();
}

/** «martes 10 de noviembre de 2026 a las 00:05»: the moment that will be saved, in full. */
export function fullDateTime(iso: string): string {
  const date = new Date(iso);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} de ${MONTH_NAMES[date.getMonth()]} de ${date.getFullYear()} a las ${clockOf(date)}`;
}

/** The offset of the dossier's next page of evidence, or null once all of it is loaded. */
export function nextEvidenceOffset(
  page: { readonly evidenceTotal: number; readonly pageLength: number },
  offset: number,
): number | null {
  const next = offset + page.pageLength;
  return page.pageLength > 0 && next < page.evidenceTotal ? next : null;
}

/** The time of a step with an open segment: what is measured, said as a floor, never «00:00». */
export function openStageTime(ms: number): string {
  return Math.floor(ms / 1000) === 0 ? "sin medir" : `al menos ${formatClock(ms)}`;
}

/** Where a source opens: its discussion page, else the link it points to. */
export function sourceUrl(evidence: EditorialEvidenceItem | null): string | null {
  return evidence?.permalink ?? evidence?.externalUrl ?? null;
}

/**
 * Each stage is truncated to the second on its own, so the visible sum may fall a second or
 * two under the total; the line that says so, or null when they match.
 */
export function stageSumNote(
  stagesMs: ReadonlyArray<number | null>,
  totalMs: number | null,
): string | null {
  if (totalMs === null) return null;
  const seconds = (ms: number) => Math.floor(ms / 1000);
  const sum = stagesMs.reduce<number>((acc, ms) => acc + (ms === null ? 0 : seconds(ms)), 0);
  const gap = seconds(totalMs) - sum;
  if (gap <= 0) return null;
  return `Cada paso se redondea al segundo por separado; por eso la suma visible da ${formatClock(sum * 1000)}.`;
}

/** The five anchors of the utility scale, literal from the protocol: they rate the script. */
export const UTILITY_ANCHOR: Readonly<Record<number, string>> = {
  1: "no utilizable",
  2: "cambios mayores",
  3: "revisión sustancial",
  4: "cambios menores",
  5: "lista para decidir",
};
