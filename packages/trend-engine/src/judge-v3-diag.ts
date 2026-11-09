// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - offline diagnosis over local files.
// `engine v3 judge-diag`: fit diagnosis of the two utility judges on the 136 eligible cards of the
// P2 partition (contract v4.2 §3, second declared use of the 60). Target fit yes/no: Miguel's yes
// (core or adjacent) against no and "unsure"; a judge's yes is fit core or adjacent; an invalid
// answer counts as no; the combined fit is the judges' agreement and "discrepan" counts as no.
// Phases: `calibracion` (the 76, may be repeated while the rubric is adjusted), `estabilidad`
// (10 calibration cards judged again with reordered text) and `validacion` (the 60, once: a lock
// written before the first call refuses any second run, in the output and in the cache).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cardTextV3 } from "./card-text-v3.ts";
import { sha256 } from "./hash.ts";
import { fromP2Card, type P2CardRow } from "./judge-v3-inputs.ts";
import {
  type CombinedAnswer,
  type JudgeCard,
  type JudgeRunOptions,
  judgeBoth,
  judgeIdentity,
  type StoredAnswer,
} from "./judge-v3.ts";

export const DIAG_RULE = {
  kappa_min: 0.6,
  /** Majority predictor on the 60 (52 yes) 0.867, plus 0.05. */
  agreement_min: 0.917,
  valid_required: { calibracion: 76, validacion: 60 },
  bootstrap: { replicates: 2000, seed: 20261109 },
  stability: { cards: 10, seed: 1, max_change: 1, min_cards_within: 8 },
  last_day: "2026-10-31",
} as const;

export type YesNo = "yes" | "no";

export interface DiagRow {
  readonly id: string;
  readonly family: string;
  readonly miguel: YesNo;
  readonly combined: CombinedAnswer;
}

const judgeYes = (a: StoredAnswer | undefined): YesNo =>
  a?.valid && (a.answer?.fit === "core" || a.answer?.fit === "adjacent") ? "yes" : "no";

const combinedYes = (c: CombinedAnswer): YesNo =>
  c.fit === "core" || c.fit === "adjacent" ? "yes" : "no";

export function kappa(pairs: ReadonlyArray<{ a: YesNo; b: YesNo }>) {
  const n = pairs.length;
  if (n === 0) return { n, agreement: null, kappa: null };
  const po = pairs.filter((p) => p.a === p.b).length / n;
  const pa = pairs.filter((p) => p.a === "yes").length / n;
  const pb = pairs.filter((p) => p.b === "yes").length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return { n, agreement: po, kappa: pe === 1 ? null : (po - pe) / (1 - pe) };
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (xs: ReadonlyArray<number>, q: number) => {
  if (xs.length === 0) return null;
  const s = xs.toSorted((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (pos - lo);
};

/** 95 % percentile intervals of agreement and kappa, resampling topic families with replacement. */
export function familyBootstrap(
  rows: ReadonlyArray<{ family: string; a: YesNo; b: YesNo }>,
  replicates: number = DIAG_RULE.bootstrap.replicates,
  seed: number = DIAG_RULE.bootstrap.seed,
) {
  const families = new Map<string, Array<{ a: YesNo; b: YesNo }>>();
  for (const r of rows) families.set(r.family, [...(families.get(r.family) ?? []), r]);
  const keys = [...families.keys()].toSorted();
  const rand = mulberry(seed);
  const agreements: Array<number> = [];
  const kappas: Array<number> = [];
  let degenerate = 0;
  for (let b = 0; b < replicates; b++) {
    const sample: Array<{ a: YesNo; b: YesNo }> = [];
    for (let k = 0; k < keys.length; k++)
      sample.push(...families.get(keys[Math.floor(rand() * keys.length)]!)!);
    const k = kappa(sample);
    if (k.agreement !== null) agreements.push(k.agreement);
    if (k.kappa === null) degenerate++;
    else kappas.push(k.kappa);
  }
  return {
    families: keys.length,
    replicates,
    seed,
    degenerate_kappa: degenerate,
    agreement: { low: quantile(agreements, 0.025), high: quantile(agreements, 0.975) },
    kappa: { low: quantile(kappas, 0.025), high: quantile(kappas, 0.975) },
  };
}

function metrics(
  rows: ReadonlyArray<DiagRow>,
  pick: (r: DiagRow) => { yes: YesNo; valid: boolean },
) {
  const pairs = rows.map((r) => ({ family: r.family, a: r.miguel, b: pick(r).yes }));
  const k = kappa(pairs);
  const yes = rows.filter((r) => r.miguel === "yes").length;
  const majority = rows.length ? Math.max(yes, rows.length - yes) / rows.length : null;
  const valid = rows.filter((r) => pick(r).valid).length;
  return {
    n: rows.length,
    valid,
    coverage: rows.length ? valid / rows.length : null,
    agreement: k.agreement,
    kappa: k.kappa,
    majority_agreement: majority,
    confusion: {
      miguel_yes_judge_yes: pairs.filter((p) => p.a === "yes" && p.b === "yes").length,
      miguel_yes_judge_no: pairs.filter((p) => p.a === "yes" && p.b === "no").length,
      miguel_no_judge_yes: pairs.filter((p) => p.a === "no" && p.b === "yes").length,
      miguel_no_judge_no: pairs.filter((p) => p.a === "no" && p.b === "no").length,
    },
    family_intervals: familyBootstrap(pairs),
  };
}

/** κ, agreement, majority, confusion, coverage and family intervals per judge and combined. */
export function diagnose(
  rows: ReadonlyArray<DiagRow>,
  judges: ReadonlyArray<string>,
  validRequired: number,
) {
  const perJudge = Object.fromEntries(
    judges.map((name) => [
      name,
      metrics(rows, (r) => ({
        yes: judgeYes(r.combined.judges[name]),
        valid: r.combined.judges[name]?.valid === true,
      })),
    ]),
  );
  const combined = metrics(rows, (r) => ({
    yes: combinedYes(r.combined),
    valid: r.combined.utility !== null,
  }));
  // Descriptive only: both judges say yes, whatever the grade (core against adjacent is not a "no").
  const bothYes = kappa(
    rows.map((r) => ({
      a: r.miguel,
      b: judges.every((j) => judgeYes(r.combined.judges[j]) === "yes")
        ? ("yes" as const)
        : ("no" as const),
    })),
  );
  const failed = judges.filter((j) => perJudge[j]!.valid < validRequired);
  const pass = (m: { kappa: number | null; agreement: number | null }) =>
    m.kappa !== null &&
    m.agreement !== null &&
    m.kappa >= DIAG_RULE.kappa_min &&
    m.agreement >= DIAG_RULE.agreement_min;
  return {
    judges: perJudge,
    combined,
    combined_both_yes_descriptive: bothYes,
    failed: failed.length > 0,
    failed_reason: failed.length
      ? `diagnóstico fallido: ${failed.map((j) => `${j} ${perJudge[j]!.valid}/${validRequired} válidas`).join(", ")}`
      : null,
    criterion: `kappa >= ${DIAG_RULE.kappa_min} y acuerdo >= ${DIAG_RULE.agreement_min} sobre el fit combinado`,
    calibrated: failed.length === 0 && pass(combined),
    per_judge_pass: Object.fromEntries(judges.map((j) => [j, pass(perJudge[j]!)])),
  };
}

export interface DiagInputs {
  readonly particion: {
    readonly calibracion_ids: ReadonlyArray<string>;
    readonly validacion_ids: ReadonlyArray<string>;
    readonly calibracion: { readonly yes: number; readonly cards: number };
    readonly validacion: { readonly yes: number; readonly cards: number };
  };
  readonly cards: Map<string, P2CardRow>;
  readonly familyOf: Map<string, string>;
  readonly miguelCal: Map<string, YesNo>;
  readonly miguelVal: Map<string, YesNo>;
  readonly hashes: Record<string, string>;
}

const readJson = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown;

const late = (c: P2CardRow) =>
  c.cutoff.slice(0, 10) > DIAG_RULE.last_day ||
  c.headlines.some((h) => h.published_at.slice(0, 10) > DIAG_RULE.last_day);

/** Miguel's label files (labeler "miguel"); the P2 judge outputs are refused. */
function readMiguel(paths: ReadonlyArray<string>, ids: ReadonlyArray<string>): Map<string, YesNo> {
  const wanted = new Set(ids);
  const out = new Map<string, YesNo>();
  for (const path of paths) {
    const file = readJson(path) as {
      labeler?: string;
      labels?: Array<{ card_id: string; label: string }>;
    };
    if (file.labeler !== "miguel" || !Array.isArray(file.labels))
      throw new Error(
        `${path} is not a label file of Miguel (labeler "miguel"); the P2 judge outputs are not his labels`,
      );
    for (const l of file.labels)
      if (wanted.has(l.card_id)) out.set(l.card_id, l.label === "yes" ? "yes" : "no");
  }
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length) throw new Error(`${missing.length} partition cards have no label of Miguel`);
  return out;
}

export function readDiagInputs(options: {
  readonly particion: string;
  readonly cards: ReadonlyArray<string>;
  readonly universe: string;
  readonly labelsCal: ReadonlyArray<string>;
  readonly labelsVal: ReadonlyArray<string>;
}): DiagInputs {
  const all = [
    options.particion,
    options.universe,
    ...options.cards,
    ...options.labelsCal,
    ...options.labelsVal,
  ];
  // Every partition card is checked below: a cutoff or headline after 31 October is refused.
  const particion = readJson(options.particion) as DiagInputs["particion"];
  const cards = new Map<string, P2CardRow>();
  for (const path of options.cards)
    for (const line of NodeFS.readFileSync(path, "utf8").split("\n"))
      if (line.trim()) {
        const c = JSON.parse(line) as P2CardRow;
        cards.set(c.card_id, c);
      }
  const universe = readJson(options.universe) as {
    logical: { topics: Array<{ topic_id: string; family_id: string }> };
  };
  const familyByTopic = new Map(universe.logical.topics.map((t) => [t.topic_id, t.family_id]));
  const familyOf = new Map<string, string>();
  for (const id of [...particion.calibracion_ids, ...particion.validacion_ids]) {
    const card = cards.get(id);
    if (!card) throw new Error(`partition card ${id} is not in --cards`);
    if (late(card)) throw new Error(`partition card ${id} has data after ${DIAG_RULE.last_day}`);
    const family = familyByTopic.get(card.topic_id);
    if (!family) throw new Error(`no family for ${card.topic_id}`);
    familyOf.set(id, family);
  }
  const miguelCal = readMiguel(options.labelsCal, particion.calibracion_ids);
  const miguelVal = readMiguel(options.labelsVal, particion.validacion_ids);
  const yes = (m: Map<string, YesNo>) => [...m.values()].filter((v) => v === "yes").length;
  if (yes(miguelCal) !== particion.calibracion.yes || yes(miguelVal) !== particion.validacion.yes)
    throw new Error(
      `Miguel's yes counts (${yes(miguelCal)}, ${yes(miguelVal)}) differ from particion.json (${particion.calibracion.yes}, ${particion.validacion.yes})`,
    );
  const hashes = Object.fromEntries(all.map((p) => [p, sha256(NodeFS.readFileSync(p))]));
  return { particion, cards, familyOf, miguelCal, miguelVal, hashes };
}

export const p2JudgeCard = (card: P2CardRow, order?: { seed: number }): JudgeCard => {
  const { text, evidence } = cardTextV3(fromP2Card(card), order ? { order } : {});
  return {
    id: order ? `${card.card_id}~r${order.seed}` : card.card_id,
    text,
    evidence_ids: evidence.map((e) => e.id),
    group: card.cutoff.slice(0, 10),
  };
};

/** The 10 stability cards: calibration cards whose topic Miguel saw twice, then by salted hash. */
export function stabilityIds(
  inputs: DiagInputs,
  allCards: ReadonlyArray<P2CardRow>,
): Array<string> {
  const cal = new Set(inputs.particion.calibracion_ids);
  const topics = new Map<string, number>();
  for (const c of allCards) topics.set(c.topic_id, (topics.get(c.topic_id) ?? 0) + 1);
  const repeated = inputs.particion.calibracion_ids
    .filter((id) => (topics.get(inputs.cards.get(id)!.topic_id) ?? 0) > 1)
    .toSorted();
  const salted = inputs.particion.calibracion_ids
    .filter((id) => !repeated.includes(id) && cal.has(id))
    .toSorted((a, b) => (sha256(`v3-stability\n${a}`) < sha256(`v3-stability\n${b}`) ? -1 : 1));
  return [...repeated, ...salted].slice(0, DIAG_RULE.stability.cards);
}

export type DiagPhase = "calibracion" | "estabilidad" | "validacion";

const LOCK = "validacion.lock.json";

/** Writes the lock with O_EXCL; a lock already present (in out or in the cache) refuses the run. */
export function takeValidationLock(dirs: ReadonlyArray<string>, content: unknown) {
  for (const dir of dirs)
    if (NodeFS.existsSync(NodePath.join(dir, LOCK)))
      throw new Error(
        `the 60 validation cards are judged once: ${NodePath.join(dir, LOCK)} already exists`,
      );
  for (const dir of dirs) {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, LOCK), `${JSON.stringify(content, null, 2)}\n`, {
      flag: "wx",
    });
  }
}

export async function runDiagPhase(options: {
  readonly phase: DiagPhase;
  readonly inputs: DiagInputs;
  readonly allCards: ReadonlyArray<P2CardRow>;
  readonly out: string;
  readonly run: JudgeRunOptions;
}) {
  const { phase, inputs, out, run } = options;
  const names = run.judge.config.judges.map((j) => j.name);
  NodeFS.mkdirSync(out, { recursive: true });
  const identity = judgeIdentity(run.judge);
  const base = {
    phase,
    identity,
    rule: DIAG_RULE,
    inputs: inputs.hashes,
    target: "Miguel sí (núcleo o adyacente) frente a no y no sé; inválida = no; discrepan = no",
  };

  if (phase === "estabilidad") {
    const ids = stabilityIds(inputs, options.allCards);
    const canonical = ids.map((id) => p2JudgeCard(inputs.cards.get(id)!));
    const reordered = ids.map((id) =>
      p2JudgeCard(inputs.cards.get(id)!, { seed: DIAG_RULE.stability.seed }),
    );
    const { combined, stats } = await judgeBoth([...canonical, ...reordered], run);
    const byId = new Map(combined.map((c) => [c.id, c]));
    const change = (a: number | null | undefined, b: number | null | undefined) =>
      a === null || a === undefined || b === null || b === undefined ? null : Math.abs(a - b);
    const rows = ids.map((id, k) => {
      const c0 = byId.get(canonical[k]!.id)!;
      const c1 = byId.get(reordered[k]!.id)!;
      return {
        id,
        changes: Object.fromEntries([
          ...names.map((n) => [
            n,
            change(c0.judges[n]?.answer?.utility, c1.judges[n]?.answer?.utility),
          ]),
          ["combined", change(c0.utility, c1.utility)],
        ]),
      };
    });
    const within = (who: string) =>
      rows.filter((r) => {
        const v = r.changes[who];
        return typeof v === "number" && v <= DIAG_RULE.stability.max_change;
      }).length;
    const report = {
      ...base,
      cards: ids,
      rows,
      within_one_point: Object.fromEntries([...names, "combined"].map((w) => [w, within(w)])),
      stable: Object.fromEntries(
        [...names, "combined"].map((w) => [w, within(w) >= DIAG_RULE.stability.min_cards_within]),
      ),
      stats,
      at: new Date().toISOString(),
    };
    NodeFS.writeFileSync(
      NodePath.join(out, "estabilidad.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  }

  const ids =
    phase === "calibracion" ? inputs.particion.calibracion_ids : inputs.particion.validacion_ids;
  const miguel = phase === "calibracion" ? inputs.miguelCal : inputs.miguelVal;
  const cards = ids.map((id) => p2JudgeCard(inputs.cards.get(id)!));
  if (phase === "validacion") {
    if (run.replay)
      throw new Error("validation is judged once, from the CLIs; replay is for audits");
    takeValidationLock([out, run.cacheDir], {
      at: new Date().toISOString(),
      identity,
      cards: cards.map((c) => ({ id: c.id, text_sha256: sha256(c.text) })),
    });
  }
  const { combined, stats } = await judgeBoth(cards, run);
  const rows: Array<DiagRow> = combined.map((c) => ({
    id: c.id,
    family: inputs.familyOf.get(c.id)!,
    miguel: miguel.get(c.id)!,
    combined: c,
  }));
  const report = {
    ...base,
    diagnosis: diagnose(rows, names, DIAG_RULE.valid_required[phase]),
    stats,
    answers: rows.map((r) => ({
      id: r.id,
      family: r.family,
      miguel: r.miguel,
      fit: r.combined.fit,
      utility: r.combined.utility,
      utility_difference: r.combined.utility_difference,
      judges: Object.fromEntries(
        names.map((n) => {
          const a = r.combined.judges[n]!;
          return [
            n,
            { valid: a.valid, error: a.error, attempts: a.attempts, key: a.key, ...a.answer },
          ];
        }),
      ),
    })),
    at: new Date().toISOString(),
  };
  NodeFS.writeFileSync(NodePath.join(out, `${phase}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
