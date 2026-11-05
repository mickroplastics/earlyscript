// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over files the pool and the labelling page write.
// `engine eval-editorial score` (protocol P1.1): P@5 with denominator 5 per arm, partition and
// labeler, paired bootstrap by topic family with Bonferroni bounds against the references,
// moving-block sensitivity, new versus recurrent families, coverage per source and agreement.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseCutoffList } from "./backtest.ts";
import {
  type Credit,
  slotCredit,
  coreCredit,
  type Grade,
  gradedCredit,
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
  assertCheckout,
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
  graded:
    "G@5 = (core 1 + adjacent 0.5) / 5 per arm and cutoff, with the same zero rules, bootstrap and Bonferroni; null when a yes has no grade (labels from before grading count for P@5 only); core_share = core positions / 5",
  upper_bound: "the same with unsure, pending and unlabelled cards counted as yes",
  resolved_precision: "yes / (yes + no) among the counted positions with a yes or no label",
  bootstrap:
    "percentile intervals; units = topic families (all their appearances together; the empty positions of a cutoff form one unit), resampled with replacement and shared by every arm (paired); sensitivity: moving blocks of 7 calendar days (start drawn from first-6 to last day, ceil(span/7) blocks per replicate; a block over a gap adds nothing)",
  bonferroni: "differences against the references use alpha / number of references",
  new_families:
    "topics matching no family of the frozen dev registry (or of the dev cutoffs of this universe); precision over their positions",
  b6: "applies to the retro partition only, per arm: the support of that arm's own position (its 7-day items, or 5 most recent), never the shared card",
  duplicates:
    "a second position of the same opportunity (topic at that cutoff, merged only with that cutoff's data) counts 0; families serve only the bootstrap and new versus recurrent",
  labels: "only labels of this universe, or migrated from cards whose content is identical here",
  invalid_test:
    "valid = every card answered (no unlabelled or pending) and at most 10 % unsure; unsure_limit_met and consistency_met (at least 8 of 10 blind repeats agree on core against the rest) are reported apart",
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
  /** Grade of each yes (core or adjacent); old labels without grade count for P@5 only. */
  readonly grades: ReadonlyMap<string, Grade>;
  /** Blind repeats (a card_id other than the topic's own): topic -> the repeat's answer. */
  readonly repeats: ReadonlyMap<string, { label: LabelValue; grade: Grade | null }>;
  /** Labels taken from cards of another universe whose content is identical here (U1-S2). */
  readonly migration: {
    readonly cards_hash: string;
    readonly accepted: number;
    readonly dropped: number;
  } | null;
}

/** What a person or the judge saw: the same for every arm, so labels can move only if equal. */
const canonicalCard = (card: {
  cutoff: string;
  terms: ReadonlyArray<string>;
  headlines: ReadonlyArray<unknown>;
}) => canonicalJson({ cutoff: card.cutoff, terms: card.terms, headlines: card.headlines });

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
    labels?: ReadonlyArray<LabelRow & { unit?: string; grade?: string | null }>;
    rubric_sha256?: string;
  };
  if (!json.labeler || !Array.isArray(json.labels)) {
    throw new Error(`${path}: expected { labeler, labels: [...] }`);
  }
  const rows = json.labels
    .filter((row) => row.unit === undefined || row.unit === "topic")
    .toSorted((a, b) => (a.labeled_at ?? "").localeCompare(b.labeled_at ?? ""));
  const labels = new Map<string, LabelValue>();
  const grades = new Map<string, Grade>();
  const repeats = new Map<string, { label: LabelValue; grade: Grade | null }>();
  const cardOf = new Map(universe.logical.topics.map((t) => [t.topic_id, t.card_id]));
  for (const row of rows) {
    if (!row.topic_id) throw new Error(`${path}: a topic label without topic_id`);
    // A graded judge may write core/adjacent as the label itself.
    const graded = row.label === "core" || row.label === "adjacent" ? row.label : null;
    const label = graded ? "yes" : row.label;
    if (!LABEL_VALUES.has(label)) throw new Error(`${path}: unknown label ${row.label}`);
    const grade = graded ?? row.grade ?? null;
    if (grade !== null && grade !== "core" && grade !== "adjacent") {
      throw new Error(`${path}: unknown grade ${grade}`);
    }
    if (grade !== null && label !== "yes") throw new Error(`${path}: a grade on a ${label} label`);
    // A blind repeat carries the topic with another card_id: it never enters the metrics.
    if (row.card_id && cardOf.has(row.topic_id) && row.card_id !== cardOf.get(row.topic_id)) {
      repeats.set(row.topic_id, { label: label as LabelValue, grade });
      continue;
    }
    labels.set(row.topic_id, label as LabelValue);
    if (grade) grades.set(row.topic_id, grade);
    else grades.delete(row.topic_id);
  }
  const base = { labeler: json.labeler, path, universe_hash: json.universe_hash ?? null };
  if (json.universe_hash === universe.universe_hash) {
    return { ...base, labels, grades, repeats, migration: null };
  }
  if (!migrateFrom) {
    throw new Error(
      `${path} labels universe ${json.universe_hash ?? "none"}, not ${universe.universe_hash}; pass its cards to migrate`,
    );
  }
  const cardsHash = sha256(NodeFS.readFileSync(migrateFrom));
  if (cardsHash !== json.cards_hash)
    throw new Error(`${migrateFrom} is not the card set ${path} labels`);
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
    grades: new Map([...grades].filter(([topic]) => same.has(topic))),
    repeats: new Map([...repeats].filter(([topic]) => same.has(topic))),
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
            repeats: new Map([...prev.repeats, ...set.repeats]),
            grades: new Map([
              ...[...prev.grades].filter(([topic]) => !set.labels.has(topic)),
              ...set.grades,
            ]),
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
  /** More named partitions (septiembre, octubre-noviembre…), reported like the others. */
  readonly partitions?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly candidates?: ReadonlyArray<string>;
  readonly references?: ReadonlyArray<string>;
  readonly ledgerPath?: string;
  /** Also require the checkout to be the frozen git tree (the command line sets it). */
  readonly checkout?: boolean;
  readonly replicates?: number;
  readonly seed?: number;
  readonly blockDays?: number;
}

/**
 * Binary precision over the positions of some families, conditional (not over 5): doubts,
 * duplicates and B6 count 0. Not evaluable without positions or without the registry it needs.
 */
interface FamilySubset {
  readonly families: number;
  readonly positions: number;
  readonly numerator: number;
  readonly precision: number | null;
  readonly status:
    | "evaluable"
    | "no evaluable: sin puestos"
    | "no evaluable: falta el registro de entrenamiento";
}

interface ArmMetrics {
  readonly cutoffs: number;
  readonly p_at_5: number | null;
  readonly p_at_5_upper: number | null;
  /** G@5: core 1, adjacent 0.5 per position over 5; null when some yes has no grade. */
  readonly g_at_5: number | null;
  readonly g_ci95_family: Interval;
  readonly g_ci95_blocks: Interval;
  /** Positions with a core yes over all positions. */
  readonly core_share: number | null;
  /** Descriptive sensitivity of G@5 to the adjacent weight (0.3 and 0.7 instead of 0.5). */
  readonly g_at_5_adjacent_0_3: number | null;
  readonly g_at_5_adjacent_0_7: number | null;
  /** G@5 with the positions of the family that adds the most graded credit set to 0. */
  readonly g_at_5_without_top_family: {
    readonly family: string | null;
    readonly value: number | null;
  };
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
  readonly new_families: FamilySubset;
  readonly unseen_in_dev_and_train: FamilySubset;
  readonly recurrent_families: FamilySubset;
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
    if (absent.length > 0)
      throw new Error(`--${name} cutoffs not in the universe: ${absent.join(", ")}`);
    partitions[name] = days;
  };
  add("dev", options.dev);
  add("retro", options.retro);
  add("prospective", options.prospective);
  for (const [name, days] of Object.entries(options.partitions ?? {})) add(name, days);
  if (Object.keys(partitions).length === 0) partitions["all"] = [...cutoffInfo.keys()].toSorted();

  // A sealed evaluation is checked whole (U1-B2); prospective cutoffs then count only when their
  // capture closed after the freeze.
  const excluded: Array<{ cutoff: string; reason: string }> = [];
  if (partitions["prospective"] && !options.ledgerPath) {
    throw new Error("prospective cutoffs need --ledger");
  }
  if (options.ledgerPath) {
    const freeze = assertSealed(universe, rankings, options.ledgerPath);
    if (options.checkout) assertCheckout(freeze);
    const captures = new Map(
      captureEntries(readLedger(options.ledgerPath)).map((e) => [e.cutoff_day, e]),
    );
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
  if (
    (partitions["retro"] || partitions["prospective"]) &&
    !registries["dev"] &&
    !partitions["dev"]
  ) {
    throw new Error(
      "test partitions need a dev family registry (pool --registry dev=…) or --dev cutoffs",
    );
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
          if (!member)
            throw new Error(`${arm} at ${cutoff}: ${e.trend_id} is not in ${e.topic_id}`);
          return {
            topicId: e.topic_id,
            family: topic.family_id,
            label: labels.labels.get(e.topic_id) ?? null,
            grade: labels.grades.get(e.topic_id) ?? null,
            unavailable: b6 && member.late_popularity_only,
            // U1-B1 (second verification): only a direct match within the arm is a duplicate.
            ...(e.duplicate_of !== undefined ? { duplicate: e.duplicate_of !== null } : {}),
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
      // B6 applies to every retrospective cutoff, whatever partition reports it.
      const b6Cutoffs = new Set(partitions["retro"] ?? []);
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
          trainRegistry: Boolean(registries["train"]),
          universe,
        });
      }
      const pointOf = (arm: string) => perArm[arm]!.p_at_5 ?? -1;
      const bestReference =
        references.toSorted((a, b) => pointOf(b) - pointOf(a) || (a < b ? -1 : 1))[0] ?? null;
      const gOf = (arm: string) => perArm[arm]!.g_at_5 ?? -1;
      const bestReferenceG =
        references.toSorted((a, b) => gOf(b) - gOf(a) || (a < b ? -1 : 1))[0] ?? null;
      const comparisons = candidates.map((candidate) => ({
        candidate,
        best_reference: bestReference,
        best_reference_g: bestReferenceG,
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
            g_difference:
              perArm[candidate]!.g_at_5 === null || perArm[reference]!.g_at_5 === null
                ? null
                : round4(perArm[candidate]!.g_at_5! - perArm[reference]!.g_at_5!),
            g_difference_without_top_family: differenceWithoutTopFamily(a, b),
            g_ci_bonferroni_family: roundInterval(
              bootstrapDifference(
                a,
                b,
                familyDraws,
                familyUnit,
                0.05 / Math.max(1, references.length),
                gradedCredit,
              ),
            ),
          };
        }),
      }));
      const partitionConsistency = consistency(labels, cutoffs, topics);
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
        // P1.3 (Sol, motor-v2 S3): valid needs every card answered and at most 10 % unsure;
        // the labeler's self-consistency is reported apart.
        all_answered: cards.length > 0 && status.unlabelled === 0 && status.pending === 0,
        unsure_limit_met: cards.length > 0 && status.unsure / cards.length <= 0.1,
        valid:
          cards.length > 0 &&
          status.unlabelled === 0 &&
          status.pending === 0 &&
          status.unsure / cards.length <= 0.1,
        consistency: partitionConsistency,
        consistency_met: partitionConsistency.met,
        families: new Set(cards.map((t) => t.family_id)).size,
        arms: perArm,
        best_reference: bestReference,
        best_reference_g: bestReferenceG,
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
    readonly trainRegistry: boolean;
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
  const subset = (keep: (s: Slot) => boolean, needsTrain = false): FamilySubset => {
    const xs = slots.filter((s) => s.family !== null && keep(s));
    const status =
      needsTrain && !ctx.trainRegistry
        ? "no evaluable: falta el registro de entrenamiento"
        : xs.length === 0
          ? "no evaluable: sin puestos"
          : "evaluable";
    return {
      families: new Set(xs.map((s) => s.family)).size,
      positions: xs.length,
      numerator: xs.reduce((sum, s) => sum + slotCredit(s, "strict"), 0),
      precision: status === "evaluable" ? round4(weightedPrecision(xs, one)) : null,
      status,
    };
  };
  const top = topFamily(slots, gradedCredit);
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
    g_at_5: round4(weightedPrecision(slots, one, gradedCredit)),
    g_ci95_family: roundInterval(
      bootstrapPrecision(slots, ctx.familyDraws, familyUnit, 0.05, gradedCredit),
    ),
    g_ci95_blocks: roundInterval(
      bootstrapPrecision(slots, ctx.blocks, (s) => s.cutoff, 0.05, gradedCredit),
    ),
    core_share: round4(weightedPrecision(slots, one, coreCredit)),
    g_at_5_adjacent_0_3: round4(weightedPrecision(slots, one, gradedWith(0.3))),
    g_at_5_adjacent_0_7: round4(weightedPrecision(slots, one, gradedWith(0.7))),
    g_at_5_without_top_family: {
      family: top,
      value: round4(weightedPrecision(slots, one, (x) => (x.family === top ? 0 : gradedCredit(x)))),
    },
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
      true,
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

/** G@5 credit with another adjacent weight (sensitivity only). */
const gradedWith =
  (adjacent: number): Credit =>
  (slot) => {
    const credit = gradedCredit(slot);
    return credit === 0.5 ? adjacent : credit;
  };

/** The family whose positions add the most credit (ties: smaller id); null without credit. */
function topFamily(slots: ReadonlyArray<Slot>, credit: Credit): string | null {
  const byFamily = new Map<string, number>();
  for (const s of slots) {
    if (s.family === null) continue;
    const c = credit(s);
    if (Number.isNaN(c)) return null;
    byFamily.set(s.family, (byFamily.get(s.family) ?? 0) + c);
  }
  const best = [...byFamily]
    .filter(([, v]) => v > 0)
    .toSorted(([fa, a], [fb, b]) => b - a || (fa < fb ? -1 : 1))[0];
  return best ? best[0] : null;
}

/**
 * G@5 difference a - b with the family that adds the most to it zeroed in both arms (Opus U4):
 * a gain that rests on one recurrent family is not a ranking that finds topics.
 */
function differenceWithoutTopFamily(a: ReadonlyArray<Slot>, b: ReadonlyArray<Slot>) {
  const contribution = new Map<string, number>();
  for (const [slots, sign] of [
    [a, 1],
    [b, -1],
  ] as const) {
    for (const s of slots) {
      if (s.family === null) continue;
      const c = gradedCredit(s);
      if (Number.isNaN(c)) return { family: null, value: null };
      contribution.set(s.family, (contribution.get(s.family) ?? 0) + sign * c);
    }
  }
  const family =
    [...contribution]
      .filter(([, v]) => v > 0)
      .toSorted(([fa, x], [fb, y]) => y - x || (fa < fb ? -1 : 1))[0]?.[0] ?? null;
  const without: Credit = (s) => (s.family === family ? 0 : gradedCredit(s));
  const ga = weightedPrecision(a, () => 1, without);
  const gb = weightedPrecision(b, () => 1, without);
  return { family, value: ga === null || gb === null ? null : round4(ga - gb) };
}

/**
 * Self-consistency on the blind repeats (P1, Opus M3): the first showing scores, the repeat only
 * measures agreement: binary (yes, no, unsure), graded (core, adjacent, no, unsure) and core
 * against the rest.
 */
function consistency(
  labels: LabelSet,
  cutoffs: ReadonlyArray<string>,
  topics: ReadonlyMap<string, { readonly cutoff: string }>,
) {
  const pairs = [...labels.repeats].filter(
    ([topic]) => labels.labels.has(topic) && cutoffs.includes(topics.get(topic)?.cutoff ?? ""),
  );
  const classOf = (label: LabelValue, grade: Grade | null) =>
    label === "yes" ? (grade ?? "yes") : label;
  const agree = (f: (label: LabelValue, grade: Grade | null) => string) =>
    pairs.length === 0
      ? null
      : round4(
          pairs.filter(
            ([topic, r]) =>
              f(labels.labels.get(topic)!, labels.grades.get(topic) ?? null) ===
              f(r.label, r.grade),
          ).length / pairs.length,
        );
  const coreAgreements = pairs.filter(
    ([topic, r]) =>
      (classOf(labels.labels.get(topic)!, labels.grades.get(topic) ?? null) === "core") ===
      (classOf(r.label, r.grade) === "core"),
  ).length;
  return {
    pairs: pairs.length,
    /** Opus M3: at least 8 of 10 repeats agree on core against the rest. */
    met: pairs.length >= 10 && coreAgreements >= 0.8 * pairs.length,
    binary: agree((label) => label),
    graded: agree(classOf),
    core_vs_rest: agree((label, grade) => (classOf(label, grade) === "core" ? "core" : "rest")),
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
    "- P@5 con denominador 5: vacíos, «no sé», sin etiqueta, segunda aparición de la misma oportunidad (tema y corte) y, solo en la retrospectiva, puestos B6 del propio brazo valen 0. «Cota sup.» cuenta las dudas como sí. «P@5 con etiqueta» divide entre los puestos que tienen etiqueta (cobertura entre paréntesis).",
    "- G@5 (etiqueta graduada): núcleo 1, adyacente 0,5 por puesto, sobre 5, con las mismas reglas de ceros, IC y Bonferroni; vacío si algún sí no tiene grado (etiquetas anteriores a la graduación). «Núcleo»: puestos con sí de núcleo sobre 5.",
    "- IC 95 % por bootstrap pareado de familias de temas; sensibilidad con bloques móviles de 7 días de calendario. Diferencias contra referencias con límite de Bonferroni. Familias nuevas: sin coincidencia con el registro congelado de desarrollo.",
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
        `Etiquetas de las tarjetas: sí ${p.card_labels.yes}, no ${p.card_labels.no}, no sé ${p.card_labels.unsure}, pendiente ${p.card_labels.pending}, sin juicio ${p.card_labels.unlabelled}. Todas respondidas: ${p.all_answered ? "sí" : "no"}; «no sé» ≤ 10 %: ${p.unsure_limit_met ? "sí" : "no"}; válida: ${p.valid ? "sí" : "**no**"}; consistencia ≥ 8/10: ${p.consistency_met ? "sí" : "no"}.`,
        "",
        "| Brazo | P@5 | IC 95 % familias | IC 95 % bloques | G@5 | IC 95 % familias (G) | Núcleo | Cota sup. | Prec. resueltas | P@5 con etiqueta (puestos etiquetados) | Cobertura | Duplicados | B6 | Familias nuevas (P, puestos) | Dep. semana previa incompleta |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const [arm, m] of Object.entries(p.arms as Record<string, ArmMetrics>)) {
        lines.push(
          `| ${arm} | ${pct(m.p_at_5)} | ${ivl(m.ci95_family)} | ${ivl(m.ci95_blocks)} | ${pct(m.g_at_5)} | ${ivl(m.g_ci95_family)} | ${pct(m.core_share)} | ${pct(m.p_at_5_upper)} | ${pct(m.resolved_precision)} | ${pct(m.p_at_5_labelled)} (${pct(m.labelled_share)}) | ${pct(m.coverage)} | ${m.duplicates_at_5} | ${m.counts["unavailable_at_cutoff"]} | ${pct(m.new_families.precision)} (${m.new_families.positions}) | ${pct(m.incomplete_prev_week_share)} |`,
        );
      }
      lines.push(
        "",
        `Mejor referencia (punto): P@5 ${p.best_reference ?? "n/d"}, G@5 ${p.best_reference_g ?? "n/d"}.`,
        "",
        "| Brazo | G@5 (adyacente 0,3) | G@5 (adyacente 0,7) | G@5 sin la familia que más aporta | Familias nuevas (dev y entrenamiento): aciertos / puestos, familias, P |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const [arm, m] of Object.entries(p.arms as Record<string, ArmMetrics>)) {
        const n = m.unseen_in_dev_and_train;
        lines.push(
          `| ${arm} | ${pct(m.g_at_5_adjacent_0_3)} | ${pct(m.g_at_5_adjacent_0_7)} | ${pct(m.g_at_5_without_top_family.value)} | ${n.status === "evaluable" ? `${n.numerator} / ${n.positions}, ${n.families}, ${pct(n.precision)}` : n.status} |`,
        );
      }
      const c = p.consistency;
      lines.push(
        "",
        c.pairs > 0
          ? `Consistencia de ${labeler} consigo mismo (${c.pairs} repeticiones a ciegas, fuera de las métricas): binaria ${pct(c.binary)}, graduada ${pct(c.graded)}, núcleo frente al resto ${pct(c.core_vs_rest)}.`
          : "Sin repeticiones a ciegas en esta partición.",
        "",
      );
      for (const c of p.comparisons as Array<any>) {
        lines.push(
          `Candidato ${c.candidate}:`,
          "",
          "| Contra | Diferencia P@5 | IC 95 % familias | Bonferroni | IC 95 % bloques | Diferencia G@5 | Bonferroni (G) | G@5 sin la familia que más aporta a la diferencia |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
        );
        for (const a of c.against) {
          lines.push(
            `| ${a.reference} | ${pct(a.difference)} | ${ivl(a.ci95_family)} | ${ivl(a.ci_bonferroni_family)} | ${ivl(a.ci95_blocks)} | ${pct(a.g_difference)} | ${ivl(a.g_ci_bonferroni_family)} | ${pct(a.g_difference_without_top_family.value)} |`,
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
