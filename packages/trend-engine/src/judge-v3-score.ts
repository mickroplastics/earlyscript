// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - offline scoring over local list files.
// `engine v3 judge-score`: the two utility judges over the development lists of the nine arms
// (contract v4.2 §5a). Parity: every arm's cards go through the same cardTextV3 (or, with --flat,
// the same cardTextFlat), and the cards of one cutoff are judged together, so a topic that two
// arms emit with the same text gets one answer. A cutoff is valid for an arm when it emitted at
// least 5 "moving" cards and both judges answered every one of them validly; U@10 is the mean
// combined utility of those cards. Paired support: the cutoffs valid for every arm compared.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cardTextFlat, cardTextV3 } from "./card-text-v3.ts";
import { sha256 } from "./hash.ts";
import { listEntry } from "./judge-v3-inputs.ts";
import { type JudgeCard, type JudgeRunOptions, judgeBoth, judgeIdentity } from "./judge-v3.ts";

export const SCORE_RULE = { min_cards: 5, last_day: "2026-10-31" } as const;

export interface ListFile {
  readonly arm: string;
  readonly cutoff: string;
  readonly path: string;
  readonly sha256: string;
  readonly moving: ReadonlyArray<unknown>;
}

/** Reads <dir>/<arm>/<YYYY-MM-DD>.json; days after 31 October are refused. */
export function readLists(dir: string, arms?: ReadonlyArray<string>): Array<ListFile> {
  const out: Array<ListFile> = [];
  for (const arm of NodeFS.readdirSync(dir).toSorted()) {
    const armDir = NodePath.join(dir, arm);
    if (!NodeFS.statSync(armDir).isDirectory()) continue;
    if (arms && !arms.includes(arm)) continue;
    for (const file of NodeFS.readdirSync(armDir).toSorted()) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
      if (!m) continue;
      if (m[1]! > SCORE_RULE.last_day) throw new Error(`${arm}/${file}: list after 31 October`);
      const path = NodePath.join(armDir, file);
      const bytes = NodeFS.readFileSync(path);
      const json = JSON.parse(bytes.toString("utf8")) as {
        cutoff?: string;
        moving?: Array<unknown>;
        cards?: Array<unknown>;
      };
      const moving = json.moving ?? json.cards;
      if (!Array.isArray(moving)) throw new Error(`${path} has no "moving" list`);
      out.push({ arm, cutoff: m[1]!, path, sha256: sha256(bytes), moving });
    }
  }
  return out;
}

export async function scoreLists(options: {
  readonly lists: ReadonlyArray<ListFile>;
  readonly flat?: boolean;
  readonly out: string;
  readonly run: JudgeRunOptions;
}) {
  const textOf = options.flat ? cardTextFlat : cardTextV3;
  const cards: Array<JudgeCard & { arm: string; cutoff: string; topic_id: string }> = [];
  for (const list of options.lists)
    for (const raw of list.moving) {
      const entry = listEntry(raw, list.cutoff);
      const { text, evidence } = textOf(entry.card);
      cards.push({
        id: `${list.arm}/${list.cutoff}/${entry.topic_id}`,
        text,
        evidence_ids: evidence.map((e) => e.id),
        group: list.cutoff,
        arm: list.arm,
        cutoff: list.cutoff,
        topic_id: entry.topic_id,
      });
    }
  const t0 = Date.now();
  const { combined, stats } = await judgeBoth(cards, options.run);
  const byId = new Map(combined.map((c) => [c.id, c]));
  const names = options.run.judge.config.judges.map((j) => j.name);

  const cells = options.lists.map((list) => {
    const mine = cards.filter((c) => c.arm === list.arm && c.cutoff === list.cutoff);
    const answers = mine.map((c) => byId.get(c.id)!);
    const allAnswered = answers.every((a) => a.utility !== null);
    const valid = mine.length >= SCORE_RULE.min_cards && allAnswered;
    const utilities = answers.map((a) => a.utility).filter((u): u is number => u !== null);
    return {
      arm: list.arm,
      cutoff: list.cutoff,
      list_sha256: list.sha256,
      cards: mine.length,
      answered_by_both: utilities.length,
      valid,
      invalid_reason: valid
        ? null
        : mine.length < SCORE_RULE.min_cards
          ? `${mine.length} tarjetas emitidas (< ${SCORE_RULE.min_cards})`
          : "algún juez no respondió a todas",
      u_at_10: valid ? utilities.reduce((s, u) => s + u, 0) / utilities.length : null,
      answers: mine.map((c) => {
        const a = byId.get(c.id)!;
        return {
          topic_id: c.topic_id,
          text_sha256: sha256(c.text),
          fit: a.fit,
          utility: a.utility,
          utility_difference: a.utility_difference,
          judges: Object.fromEntries(
            names.map((n) => {
              const j = a.judges[n]!;
              return [n, { valid: j.valid, error: j.error, key: j.key, ...j.answer }];
            }),
          ),
        };
      }),
    };
  });
  const arms = [...new Set(cells.map((c) => c.arm))].toSorted();
  const cutoffs = [...new Set(cells.map((c) => c.cutoff))].toSorted();
  const common = cutoffs.filter((day) =>
    arms.every((arm) => cells.some((c) => c.arm === arm && c.cutoff === day && c.valid)),
  );
  const summary = Object.fromEntries(
    arms.map((arm) => {
      const mine = cells.filter((c) => c.arm === arm);
      const onCommon = mine.filter((c) => common.includes(c.cutoff));
      const mean = (xs: ReadonlyArray<number>) =>
        xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
      return [
        arm,
        {
          cutoffs: mine.length,
          valid_cutoffs: mine.filter((c) => c.valid).length,
          u_at_10_mean_valid: mean(mine.flatMap((c) => (c.u_at_10 === null ? [] : [c.u_at_10]))),
          u_at_10_mean_common: mean(
            onCommon.flatMap((c) => (c.u_at_10 === null ? [] : [c.u_at_10])),
          ),
        },
      ];
    }),
  );
  const report = {
    variant: options.flat ? "flat" : "card-text-v3",
    identity: judgeIdentity(options.run.judge),
    rule: SCORE_RULE,
    arms,
    cutoffs,
    paired_support: { cutoffs: common, n: common.length },
    summary,
    stats,
    calls: stats.reduce((s, x) => s + x.calls, 0),
    invalid_answers: stats.reduce((s, x) => s + x.invalid_final, 0),
    seconds: (Date.now() - t0) / 1000,
    cells,
    at: new Date().toISOString(),
  };
  NodeFS.mkdirSync(options.out, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(options.out, options.flat ? "scores-flat.json" : "scores.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
