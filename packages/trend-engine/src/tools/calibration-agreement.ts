// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - offline tool.
// Calibration of the editorial judge against the operator's labels (protocol P1.1):
//   split  --cards <cards.jsonl> --labels <labels.json> --out <split.json>
//     Divides the labelled cards into a revision half (read while writing a rubric) and a
//     validation half (read only to measure it), stratified by unit and operator label,
//     in the order of sha256(salt, card_id).
//   judge  --cards <cards.jsonl> --split <split.json> --half validation --out <judge-in.jsonl>
//     Writes the canonical judge entries {id: card_id, text} of one half.
//   agree  --cards <cards.jsonl> --labels <labels.json> --split <split.json> --half validation
//          --judge-labels <judge-out.jsonl>
//     Agreement, kappa, coverage and the gate on that half, by unit and together.
// Operator labels are U1's export (earlyscript.editorial-labels/1: metadata and labels[]);
// its cards_hash must be the sha256 of the cards file.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { sha256 } from "../hash.ts";
import { judgeText } from "./relevance-sample.ts";

export const SPLIT_SALT = "earlyscript.calibration-split.v1";

export type Unit = "topic" | "item";

export interface TopicCard {
  readonly unit: "topic";
  readonly card_id: string;
  readonly terms: ReadonlyArray<string>;
  readonly headlines: ReadonlyArray<{ readonly title: string }>;
}
export interface ItemCard {
  readonly unit: "item";
  readonly card_id: string;
  readonly title: string;
  readonly excerpt: string;
}
export type Card = TopicCard | ItemCard;

export interface OperatorLabel {
  readonly card_id: string;
  readonly unit: Unit;
  readonly label: string;
}

/** A topic as the judge reads it: its terms and headlines, newest first. */
export const topicCardText = (terms: ReadonlyArray<string>, titles: ReadonlyArray<string>) =>
  `Topic key terms: ${terms.slice(0, 6).join(", ")}\nRecent headlines:\n${titles
    .map((t) => `- ${t}`)
    .join("\n")}`;

export const cardText = (card: Card): string =>
  card.unit === "topic"
    ? topicCardText(
        card.terms,
        card.headlines.map((h) => h.title),
      )
    : judgeText(card.title, card.excerpt);

/** U1's export, checked against the cards it was made from. */
export function readOperatorLabels(text: string, cardsBytes: Uint8Array): Array<OperatorLabel> {
  const exported = JSON.parse(text) as {
    schema_version?: string;
    cards_hash?: string;
    labels?: Array<OperatorLabel>;
  };
  if (exported.schema_version !== "earlyscript.editorial-labels/1" || !Array.isArray(exported.labels))
    throw new Error("labels are not an earlyscript.editorial-labels/1 export");
  if (exported.cards_hash !== sha256(cardsBytes))
    throw new Error("labels were exported for other cards (cards_hash does not match)");
  // The last label of a card wins, as on the labelling page.
  const byCard = new Map<string, OperatorLabel>();
  for (const label of exported.labels) byCard.set(label.card_id, label);
  return [...byCard.values()];
}

/** Half of every (unit, label) stratum, rounded so each unit's revision size is exact. */
export function splitCalibration(
  labels: ReadonlyArray<OperatorLabel>,
  revisionSize: Readonly<Record<Unit, number>>,
  salt = SPLIT_SALT,
): { revision: Array<string>; validation: Array<string> } {
  const revision: Array<string> = [];
  for (const unit of ["topic", "item"] as const) {
    const own = labels.filter((l) => l.unit === unit);
    const strata = [...new Set(own.map((l) => l.label))].toSorted();
    const ordered = (label: string) =>
      own
        .filter((l) => l.label === label)
        .map((l) => ({ id: l.card_id, r: sha256(`${salt}\n${l.card_id}`) }))
        .toSorted((a, b) => (a.r < b.r ? -1 : 1))
        .map((x) => x.id);
    // Largest remainders decide which strata get the odd card.
    const exact = strata.map((label) => ({
      label,
      quota: (own.filter((l) => l.label === label).length * revisionSize[unit]) / own.length,
    }));
    const take = new Map(exact.map((e) => [e.label, Math.floor(e.quota)]));
    let left = revisionSize[unit] - [...take.values()].reduce((a, b) => a + b, 0);
    for (const e of exact.toSorted(
      (a, b) => b.quota - Math.floor(b.quota) - (a.quota - Math.floor(a.quota)) || (a.label < b.label ? -1 : 1),
    )) {
      if (left === 0) break;
      take.set(e.label, take.get(e.label)! + 1);
      left--;
    }
    for (const label of strata) revision.push(...ordered(label).slice(0, take.get(label)!));
  }
  const inRevision = new Set(revision);
  return {
    revision: revision.toSorted(),
    validation: labels
      .map((l) => l.card_id)
      .filter((id) => !inRevision.has(id))
      .toSorted(),
  };
}

/** core and adjacent are both a yes for the operator's question. */
export const asYesNo = (label: string): "yes" | "no" | "unsure" =>
  label === "yes" || label === "core" || label === "adjacent"
    ? "yes"
    : label === "no"
      ? "no"
      : "unsure";

export interface Pair {
  readonly operator: string;
  readonly judge: string;
  readonly stratum: string;
}

function kappaOf(pairs: ReadonlyArray<{ operator: string; judge: string }>) {
  const n = pairs.length;
  if (n === 0) return { agreement: null, kappa: null };
  const po = pairs.filter((p) => p.operator === p.judge).length / n;
  const share = (who: "operator" | "judge") => pairs.filter((p) => p[who] === "yes").length / n;
  const pe = share("operator") * share("judge") + (1 - share("operator")) * (1 - share("judge"));
  return { agreement: po, kappa: pe === 1 ? null : (po - pe) / (1 - pe) };
}

/** Preregistered gate: every card answered, agreement and kappa among resolved and with doubts as no. */
export const GATE = {
  agreement: 0.8,
  kappa: 0.5,
  /** Share of the operator's resolved cards the judge must also resolve. */
  judge_resolved_share: 0.8,
} as const;

export function agreement(pairs: ReadonlyArray<Pair>, expected = pairs.length) {
  const norm = pairs.map((p) => ({ ...p, operator: asYesNo(p.operator), judge: asYesNo(p.judge) }));
  const operatorResolved = norm.filter((p) => p.operator !== "unsure");
  const resolved = operatorResolved.filter((p) => p.judge !== "unsure");
  const strict = kappaOf(resolved);
  const doubtsAsNo = kappaOf(
    norm.map((p) => ({
      operator: p.operator === "yes" ? "yes" : "no",
      judge: p.judge === "yes" ? "yes" : "no",
    })),
  );
  const missing = expected - pairs.length;
  const judgeResolvedShare =
    operatorResolved.length === 0 ? null : resolved.length / operatorResolved.length;
  const pass = (k: { agreement: number | null; kappa: number | null }) =>
    k.agreement !== null && k.kappa !== null && k.agreement >= GATE.agreement && k.kappa >= GATE.kappa;
  return {
    cards: expected,
    answered: pairs.length,
    missing,
    operator_unsure: norm.filter((p) => p.operator === "unsure").length,
    judge_unsure: norm.filter((p) => p.judge === "unsure").length,
    resolved: resolved.length,
    judge_resolved_share: judgeResolvedShare,
    resolved_agreement: strict.agreement,
    resolved_kappa: strict.kappa,
    doubts_as_no_agreement: doubtsAsNo.agreement,
    doubts_as_no_kappa: doubtsAsNo.kappa,
    confusion: {
      yes_yes: resolved.filter((p) => p.operator === "yes" && p.judge === "yes").length,
      operator_yes_judge_no: resolved.filter((p) => p.operator === "yes" && p.judge === "no")
        .length,
      operator_no_judge_yes: resolved.filter((p) => p.operator === "no" && p.judge === "yes")
        .length,
      no_no: resolved.filter((p) => p.operator === "no" && p.judge === "no").length,
    },
    accepted:
      missing === 0 &&
      judgeResolvedShare !== null &&
      judgeResolvedShare >= GATE.judge_resolved_share &&
      pass(strict) &&
      pass(doubtsAsNo),
  };
}

const readJsonl = <T>(path: string): Array<T> =>
  NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = NodeUtil.parseArgs({
    args: rest,
    options: {
      cards: { type: "string" },
      labels: { type: "string" },
      split: { type: "string" },
      half: { type: "string" },
      out: { type: "string" },
      "judge-labels": { type: "string" },
    },
  });
  if (!values.cards) {
    console.error("usage: calibration-agreement split|judge|agree --cards <jsonl> ...");
    return 64;
  }
  const cardsBytes = NodeFS.readFileSync(values.cards);
  const cards = readJsonl<Card>(values.cards);
  const cardOf = new Map(cards.map((c) => [c.card_id, c]));
  if (command === "split" && values.labels && values.out) {
    const labels = readOperatorLabels(NodeFS.readFileSync(values.labels, "utf8"), cardsBytes);
    const split = splitCalibration(labels, { topic: 30, item: 20 });
    const record = {
      salt: SPLIT_SALT,
      rule: "per unit, half of each operator-label stratum by sha256(salt, card_id); revision 30 topics + 20 items",
      cards_hash: sha256(cardsBytes),
      labels_sha256: sha256(NodeFS.readFileSync(values.labels)),
      ...split,
    };
    const text = `${JSON.stringify(record, null, 2)}\n`;
    NodeFS.writeFileSync(values.out, text);
    console.log(JSON.stringify({ split_sha256: sha256(text), revision: split.revision.length, validation: split.validation.length }));
    return 0;
  }
  const split = values.split
    ? (JSON.parse(NodeFS.readFileSync(values.split, "utf8")) as { revision: string[]; validation: string[]; cards_hash: string })
    : null;
  if (split && split.cards_hash !== sha256(cardsBytes)) throw new Error("split was made for other cards");
  const half = values.half === "revision" ? split?.revision : split?.validation;
  if (command === "judge" && half && values.out) {
    NodeFS.writeFileSync(
      values.out,
      half.map((id) => `${JSON.stringify({ id, text: cardText(cardOf.get(id)!) })}\n`).join(""),
    );
    console.log(JSON.stringify({ entries: half.length }));
    return 0;
  }
  if (command === "agree" && half && values.labels && values["judge-labels"]) {
    const operator = new Map(
      readOperatorLabels(NodeFS.readFileSync(values.labels, "utf8"), cardsBytes).map((l) => [l.card_id, l]),
    );
    const judged = new Map(
      readJsonl<{ id: string; label: string }>(values["judge-labels"]).map((l) => [l.id, l.label]),
    );
    const pairsOf = (unit: Unit | null) => {
      const ids = half.filter((id) => unit === null || operator.get(id)?.unit === unit);
      const pairs = ids.flatMap((id) =>
        judged.has(id) && operator.has(id)
          ? [{ operator: operator.get(id)!.label, judge: judged.get(id)!, stratum: operator.get(id)!.unit }]
          : [],
      );
      return agreement(pairs, ids.length);
    };
    console.log(
      JSON.stringify(
        { half: values.half ?? "validation", gate: GATE, overall: pairsOf(null), topic: pairsOf("topic"), item: pairsOf("item") },
        null,
        2,
      ),
    );
    return 0;
  }
  console.error("usage: calibration-agreement split|judge|agree --cards <jsonl> ...");
  return 64;
}

if (import.meta.main) process.exitCode = await main();
