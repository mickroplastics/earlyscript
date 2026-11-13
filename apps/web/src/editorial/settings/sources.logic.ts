import {
  DELETION_NONE_DOCUMENTED,
  type SourceGovernance,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import type {
  EditorialSourceEntry,
  EditorialSourceGap,
  EditorialSourcesView,
} from "@t3tools/contracts";

import {
  capitalize,
  corpusLastDay,
  formatDay,
  itemsText,
  localDay,
  relativeDay,
  type Tone,
} from "./editorialStatus.logic";

// «Fuentes»: the line each source shows, its last seven days and how its data is deleted.

const DAY_MS = 86_400_000;

export interface StatusPart {
  readonly text: string;
  /** `ready`: the source may start counting, the one good news a row can give. */
  readonly tone: Tone | "ready";
}

/** What a source row says, in two parts: how its last day went, then what follows from it. */
export function sourceStatus(
  entry: EditorialSourceEntry,
  governance: SourceGovernance,
  view: EditorialSourcesView,
): ReadonlyArray<StatusPart> {
  // Corpus days are UTC days; "ayer" is about the operator's calendar.
  const today = localDay(view.asOf, undefined);
  const capture = entry.lastCapture;
  const ready = !entry.rank && entry.rankBlocked === null;
  const readyPart: ReadonlyArray<StatusPart> = ready
    ? [{ text: "lista para contar", tone: "ready" }]
    : [];
  if (entry.collectBlocked === "blocked") {
    return [
      { text: "Bloqueada", tone: "error" },
      { text: "sus condiciones no permiten capturarla", tone: "idle" },
    ];
  }
  if (entry.collectBlocked === "pending-review") {
    return [
      { text: "Sin capturar", tone: "idle" },
      { text: "falta leer sus términos", tone: "warning" },
    ];
  }
  if (!entry.collect) {
    return [
      { text: "Sin capturar", tone: "idle" },
      ...(capture === null
        ? []
        : [{ text: `la última, el ${formatDay(capture.day)}`, tone: "idle" as const }]),
      ...readyPart,
    ];
  }
  if (capture === null) return [{ text: "Todavía sin capturas", tone: "idle" }, ...readyPart];
  const failures = entry.recentGaps.filter((gap) => gap.reason === "fetch_failed").length;
  const failuresPart: ReadonlyArray<StatusPart> =
    failures > 1 ? [{ text: `${failures} fallos esta semana`, tone: "idle" }] : [];
  if (capture.status === "unavailable") {
    return [{ text: "No responde", tone: "error" }, ...failuresPart];
  }
  if (capture.status === "rate_limited") {
    return [{ text: "Limitada por cuota", tone: "warning" }, ...failuresPart];
  }
  const lastDay = corpusLastDay(view);
  const stale = lastDay !== null && capture.day < lastDay;
  const when = capitalize(relativeDay(capture.day, today));
  const how =
    capture.status === "complete"
      ? "completa"
      : governance.coverage === "sample"
        ? "muestra"
        : "parcial";
  return [
    {
      text: stale ? `Nada desde el ${formatDay(capture.day)}` : `${when}, ${how}`,
      tone: stale ? "warning" : how === "parcial" ? "warning" : "ok",
    },
    {
      text: itemsText(entry.source, capture.items),
      tone: capture.items === 0 ? "warning" : "idle",
    },
    ...readyPart,
  ];
}

export type DayState = "ok" | "failed" | "limited" | "partial" | "missing";

export interface DayCell {
  readonly day: string;
  readonly state: DayState;
  readonly label: string;
}

const GAP_STATE: Readonly<Record<EditorialSourceGap["reason"], DayState>> = {
  fetch_failed: "failed",
  rate_limited: "limited",
  partial: "partial",
  not_collected: "missing",
};

const DAY_LABEL: Readonly<Record<DayState, string>> = {
  ok: "sin huecos",
  failed: "falló",
  limited: "limitada por cuota",
  partial: "parcial",
  missing: "sin captura",
};

/**
 * The corpus's last seven days for a source, oldest first. The server lists only the days
 * without a full collection; a source never captured has none of them.
 */
export function dayCells(
  entry: EditorialSourceEntry,
  view: EditorialSourcesView,
): ReadonlyArray<DayCell> {
  const toDay = view.corpus.toDay;
  if (toDay === null) return [];
  const gaps = new Map(entry.recentGaps.map((gap) => [gap.day, gap.reason] as const));
  const end = Date.parse(`${toDay}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(end - (7 - index) * DAY_MS).toISOString().slice(0, 10);
    const reason = gaps.get(day);
    const state: DayState =
      entry.lastCapture === null || day > entry.lastCapture.day
        ? reason === undefined
          ? "missing"
          : GAP_STATE[reason]
        : reason === undefined
          ? "ok"
          : GAP_STATE[reason];
    return { day, state, label: `${formatDay(day)}: ${DAY_LABEL[state]}` };
  });
}

/** How collected items are deleted: a sentence, and the command to copy when there is one. */
export function deletionOf(governance: SourceGovernance): {
  readonly text: string;
  readonly command: string | null;
} {
  if (governance.deletion === DELETION_NONE_DOCUMENTED) {
    return { text: "Sin método documentado.", command: null };
  }
  // "engine purge --source hn --author <autor> o --url <enlace>: quita…", or the command
  // inside a sentence that ends with it.
  const match = /(engine purge --source [^:]+?)(?::\s|\.$)/.exec(governance.deletion);
  if (match === null) return { text: governance.deletion, command: null };
  const command = match[1]!;
  const by = [
    ...(command.includes("--feed") ? ["feed"] : []),
    ...(command.includes("--author") ? ["autor"] : []),
    ...(command.includes("--url") ? ["enlace"] : []),
  ];
  const list = by.length <= 1 ? by.join("") : `${by.slice(0, -1).join(", ")} o ${by.at(-1)}`;
  return {
    text: `Por ${list}, con un comando. Queda solo su huella y no se vuelve a capturar.`,
    command,
  };
}

/** The first sentence of the catalog's notes; the rest waits behind «Nota completa». */
export function firstSentence(text: string): string {
  const match = /^.+?[.;](?=\s|$)/.exec(text);
  const sentence = match === null ? text : match[0];
  return sentence.endsWith(";") ? `${sentence.slice(0, -1)}.` : sentence;
}

/** "Hacker News y GitHub", "Hacker News, GitHub y arXiv". */
export function namesList(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
}

/** Why a source that does not count cannot count yet, or null when it can. */
export function rankBlockText(
  entry: EditorialSourceEntry,
  governance: SourceGovernance,
): string | null {
  if (entry.rankBlocked === null) return null;
  if (entry.rankBlocked === "not-ready") {
    return governance.status === "blocked"
      ? "No puede contar: sus condiciones lo impiden."
      : "Para contar, primero hay que leer sus términos.";
  }
  const state =
    entry.backtest === null
      ? "pendiente"
      : entry.backtest.verdict === "worse"
        ? "la última empeoró los resultados"
        : entry.backtest.status === "provisional"
          ? "la última es provisional"
          : "pendiente";
  return `Para contar necesita una prueba que no empeore los resultados · ${state}`;
}
