// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - offline tool.
//   node src/tools/calibration-agreement.ts --key items-calibration-40.judge.jsonl --operator labels.jsonl
// Agreement between the operator and the judge on the item calibration cards. Operator
// lines are {card_id | item_id, label: "yes"|"no"|"unsure", unit?: "item"}. Agreement and
// Cohen's kappa use the cards both answered yes or no; "unsure" on either side is counted
// apart. The judge's labels train the relevance probe only when agreement >= 0.80 and
// kappa >= 0.5 (protocol P1.1).
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

const readJsonl = <T>(path: string): Array<T> =>
  NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

export interface Pair {
  readonly operator: string;
  readonly judge: string;
  readonly stratum: string;
}

export function agreement(pairs: ReadonlyArray<Pair>) {
  const resolved = pairs.filter(
    (p) => (p.operator === "yes" || p.operator === "no") && (p.judge === "yes" || p.judge === "no"),
  );
  const n = resolved.length;
  const agree = resolved.filter((p) => p.operator === p.judge).length;
  const po = n === 0 ? null : agree / n;
  const share = (who: "operator" | "judge") => resolved.filter((p) => p[who] === "yes").length / n;
  const pe =
    n === 0
      ? null
      : share("operator") * share("judge") + (1 - share("operator")) * (1 - share("judge"));
  const kappa = po === null || pe === null || pe === 1 ? null : (po - pe) / (1 - pe);
  return {
    cards: pairs.length,
    resolved: n,
    operator_unsure: pairs.filter((p) => p.operator === "unsure").length,
    judge_unsure: pairs.filter((p) => p.judge === "unsure").length,
    agreement: po,
    kappa,
    confusion: {
      yes_yes: resolved.filter((p) => p.operator === "yes" && p.judge === "yes").length,
      operator_yes_judge_no: resolved.filter((p) => p.operator === "yes" && p.judge === "no")
        .length,
      operator_no_judge_yes: resolved.filter((p) => p.operator === "no" && p.judge === "yes")
        .length,
      no_no: resolved.filter((p) => p.operator === "no" && p.judge === "no").length,
    },
    accepted: po !== null && kappa !== null && po >= 0.8 && kappa >= 0.5,
  };
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: { key: { type: "string" }, operator: { type: "string" } },
  });
  if (!values.key || !values.operator) {
    console.error("usage: calibration-agreement --key <judge.jsonl> --operator <labels.jsonl>");
    return 64;
  }
  const key = readJsonl<{ card_id: string; item_id: string; stratum: string; judge_label: string }>(
    values.key,
  );
  const operator = readJsonl<{ card_id?: string; item_id?: string; label: string; unit?: string }>(
    values.operator,
  ).filter((l) => l.unit === undefined || l.unit === "item");
  const pairs: Array<Pair> = key.flatMap((k) => {
    const mine = operator.findLast((l) => l.card_id === k.card_id || l.item_id === k.item_id);
    return mine ? [{ operator: mine.label, judge: k.judge_label, stratum: k.stratum }] : [];
  });
  const byStratum: Record<string, unknown> = {};
  for (const stratum of [...new Set(pairs.map((p) => p.stratum.split(":")[1]!))].toSorted())
    byStratum[stratum] = agreement(pairs.filter((p) => p.stratum.endsWith(`:${stratum}`)));
  const bySource: Record<string, unknown> = {};
  for (const source of [...new Set(pairs.map((p) => p.stratum.split(":")[0]!))].toSorted())
    bySource[source] = agreement(pairs.filter((p) => p.stratum.startsWith(`${source}:`)));
  console.log(
    JSON.stringify(
      {
        overall: agreement(pairs),
        missing: key.length - pairs.length,
        by_stratum: byStratum,
        by_source: bySource,
      },
      null,
      2,
    ),
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
