import { checkScript, parseScript } from "@earlyscript/editorial-script";
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

/** «17:05 de hoy» or «17:05 del 9 de nov»: a time of day never read as a measured duration. */
export function timeOfDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString()
    ? `${time} de hoy`
    : `${time} del ${date.getDate()} de ${MONTHS[date.getMonth()]}`;
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

  const activeDetail = (stage: AssistedStage): string => {
    if (stage === "read") return "Ahora · lee de qué va el tema";
    if (stage === "decide") return "Ahora · elige, califica y explica";
    if (agentWorking && !drafted) return "Borrador · el asistente lo escribe";
    if (agentWorking) return "Revisión · el asistente trabaja en tu pedido";
    if (drafted) return "Borrador listo · ahora revisas y pides cambios";
    return "Ahora · pide el borrador al asistente";
  };
  const laterDetail: Readonly<Record<AssistedStage, string>> = {
    read: "Lo ya medido se queda aquí",
    write: "Después · el asistente escribe, tú revisas",
    decide: "Después · aceptar, editar o rechazar",
  };

  const steps = ASSISTED_STEPS.map((stage, index): StepView => {
    const base = { stage, number: (index + 1) as 1 | 2 | 3, title: STEP_TITLE[stage] };
    if (openStages.has(stage)) {
      return { ...base, status: "open", detail: "Falta un dato del reloj · tramo abierto" };
    }
    if (index === currentIndex) {
      if (state._tag === "paused") {
        return { ...base, status: "paused", detail: "En pausa · el tiempo no cuenta" };
      }
      if (state._tag === "idle") {
        return { ...base, status: "paused", detail: "Reloj detenido · el tiempo no cuenta" };
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
          text: `Un tramo de «${STEP_TITLE[unresolved.stage]}» quedó abierto al cerrarse la app, desde las ${timeOfDay(unresolved.startedAt, input.now)}. No cuenta hasta que indiques cuándo dejaste de trabajar.`,
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
              text: "El reloj está detenido. Reanúdalo para seguir midiendo tu tiempo.",
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

export interface NumberedSource {
  readonly id: string;
  readonly number: number;
  readonly evidence: EditorialEvidenceItem | null;
  /** Citation markers naming it in the script body. */
  readonly uses: number;
  /** Headings of the script sections that cite it, in order. */
  readonly sections: ReadonlyArray<string>;
  /** File lines of the paragraphs holding each marker, one entry per marker. */
  readonly occurrences: ReadonlyArray<number>;
}

/**
 * One numbering for the topic, the script and the browser: the sources the script cites in
 * the order it first cites them, then the rest of the dossier in its own order.
 */
export function numberSources(
  contents: string,
  evidence: ReadonlyArray<EditorialEvidenceItem>,
): ReadonlyArray<NumberedSource> {
  const ast = parseScript(contents);
  const body = ast.sections.filter((section) => section.kind !== "sources");
  const paragraphs = body.flatMap((section) =>
    section.paragraphs.map((paragraph) => ({
      heading: section.heading,
      line: paragraph.line,
      end: paragraph.line + paragraph.text.split("\n").length,
    })),
  );
  const markers = ast.citations.flatMap((citation) => {
    const paragraph = paragraphs.find((p) => citation.line >= p.line && citation.line < p.end);
    return paragraph ? [{ id: citation.id, paragraph }] : [];
  });
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
      sections: [...new Set(mine.map((marker) => marker.paragraph.heading))],
      occurrences: mine.map((marker) => marker.paragraph.line),
    };
  });
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
