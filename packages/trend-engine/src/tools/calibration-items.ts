// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - offline tool.
//   node src/tools/calibration-items.ts --sample sample.jsonl --labels labels.jsonl --out-dir <dir>
// Item cards for the operator to calibrate the judge: stratified by source and, inside a
// source, by the judge's label, with AI headlines the judge rejected as hard negatives.
// Writes items-calibration-40.jsonl (cards with no label) and, apart,
// items-calibration-40.judge.jsonl (the judge's labels, not for the operator). Picks follow
// sha256(salt, id), so the same inputs give the same cards.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { sha256 } from "../hash.ts";
import type { SampleRow } from "./relevance-sample.ts";

export const CALIBRATION_SALT = "earlyscript.calibration-items.v1";

/** Per source: judge-yes items, then hard negatives, then other judge-no items. */
export const STRATA: ReadonlyArray<{
  readonly source: string;
  readonly yes: number;
  readonly hard: number;
  readonly no: number;
}> = [
  { source: "hn", yes: 5, hard: 4, no: 5 },
  { source: "huggingface", yes: 4, hard: 0, no: 3 },
  { source: "github", yes: 3, hard: 0, no: 2 },
  { source: "npm", yes: 3, hard: 0, no: 2 },
  { source: "wikipedia", yes: 1, hard: 1, no: 3 },
  { source: "rss", yes: 2, hard: 1, no: 1 },
];

/** Headlines that mention AI: the negatives a cosine to "AI" topics lets through. */
export const AI_TERMS =
  /\b(ai|a\.i\.|llms?|gpt[-\w.]*|openai|anthropic|claude|gemini|chatgpt|agents?|agentic|deepseek|qwen|mistral|nvidia|artificial intelligence|machine learning)\b/i;

const readJsonl = <T>(path: string): Array<T> =>
  NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

interface Label {
  readonly id: string;
  readonly label: "yes" | "no" | "unsure";
}

export function pickCalibration(
  rows: ReadonlyArray<SampleRow>,
  labelOf: ReadonlyMap<string, string>,
) {
  const rank = (row: SampleRow) => sha256(`${CALIBRATION_SALT}\n${row.id}`);
  const ordered = rows.toSorted((a, b) => (rank(a) < rank(b) ? -1 : 1));
  const picked: Array<{ row: SampleRow; stratum: string }> = [];
  for (const s of STRATA) {
    const own = ordered.filter((r) => r.source === s.source);
    const yes = own.filter((r) => labelOf.get(r.id) === "yes");
    const no = own.filter((r) => labelOf.get(r.id) === "no");
    const hard = no.filter((r) => AI_TERMS.test(r.judge_text));
    const plain = no.filter((r) => !hard.includes(r));
    const take = (pool: ReadonlyArray<SampleRow>, n: number, stratum: string) => {
      const chosen = pool.filter((r) => !picked.some((p) => p.row.id === r.id)).slice(0, n);
      picked.push(...chosen.map((row) => ({ row, stratum })));
      return n - chosen.length;
    };
    // Short strata pass their quota to the next pool of the same source.
    let missing = take(yes, s.yes, `${s.source}:yes`);
    missing = take(hard, s.hard + missing, `${s.source}:hard_negative`);
    missing = take(plain, s.no + missing, `${s.source}:no`);
    if (missing > 0) take(hard, missing, `${s.source}:hard_negative`);
  }
  return picked;
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      sample: { type: "string" },
      labels: { type: "string" },
      "out-dir": { type: "string" },
    },
  });
  if (!values.sample || !values.labels || !values["out-dir"]) {
    console.error("usage: calibration-items --sample <jsonl> --labels <jsonl> --out-dir <dir>");
    return 64;
  }
  const rows = readJsonl<SampleRow>(values.sample);
  const labelOf = new Map(readJsonl<Label>(values.labels).map((l) => [l.id, l.label]));
  const picked = pickCalibration(rows, labelOf);
  // Card order hides the strata.
  const cards = picked
    .map((p) => ({ ...p, order: sha256(`${CALIBRATION_SALT}\ncard\n${p.row.id}`) }))
    .toSorted((a, b) => (a.order < b.order ? -1 : 1))
    .map((p, k) => ({
      card: {
        unit: "item" as const,
        card_id: `itemcal-${String(k + 1).padStart(2, "0")}`,
        item_id: p.row.id,
        source: p.row.source,
        published_at: p.row.published_at,
        permalink: p.row.permalink,
        title: p.row.title,
        excerpt: p.row.excerpt,
        question: "Would SingulariDev make a video about this in the next 7 days?",
      },
      key: {
        card_id: `itemcal-${String(k + 1).padStart(2, "0")}`,
        item_id: p.row.id,
        stratum: p.stratum,
        judge_label: labelOf.get(p.row.id),
      },
    }));
  NodeFS.mkdirSync(values["out-dir"], { recursive: true });
  const cardText = cards.map((c) => `${JSON.stringify(c.card)}\n`).join("");
  NodeFS.writeFileSync(NodePath.join(values["out-dir"], "items-calibration-40.jsonl"), cardText);
  NodeFS.writeFileSync(
    NodePath.join(values["out-dir"], "items-calibration-40.judge.jsonl"),
    cards.map((c) => `${JSON.stringify(c.key)}\n`).join(""),
  );
  const strata: Record<string, number> = {};
  for (const p of picked) strata[p.stratum] = (strata[p.stratum] ?? 0) + 1;
  console.log(JSON.stringify({ cards: cards.length, cards_sha256: sha256(cardText), strata }));
  return 0;
}

if (import.meta.main) process.exitCode = await main();
