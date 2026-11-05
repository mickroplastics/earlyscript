// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over files the pool and the labelling page write.
// `engine eval-editorial score` (protocol P1.1): P@5 with denominator 5 per arm, partition and
// labeler, paired bootstrap by topic family with Bonferroni bounds against the references,
// moving-block sensitivity, new versus recurrent families, coverage per source and agreement.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseCutoffList } from "./backtest.ts";
import {
  bootstrapDifference,
  bootstrapPrecision,
  blockDraws,
  cohenKappa,
  type Agreement,
  type Draws,
  familyUnit,
  type Interval,
  type LabelValue,
  type Slot,
  topSlots,
  unitDraws,
  weightedPrecision,
} from "./editorial-stats.ts";
import {
  assertSealed,
  captureEntries,
  type Rankings,
  readCardsJsonl,
  readLedger,
  readRankings,
  readUniverse,
  type TopicCard,
  type Universe,
} from "./editorial-eval.ts";
import { canonicalJson, sha256 } from "./hash.ts";

export const METRICS_SCHEMA_VERSION = "earlyscript.editorial-metrics/1";

export const SCORE_RULE = {
  precision:
    "P@5 = credits / 5 per arm and cutoff, averaged over cutoffs; an empty position, an unsure, pending or unlabelled card, the second and later positions of one family and (B6) a retrospective position whose headlines are all GitHub or Hugging Face items retrieved after the cutoff count 0",
  upper_bound: "the same with unsure, pending and unlabelled cards counted as yes",
  resolved_precision: "yes / (yes + no) among the counted positions with a yes or no label",
  bootstrap:
    "percentile intervals; units = topic families (all their appearances together; the empty positions of a cutoff form one unit), resampled with replacement and shared by every arm (paired); sensitivity: moving blocks of 7 calendar days (start drawn from first-6 to last day, ceil(span/7) blocks per replicate; a block over a gap adds nothing)",
  bonferroni: "differences against the references use alpha / number of references",
  new_families: "topics matching no family of the frozen dev registry (or of the dev cutoffs of this universe); precision over their positions",
  b6: "applies to the retro partition only, per arm: the support of that arm's own position (its 7-day items, or 5 most recent), never the shared card",
  duplicates: "a second position of the same opportunity (topic at that cutoff, merged only with that cutoff's data) counts 0; families serve only the bootstrap and new versus recurrent",
  labels: "only labels of this universe, or migrated from cards whose content is identical here",
  invalid_test: "a test partition is not valid when more than 10 % of its cards are unsure",
  source_evaluated:
    "a source is evaluated in a partition when, at every cutoff, both 7-day windows have at least 5 captured (complete or partial) days",
} as const;

export interface LabelRow {
  readonly topic_id?: string;
  readonly card_id?: string;
  readonly label: string;
  readonly labeled_at?: string;
}

export interface LabelSet {
  readonly labeler: string;
  readonly path: string;
  readonly universe_hash: string | null;
  readonly labels: ReadonlyMap<string, LabelValue>;
  /** Labels taken from cards of another universe whose content is identical here (U1-S2). */
  readonly migration: { readonly cards_hash: string; readonly accepted: number; readonly dropped: number } | null;
}

/** What a person or the judge saw: the same for every arm, so labels can move only if equal. */
const canonicalCard = (card: { cutoff: string; terms: ReadonlyArray<string>; headlines: ReadonlyArray<unknown> }) =>
  canonicalJson({ cutoff: card.cutoff, terms: card.terms, headlines: card.headlines });

const LABEL_VALUES = new Set(["yes", "no", "unsure", "pending"]);

/**
 * labels.json from the page, the judge or hn-labels: topic labels keyed by topic_id, the latest
 * wins. Labels of another universe are refused, unless `migrateFrom` gives the cards they were
 * made on (their sha256 must be the file's cards_hash): then a label moves only when its card
 * there is identical, cutoff, terms and headlines, to this universe's card for the same topic.
 */
export function readLabels(path: string, universe: Universe, migrateFrom?: string): LabelSet {
  const json = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    labeler?: string;
    universe_hash?: string | null;
    cards_hash?: string;
    labels?: ReadonlyArray<LabelRow & { unit?: string }>;
  };
  if (!json.labeler || !Array.isArray(json.labels)) {
    throw new Error(`${path}: expected { labeler, labels: [...] }`);
  }
  const rows = json.labels
    .filter((row) => row.unit === undefined || row.unit === "topic")
    .toSorted((a, b) => (a.labeled_at ?? "").localeCompare(b.labeled_at ?? ""));
  const labels = new Map<string, LabelValue>();
  for (const row of rows) {
    if (!row.topic_id) throw new Error(`${path}: a topic label without topic_id`);
    if (!LABEL_VALUES.has(row.label)) throw new Error(`${path}: unknown label ${row.label}`);
    labels.set(row.topic_id, row.label as LabelValue);
  }
  const base = { labeler: json.labeler, path, universe_hash: json.universe_hash ?? null };
  if (json.universe_hash === universe.universe_hash) return { ...base, labels, migration: null };
  if (!migrateFrom) {
    throw new Error(
      `${path} labels universe ${json.universe_hash ?? "none"}, not ${universe.universe_hash}; pass its cards to migrate`,
    );
  }
  const cardsHash = sha256(NodeFS.readFileSync(migrateFrom));
  if (cardsHash !== json.cards_hash) throw new Error(`${migrateFrom} is not the card set ${path} labels`);
  const here = new Map(universe.logical.topics.map((t) => [t.topic_id, canonicalCard(t)]));
  const same = new Set(
    readCardsJsonl(migrateFrom)
      .filter((card): card is TopicCard => card.unit === "topic")
      .filter((card) => here.get(card.topic_id) === canonicalCard(card))
      .map((card) => card.topic_id),
  );
  const moved = new Map([...labels].filter(([topic]) => same.has(topic)));
  return {
    ...base,
    labels: moved,
    migration: { cards_hash: cardsHash, accepted: moved.size, dropped: labels.size - moved.size },
  };
}

/** Files of one labeler (a test labelled in two sessions) merge in the given order. */
export function mergeLabelSets(sets: ReadonlyArray<LabelSet>): Array<LabelSet> {
  const byLabeler = new Map<string, LabelSet>();
  for (const set of sets) {
    const prev = byLabeler.get(set.labeler);
    byLabeler.set(
      set.labeler,
      prev
        ? {
            labeler: set.labeler,
            path: [prev.path, set.path].join(","),
            universe_hash: prev.universe_hash === set.universe_hash ? set.universe_hash : null,
            labels: new Map([...prev.labels, ...set.labels]),
            migration: set.migration ?? prev.migration,
          }
        : set,
    );
  }
  return [...byLabeler.values()];
}

export interface ScoreOptions {
  readonly universePath: string;
  readonly rankingsPath: string;
  readonly labelPaths: ReadonlyArray<string>;
  /** Labels of another universe, each with the cards it was made on (U1-S2). */
  readonly migrateLabels?: ReadonlyArray<{ readonly labels: string; readonly cards: string }>;
  readonly outDir: string;
  readonly dev?: ReadonlyArray<string>;
  readonly retro?: ReadonlyArray<string>;
  readonly prospective?: ReadonlyArray<string>;
  readonly candidates?: ReadonlyArray<string>;
  readonly references?: ReadonlyArray<string>;
  readonly ledgerPath?: string;
  readonly replicates?: number;
  readonly seed?: number;
  readonly blockDays?: number;
}

interface ArmMetrics {
  readonly cutoffs: number;
  readonly p_at_5: number | null;
  readonly p_at_5_upper: number | null;
  readonly resolved_precision: number | null;
  readonly coverage: number | null;
  /** Positions whose topic has a label (yes, no, unsure or pending) over all positions. */
  readonly labelled_share: number | null;
  /** yes over the labelled positions, unsure counting 0: precision where there is coverage. */
  readonly p_at_5_labelled: number | null;
  readonly per_cutoff: Record<string, number>;
  readonly counts: Record<string, number>;
  readonly duplicates_at_5: number;
  readonly families: number;
  readonly new_families: {
    readonly families: number;
    readonly positions: number;
    readonly precision: number | null;
  };
  readonly unseen_in_dev_and_train: {
    readonly families: number;
    readonly positions: number;
    readonly precision: number | null;
  };
  readonly recurrent_families: {
    readonly families: number;
    readonly positions: number;
    readonly precision: number | null;
  };
  readonly ci95_family: Interval;
  readonly ci95_blocks: Interval;
  readonly source_share_at_5: Record<string, number>;
  readonly incomplete_prev_week_share: number | null;
}

const round4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
const roundInterval = (i: Interval): Interval => ({ low: round4(i.low), high: round4(i.high) });

export async function runScore(options: ScoreOptions) {
  const universe = readUniverse(options.universePath);
  const rankings = readRankings(options.rankingsPath);
  if (rankings.universe_hash !== universe.universe_hash) {
    throw new Error("rankings.json belongs to another universe");
  }
  if (rankings.logical.top !== 5) throw new Error("P1.1 scores a top 5; this pool has another top");
  const labelSets = mergeLabelSets([
    ...options.labelPaths.map((path) => readLabels(path, universe)),
    ...(options.migrateLabels ?? []).map((m) => readLabels(m.labels, universe, m.cards)),
  ]);
  const replicates = options.replicates ?? 2000;
  const seed = options.seed ?? 20_261_105;
  const blockDays = options.blockDays ?? 7;
  const topics = new Map(universe.logical.topics.map((t) => [t.topic_id, t]));
  const cutoffInfo = new Map(universe.logical.cutoffs.map((c) => [c.cutoff, c]));
  const day = (c: string) => c.slice(0, 10);
  const partitions: Record<string, Array<string>> = {};
  const add = (name: string, list?: ReadonlyArray<string>) => {
    if (!list) return;
    const days = [...new Set(list.map(day))].toSorted();
    const absent = days.filter((d) => !cutoffInfo.has(d));
    if (absent.length > 0) throw new Error(`--${name} cutoffs not in the universe: ${absent.join(", ")}`);
    partitions[name] = days;
  };
  add("dev", options.dev);
  add("retro", options.retro);
  add("prospective", options.prospective);
  if (Object.keys(partitions).length === 0) partitions["all"] = [...cutoffInfo.keys()].toSorted();

  // A sealed evaluation is checked whole (U1-B2); prospective cutoffs then count only when their
  // capture closed after the freeze.
  const excluded: Array<{ cutoff: string; reason: string }> = [];
  if (partitions["prospective"] && !options.ledgerPath) {
    throw new Error("prospective cutoffs need --ledger");
  }
  if (options.ledgerPath) {
    const freeze = assertSealed(universe, rankings, options.ledgerPath);
    const captures = new Map(captureEntries(readLedger(options.ledgerPath)).map((e) => [e.cutoff_day, e]));
    partitions["prospective"] = (partitions["prospective"] ?? []).filter((cutoff) => {
      const capture = captures.get(cutoff);
      const reason = !capture
        ? "no capture entry in the ledger"
        : !(Date.parse(freeze.at) < Date.parse(capture.closed_at))
          ? `capture closed at ${capture.closed_at}, before the freeze at ${freeze.at}`
          : null;
      if (reason) excluded.push({ cutoff, reason });
      return reason === null;
    });
    if (!options.prospective) delete partitions["prospective"];
  }
  if (partitions["retro"] && partitions["prospective"]) {
    partitions["test"] = [...partitions["retro"], ...partitions["prospective"]].toSorted();
  }
  // New versus recurrent (U1-B4): against the frozen dev registry the pool imported, or the dev
  // cutoffs of this same universe; a test partition without either is refused.
  const registries = universe.logical.inputs.registries;
  const devFamilies = new Set(
    (partitions["dev"] ?? []).flatMap((c) =>
      universe.logical.topics.filter((t) => t.cutoff === c).map((t) => t.family_id),
    ),
  );
  const seenInDev = (topicId: string) => {
    const topic = topics.get(topicId)!;
    return registries["dev"] ? topic.seen_in["dev"]!.length > 0 : devFamilies.has(topic.family_id);
  };
  const seenInTrain = (topicId: string) =>
    registries["train"] ? topics.get(topicId)!.seen_in["train"]!.length > 0 : null;
  if ((partitions["retro"] || partitions["prospective"]) && !registries["dev"] && !partitions["dev"]) {
    throw new Error("test partitions need a dev family registry (pool --registry dev=…) or --dev cutoffs");
  }
  const configOf = new Map(rankings.logical.arms.map((a) => [a.name, a.config_hash]));
  const arms = rankings.logical.arms.map((a) => a.name);
  const candidates = options.candidates ?? [];
  const references = (options.references ?? arms).filter((a) => !candidates.includes(a));

  const slotsOf = (labels: LabelSet, arm: string, cutoffs: ReadonlyArray<string>, b6: boolean) =>
    cutoffs.flatMap((cutoff) => {
      const entry = rankings.logical.cutoffs[cutoff]?.[arm];
      if (!entry) throw new Error(`rankings have no ${arm} at ${cutoff}`);
      return topSlots(
        arm,
        cutoff,
        entry.top.map((e) => {
          const topic = topics.get(e.topic_id)!;
          // B6 per arm (U1-B3): the support of this arm's own position, not the shared card.
          const member = topic.members.find(
            (m) => m.config_hash === configOf.get(arm) && m.trend_id === e.trend_id,
          );
          if (!member) throw new Error(`${arm} at ${cutoff}: ${e.trend_id} is not in ${e.topic_id}`);
          return {
            topicId: e.topic_id,
            family: topic.family_id,
            label: labels.labels.get(e.topic_id) ?? null,
            unavailable: b6 && member.late_popularity_only,
          };
        }),
        rankings.logical.top,
      );
    });

  const result: Record<string, unknown> = {};
  for (const labels of labelSets) {
    const byPartition: Record<string, unknown> = {};
    for (const [name, cutoffs] of Object.entries(partitions)) {
      if (cutoffs.length === 0) {
        byPartition[name] = { cutoffs: 0 };
        continue;
      }
      const b6Cutoffs = new Set(
        name === "retro" || name === "test" ? (partitions["retro"] ?? []) : [],
      );
      const armSlots = new Map(
        arms.map((arm) => [
          arm,
          [
            ...slotsOf(
              labels,
              arm,
              cutoffs.filter((c) => b6Cutoffs.has(c)),
              true,
            ),
            ...slotsOf(
              labels,
              arm,
              cutoffs.filter((c) => !b6Cutoffs.has(c)),
              false,
            ),
          ],
        ]),
      );
      const allSlots = [...armSlots.values()].flat();
      const familyDraws = unitDraws(allSlots.map(familyUnit), replicates, seed);
      const blocks = blockDraws(cutoffs, blockDays, replicates, seed + 1);
      const perArm: Record<string, ArmMetrics> = {};
      for (const arm of arms) {
        perArm[arm] = armMetrics(armSlots.get(arm)!, {
          familyDraws,
          blocks,
          seenInDev: name === "dev" ? () => false : seenInDev,
          seenInTrain,
          universe,
        });
      }
      const pointOf = (arm: string) => perArm[arm]!.p_at_5 ?? -1;
      const bestReference =
        references.toSorted((a, b) => pointOf(b) - pointOf(a) || (a < b ? -1 : 1))[0] ?? null;
      const comparisons = candidates.map((candidate) => ({
        candidate,
        best_reference: bestReference,
        against: references.map((reference) => {
          const a = armSlots.get(candidate)!;
          const b = armSlots.get(reference)!;
          return {
            reference,
            difference: round4((perArm[candidate]!.p_at_5 ?? 0) - (perArm[reference]!.p_at_5 ?? 0)),
            ci95_family: roundInterval(bootstrapDifference(a, b, familyDraws, familyUnit)),
            ci_bonferroni_family: roundInterval(
              bootstrapDifference(
                a,
                b,
                familyDraws,
                familyUnit,
                0.05 / Math.max(1, references.length),
              ),
            ),
            ci95_blocks: roundInterval(bootstrapDifference(a, b, blocks, (s) => s.cutoff)),
          };
        }),
      }));
      // Cards of the partition: each topic once (P1.1 rule 1: the topic at its cutoff).
      const cards = universe.logical.topics.filter((t) => cutoffs.includes(t.cutoff));
      const status = { yes: 0, no: 0, unsure: 0, pending: 0, unlabelled: 0 };
      for (const t of cards) {
        const label = labels.labels.get(t.topic_id);
        status[label ?? "unlabelled"]++;
      }
      byPartition[name] = {
        cutoffs: cutoffs.length,
        cutoff_days: cutoffs,
        cards: cards.length,
        card_labels: status,
        unsure_share: cards.length === 0 ? null : round4(status.unsure / cards.length),
        valid: name === "dev" || cards.length === 0 || status.unsure / cards.length <= 0.1,
        families: new Set(cards.map((t) => t.family_id)).size,
        arms: perArm,
        best_reference: bestReference,
        comparisons,
        coverage: coverageReport(universe, cutoffs),
      };
    }
    result[labels.labeler] = byPartition;
  }

  const agreement: Array<{ a: string; b: string } & Agreement> = [];
  for (let i = 0; i < labelSets.length; i++) {
    for (let j = i + 1; j < labelSets.length; j++) {
      const k = cohenKappa(labelSets[i]!.labels, labelSets[j]!.labels);
      agreement.push({
        a: labelSets[i]!.labeler,
        b: labelSets[j]!.labeler,
        ...k,
        agreement: round4(k.agreement),
        kappa: round4(k.kappa),
      });
    }
  }
  const logical = {
    rule: SCORE_RULE,
    universe_hash: universe.universe_hash,
    rankings_hash: rankings.rankings_hash,
    labels: labelSets.map((l) => ({
      labeler: l.labeler,
      sha256: l.path
        .split(",")
        .map((path) => sha256(NodeFS.readFileSync(path)))
        .join(","),
      universe_hash: l.universe_hash,
      universe_match: l.universe_hash === universe.universe_hash,
      migration: l.migration,
      topics: l.labels.size,
      unknown_topics: [...l.labels.keys()].filter((id) => !topics.has(id)).length,
    })),
    partitions,
    excluded_prospective: excluded,
    candidates,
    references,
    bootstrap: { replicates, seed, block_days: blockDays },
    results: result,
    agreement,
  };
  const metrics = {
    schema_version: METRICS_SCHEMA_VERSION,
    metrics_hash: sha256(canonicalJson(logical)),
    created_at: new Date().toISOString(),
    logical,
  };
  NodeFS.mkdirSync(options.outDir, { recursive: true });
  const metricsPath = NodePath.join(options.outDir, "metrics.json");
  const reportPath = NodePath.join(options.outDir, "report.md");
  NodeFS.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  NodeFS.writeFileSync(
    reportPath,
    renderReport(metrics.logical, metrics.metrics_hash, universe, rankings),
  );
  return { metricsPath, reportPath, metrics };
}

function armMetrics(
  slots: ReadonlyArray<Slot>,
  ctx: {
    readonly familyDraws: Draws;
    readonly blocks: Draws;
    readonly seenInDev: (topicId: string) => boolean;
    readonly seenInTrain: (topicId: string) => boolean | null;
    readonly universe: Universe;
  },
): ArmMetrics {
  const one = () => 1;
  const counts: Record<string, number> = {
    yes: 0,
    no: 0,
    unsure: 0,
    pending: 0,
    unlabelled: 0,
    empty: 0,
    duplicate: 0,
    unavailable_at_cutoff: 0,
  };
  for (const s of slots) {
    if (s.zero) counts[s.zero]!++;
    else counts[s.label ?? "unlabelled"]!++;
  }
  const perCutoff: Record<string, number> = {};
  for (const cutoff of [...new Set(slots.map((s) => s.cutoff))].toSorted()) {
    perCutoff[cutoff] = round4(
      weightedPrecision(
        slots.filter((s) => s.cutoff === cutoff),
        one,
      ),
    )!;
  }
  const counted = slots.filter((s) => s.zero === null);
  const labelled = slots.filter((s) => s.label !== null && s.zero !== "empty");
  const resolved = counted.filter((s) => s.label === "yes" || s.label === "no");
  const subset = (keep: (s: Slot) => boolean) => {
    const xs = counted.filter((s) => s.family !== null && keep(s));
    return {
      families: new Set(xs.map((s) => s.family)).size,
      positions: xs.length,
      precision: round4(weightedPrecision(xs, one)),
    };
  };
  const topics = new Map(ctx.universe.logical.topics.map((t) => [t.topic_id, t]));
  const cutoffs = new Map(ctx.universe.logical.cutoffs.map((c) => [c.cutoff, c]));
  const share: Record<string, number> = {};
  let incomplete = 0;
  const filled = slots.filter((s) => s.topicId !== null);
  for (const s of filled) {
    const t = topics.get(s.topicId!)!;
    const coverage = cutoffs.get(s.cutoff)!.coverage;
    for (const source of Object.keys(t.items_7d_by_source))
      share[source] = (share[source] ?? 0) + 1;
    const dependsOnIncomplete = Object.keys(t.items_7d_by_source).some((source) => {
      const prev = coverage[source]?.prev_7d;
      return prev !== undefined && prev.complete + prev.partial < 7;
    });
    if (dependsOnIncomplete) incomplete++;
  }
  return {
    cutoffs: Object.keys(perCutoff).length,
    p_at_5: round4(weightedPrecision(slots, one)),
    p_at_5_upper: round4(weightedPrecision(slots, one, "upper")),
    resolved_precision: round4(weightedPrecision(resolved, one)),
    coverage: round4(slots.length === 0 ? null : filled.length / slots.length),
    labelled_share: round4(slots.length === 0 ? null : labelled.length / slots.length),
    p_at_5_labelled: round4(weightedPrecision(labelled, one)),
    per_cutoff: perCutoff,
    counts,
    duplicates_at_5: counts["duplicate"]!,
    families: new Set(filled.map((s) => s.family)).size,
    new_families: subset((s) => !ctx.seenInDev(s.topicId!)),
    recurrent_families: subset((s) => ctx.seenInDev(s.topicId!)),
    unseen_in_dev_and_train: subset(
      (s) => !ctx.seenInDev(s.topicId!) && ctx.seenInTrain(s.topicId!) === false,
    ),
    ci95_family: roundInterval(bootstrapPrecision(slots, ctx.familyDraws, familyUnit)),
    ci95_blocks: roundInterval(bootstrapPrecision(slots, ctx.blocks, (s) => s.cutoff)),
    source_share_at_5: Object.fromEntries(
      Object.entries(share)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, round4(v / Math.max(1, filled.length))!]),
    ),
    incomplete_prev_week_share: round4(filled.length === 0 ? null : incomplete / filled.length),
  };
}

function coverageReport(universe: Universe, cutoffs: ReadonlyArray<string>) {
  const rows = universe.logical.cutoffs.filter((c) => cutoffs.includes(c.cutoff));
  const sources = [...new Set(rows.flatMap((r) => Object.keys(r.coverage)))].toSorted();
  return Object.fromEntries(
    sources.map((source) => {
      const windows = rows.map((r) => r.coverage[source]);
      const captured = (w: { complete: number; partial: number } | undefined) =>
        w === undefined ? 0 : w.complete + w.partial;
      const evaluated = windows.every(
        (w) => w && captured(w.last_7d) >= 5 && captured(w.prev_7d) >= 5,
      );
      const sum = (pick: (w: NonNullable<(typeof windows)[number]>) => number) =>
        windows.reduce((acc, w) => acc + (w ? pick(w) : 0), 0);
      return [
        source,
        {
          evaluated,
          captured_days_last_7d: sum((w) => captured(w.last_7d)),
          missing_days_last_7d: sum((w) => w.last_7d.missing),
          unavailable_days_last_7d: sum((w) => w.last_7d.unavailable + w.last_7d.rate_limited),
          items_last_7d: sum((w) => w.last_7d.items),
          possible_days: rows.length * 7,
        },
      ];
    }),
  );
}

const pct = (x: unknown) => (typeof x === "number" ? x.toFixed(3) : "n/d");
const ivl = (i: Interval | undefined) =>
  i && i.low !== null ? `[${pct(i.low)}, ${pct(i.high)}]` : "n/d";

function renderReport(
  logical: {
    readonly results: Record<string, unknown>;
    readonly agreement: ReadonlyArray<{ a: string; b: string } & Agreement>;
    readonly excluded_prospective: ReadonlyArray<{ cutoff: string; reason: string }>;
  },
  hash: string,
  universe: Universe,
  rankings: Rankings,
): string {
  const lines: Array<string> = [
    "# Evaluación editorial (protocolo P1.1)",
    "",
    `- Universo: \`${universe.universe_hash}\` (${universe.logical.topics.length} oportunidades (tema y corte), ${universe.logical.families.length} familias)`,
    `- Rankings: \`${rankings.rankings_hash}\`; métricas: \`${hash}\``,
    `- Brazos: ${rankings.logical.arms.map((a) => `${a.name} (${a.method})`).join(", ")}`,
    "- P@5 con denominador 5: vacíos, «no sé», sin etiqueta, segunda aparición de una familia y (solo retrospectiva) puestos B6 valen 0. «Cota sup.» cuenta las dudas como sí.",
    "- IC 95 % por bootstrap pareado de familias de temas; sensibilidad con bloques móviles de cortes. Diferencias contra referencias con límite de Bonferroni.",
    "",
  ];
  if (logical.excluded_prospective.length > 0) {
    lines.push("Cortes prospectivos excluidos:", "");
    for (const e of logical.excluded_prospective) lines.push(`- ${e.cutoff}: ${e.reason}`);
    lines.push("");
  }
  for (const [labeler, byPartition] of Object.entries(logical.results)) {
    for (const [name, raw] of Object.entries(byPartition as Record<string, any>)) {
      const p = raw as any;
      if (!p.cutoffs) continue;
      lines.push(
        `## ${labeler} · ${name} (${p.cutoffs} cortes, ${p.cards} tarjetas, ${p.families} familias)`,
        "",
        `Etiquetas de las tarjetas: sí ${p.card_labels.yes}, no ${p.card_labels.no}, no sé ${p.card_labels.unsure}, pendiente ${p.card_labels.pending}, sin juicio ${p.card_labels.unlabelled}.${p.valid ? "" : " **Partición no válida: más del 10 % de «no sé».**"}`,
        "",
        "| Brazo | P@5 | IC 95 % familias | IC 95 % bloques | Cota sup. | Prec. resueltas | P@5 con etiqueta (puestos etiquetados) | Cobertura | Duplicados | B6 | Familias nuevas (P, puestos) | Dep. semana previa incompleta |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const [arm, m] of Object.entries(p.arms as Record<string, ArmMetrics>)) {
        lines.push(
          `| ${arm} | ${pct(m.p_at_5)} | ${ivl(m.ci95_family)} | ${ivl(m.ci95_blocks)} | ${pct(m.p_at_5_upper)} | ${pct(m.resolved_precision)} | ${pct(m.p_at_5_labelled)} (${pct(m.labelled_share)}) | ${pct(m.coverage)} | ${m.duplicates_at_5} | ${m.counts["unavailable_at_cutoff"]} | ${pct(m.new_families.precision)} (${m.new_families.positions}) | ${pct(m.incomplete_prev_week_share)} |`,
        );
      }
      lines.push("", `Mejor referencia (punto): ${p.best_reference ?? "n/d"}.`, "");
      for (const c of p.comparisons as Array<any>) {
        lines.push(
          `Candidato ${c.candidate}:`,
          "",
          "| Contra | Diferencia | IC 95 % familias | Bonferroni | IC 95 % bloques |",
          "| --- | --- | --- | --- | --- |",
        );
        for (const a of c.against) {
          lines.push(
            `| ${a.reference} | ${pct(a.difference)} | ${ivl(a.ci95_family)} | ${ivl(a.ci_bonferroni_family)} | ${ivl(a.ci95_blocks)} |`,
          );
        }
        lines.push("");
      }
      lines.push(
        "Cobertura por fuente (ventana de 7 días antes de cada corte):",
        "",
        "| Fuente | Evaluada | Días capturados | Días sin captura | Días no disponibles | Ítems |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const [source, c] of Object.entries(p.coverage as Record<string, any>)) {
        lines.push(
          `| ${source} | ${c.evaluated ? "sí" : "no evaluada"} | ${c.captured_days_last_7d}/${c.possible_days} | ${c.missing_days_last_7d} | ${c.unavailable_days_last_7d} | ${c.items_last_7d} |`,
        );
      }
      lines.push("");
    }
  }
  if (logical.agreement.length > 0) {
    lines.push(
      "## Acuerdo entre etiquetadores",
      "",
      "| A | B | n | Acuerdo | κ | Excluidas (dudas) |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const a of logical.agreement) {
      lines.push(
        `| ${a.a} | ${a.b} | ${a.n} | ${pct(a.agreement)} | ${pct(a.kappa)} | ${a.excluded} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export { parseCutoffList };
