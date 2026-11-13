import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

// The brief trend card (engine v3, contract §1): three visible lines and a detail. The server
// builds it from the dossier file; a dossier without the v3 fields gets a derived card with what
// it has, never invented values. Ranking, scores, probes, growth, the coverage table,
// eligibility and novelty stay in the dossier JSON and are not part of the card.

/** How the trend moved over its last weeks, from the engine; the first rule that applies wins. */
export const EditorialTrendMovement = Schema.Literals([
  "new",
  "weak",
  "strong",
  "rebound",
  "falling",
  "stable",
]);
export type EditorialTrendMovement = typeof EditorialTrendMovement.Type;

/**
 * One source's weeks W3..W0, oldest first; W0 is the week before the cutoff. `comparable`: the
 * source is in the cohort; `partial`: counted but without the 35 days a comparable source needs;
 * `unused`: captured but not clustered (Wikipedia), no weeks. `total`: an older dossier without a
 * curve by source, all sources together. A `null` week is a week the source did not capture.
 */
export const EditorialCardCurveRow = Schema.Struct({
  source: Schema.String,
  status: Schema.Literals(["comparable", "partial", "unused", "total"]),
  weeks: Schema.Array(Schema.NullOr(NonNegativeInt)),
});
export type EditorialCardCurveRow = typeof EditorialCardCurveRow.Type;

/** A source and the UTC day of its first item among the comparable sources. */
export const EditorialCardSourceDay = Schema.Struct({
  source: Schema.String,
  day: Schema.String,
});
export type EditorialCardSourceDay = typeof EditorialCardSourceDay.Type;

/** An item of the card: a headline or one evidence row. `itemId` is what a script cites. */
export const EditorialCardItem = Schema.Struct({
  itemId: Schema.NullOr(Schema.String),
  source: Schema.String,
  title: Schema.String,
  /** UTC day of publication, when known. */
  day: Schema.NullOr(Schema.String),
  /** The link the card opens: the external URL, else the source's page; http(s) only. */
  url: Schema.NullOr(Schema.String),
  /** Other sources that carried the same URL (counted once). */
  alsoIn: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type EditorialCardItem = typeof EditorialCardItem.Type;

/** A decision the operator recorded on a video thread, as the card shows it. */
export const EditorialCardDecision = Schema.Struct({
  threadId: Schema.String,
  action: Schema.Literals(["accept", "edit", "reject"]),
  utility: Schema.NullOr(NonNegativeInt),
  reason: Schema.NullOr(Schema.String),
  decidedAt: IsoDateTime,
});
export type EditorialCardDecision = typeof EditorialCardDecision.Type;

export const EditorialTrendCard = Schema.Struct({
  /** `v3`: the engine wrote the card fields; `derived`: built from an older dossier. */
  origin: Schema.Literals(["v3", "derived"]),
  /** "En movimiento" or "De fondo"; null for an older run, which has one list. */
  section: Schema.NullOr(Schema.Literals(["moving", "background"])),
  /** Place in its section as the engine emitted it. */
  position: Schema.NullOr(PositiveInt),
  movement: Schema.NullOr(EditorialTrendMovement),
  /** UTC day the trend entered its movement. */
  since: Schema.NullOr(Schema.String),
  /** The topic had weeks of activity before (perennial antecedent): a mark, not a movement. */
  perennial: Schema.Boolean,
  curve: Schema.Array(EditorialCardCurveRow),
  /** Comparable sources with items in W3..W0; for an older dossier, the trend's sources. */
  sourceCount: NonNegativeInt,
  firstSource: Schema.NullOr(EditorialCardSourceDay),
  secondSource: Schema.NullOr(EditorialCardSourceDay),
  /** The closest include topic of the profile and the profile terms found in W0 titles. */
  fit: Schema.Struct({
    topic: Schema.NullOr(Schema.String),
    terms: Schema.Array(Schema.String),
  }),
  /** Many items in its life or a perennial antecedent; null when the dossier does not say. */
  saturated: Schema.NullOr(Schema.Boolean),
  headlines: Schema.Array(EditorialCardItem),
  /** Up to ten items, W0 first; the client groups them by source. */
  evidence: Schema.Array(EditorialCardItem),
  /** Sources whose coverage was incomplete for this trend; one line on the card when any. */
  incompleteSources: Schema.Array(Schema.String),
  /** The operator's latest decision on this trend's threads, from editorial.sqlite. */
  decision: Schema.optionalKey(Schema.NullOr(EditorialCardDecision)),
  /**
   * A decision on the same topic (another trend key that matches it) recorded before this run's
   * cutoff: "ya decidido el <fecha>".
   */
  priorDecision: Schema.optionalKey(Schema.NullOr(EditorialCardDecision)),
});
export type EditorialTrendCard = typeof EditorialTrendCard.Type;

/** One judge's opinion of a card: an estimate by a model, never validated. */
export const EditorialJudgeOpinion = Schema.Struct({
  judge: Schema.String,
  model: Schema.NullOr(Schema.String),
  utility: Schema.NullOr(Schema.Finite),
  fit: Schema.NullOr(Schema.String),
  reason: Schema.String,
  angle: Schema.NullOr(Schema.String),
});
export type EditorialJudgeOpinion = typeof EditorialJudgeOpinion.Type;

export const EditorialJudgeView = Schema.Struct({
  /** Mean of the judges' utilities; null when none gave one. */
  utility: Schema.NullOr(Schema.Finite),
  opinions: Schema.Array(EditorialJudgeOpinion),
});
export type EditorialJudgeView = typeof EditorialJudgeView.Type;

/**
 * `hidden`: the operator has not recorded a decision with utility on this trend yet, so the
 * opinion stays closed. `none`: the dossier carries no judge opinion.
 */
export const EditorialGetJudgeOpinionResult = Schema.Union([
  Schema.TaggedStruct("shown", { view: EditorialJudgeView, decidedAt: IsoDateTime }),
  Schema.TaggedStruct("hidden", {}),
  Schema.TaggedStruct("none", {}),
]);
export type EditorialGetJudgeOpinionResult = typeof EditorialGetJudgeOpinionResult.Type;

export const EDITORIAL_CARD_EVIDENCE_MAX = 10;
export const EDITORIAL_CARD_HEADLINES_MAX = 2;

// Text of the card, shared by the app and the dossier file (`expediente.md`), so both say the
// same thing. Days are counted from the run's cutoff, the instant the engine stopped reading.

const MOVEMENT_TEXT: Readonly<Record<EditorialTrendMovement, string>> = {
  new: "nueva",
  weak: "señal débil",
  strong: "señal fuerte",
  rebound: "rebote",
  falling: "en caída",
  stable: "estable",
};

const movementText = (movement: EditorialTrendMovement): string => MOVEMENT_TEXT[movement];

const PERENNIAL_TEXT = "con antecedente perenne";

const ACTION_TEXT: Readonly<Record<EditorialCardDecision["action"], string>> = {
  accept: "aceptado",
  edit: "editado",
  reject: "rechazado",
};

export const decisionActionText = (action: EditorialCardDecision["action"]): string =>
  ACTION_TEXT[action];

const DAY_MS = 86_400_000;

/** Whole days from `day` (YYYY-MM-DD) to the cutoff's UTC day; null when either is unreadable. */
function daysBeforeCutoff(day: string, cutoffAt: string | null): number | null {
  if (cutoffAt === null) return null;
  const from = Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`);
  const to = Date.parse(`${cutoffAt.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/** "hace 4 días", "hace 1 día", "hoy"; the day itself when the cutoff is unknown. */
export function agoText(day: string, cutoffAt: string | null): string {
  const days = daysBeforeCutoff(day, cutoffAt);
  if (days === null) return `el ${day.slice(0, 10)}`;
  if (days <= 0) return "el día del corte";
  return days === 1 ? "hace 1 día" : `hace ${days} días`;
}

/** "señal débil, desde hace 4 días, con antecedente perenne": the second half of line 1. */
export function cardMovementText(
  card: Pick<EditorialTrendCard, "movement" | "since" | "perennial">,
  cutoffAt: string | null,
): string | null {
  const parts = [
    card.movement === null ? null : movementText(card.movement),
    card.since === null ? null : `desde ${agoText(card.since, cutoffAt)}`,
    card.perennial ? PERENNIAL_TEXT : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

/** "hn 1→3→0→5", "rss (parcial) 0→0→0→1", "wikipedia no usada", "total 3→4→?→9". */
export function curveRowText(row: EditorialCardCurveRow): string {
  if (row.status === "unused") return `${row.source} no usada`;
  const weeks = row.weeks.map((week) => (week === null ? "?" : String(week))).join("→");
  const source = row.status === "partial" ? `${row.source} (parcial)` : row.source;
  return weeks.length === 0 ? source : `${source} ${weeks}`;
}

export const sourceCountText = (count: number): string =>
  count === 1 ? "1 fuente" : `${count} fuentes`;

/** "apareció en hn hace 42 días": the first item among the comparable sources, not the origin. */
export const firstSourceText = (first: EditorialCardSourceDay, cutoffAt: string | null): string =>
  `apareció en ${first.source} ${agoText(first.day, cutoffAt)}`;

const TOPIC_BREAKS = [", ", " and ", " for ", " with ", " running ", " on "];

/**
 * An include topic in a few words: cut at the first break that leaves at least two words.
 * "AI coding agents and agent harnesses for developers" → "AI coding agents".
 */
export function shortTopic(topic: string): string {
  const trimmed = topic.trim();
  const cuts = TOPIC_BREAKS.map((separator) => trimmed.indexOf(separator))
    .filter((index) => index > 0 && trimmed.slice(0, index).trim().split(/\s+/).length >= 2)
    .sort((a, b) => a - b);
  return cuts.length === 0 ? trimmed : trimmed.slice(0, cuts[0]);
}

/** "encaja: AI coding agents (agent, tool)". */
export function fitText(fit: EditorialTrendCard["fit"]): string | null {
  if (fit.topic === null) return null;
  const terms = fit.terms.slice(0, 3);
  return `encaja: ${shortTopic(fit.topic)}${terms.length === 0 ? "" : ` (${terms.join(", ")})`}`;
}

export const saturatedText = (saturated: boolean | null): string | null =>
  saturated === null ? null : `saturado: ${saturated ? "sí" : "no"}`;

/** "ya decidido el 2026-09-30: aceptado". */
export const priorDecisionText = (decision: EditorialCardDecision): string =>
  `ya decidido el ${decision.decidedAt.slice(0, 10)}: ${decisionActionText(decision.action)}`;

export const incompleteCoverageText = (sources: ReadonlyArray<string>): string | null =>
  sources.length === 0 ? null : `cobertura incompleta en ${sources.join(", ")}`;
