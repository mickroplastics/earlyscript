// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the v3 development evaluation over files.
// From the corpus, coverage, A's bags and lists and B's judged cuts to the takeoffs, the
// metrics and the input of decide(). The caller checks the ledger (v3_oracle) before calling
// with real data; with synthetic data it runs freely (--dry-run and tests).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  readBagFile,
  readCorpusItems,
  readCoverage,
  readJsonGuarded,
  readListFile,
  type V3List,
} from "./v3-data.ts";
import type { DecideInput } from "./v3-decide.ts";
import {
  captures,
  eligibility,
  type JudgedCut,
  judgedIndex,
  meanU10,
  pairedSupport,
  recallBlocks,
  recallEvaluable,
  recallOf,
  u10Contrast,
  V3_ARMS,
  V3_CONTRASTS,
  V3_VARIANTS,
  type V3Variant,
} from "./v3-metrics.ts";
import {
  bagIndex,
  findTakeoffs,
  itemIndex,
  p4DefinitionHash,
  V3_CUTOFFS,
  V3_LIST_DAYS,
} from "./v3-oracle.ts";

export interface V3EvalPaths {
  readonly corpus: string;
  readonly coverage: string;
  readonly bags: string;
  readonly lists: string;
  readonly judges?: string | null;
}

export function evaluateV3(paths: V3EvalPaths, cutoffs: ReadonlyArray<string> = V3_CUTOFFS) {
  const items = itemIndex(readCorpusItems(paths.corpus));
  const coverage = readCoverage(paths.coverage);
  const bagCache = new Map<string, ReturnType<typeof readBagFile>>();
  const bagOf = (day: string) => {
    let bag = bagCache.get(day);
    if (!bag) bagCache.set(day, (bag = readBagFile(NodePath.join(paths.bags, `${day}.json`))));
    return bag;
  };
  const indexCache = new Map<string, ReturnType<typeof bagIndex>>();
  const indexOf = (day: string) => {
    let index = indexCache.get(day);
    if (!index) indexCache.set(day, (index = bagIndex(bagOf(day))));
    return index;
  };
  const { takeoffs, unknown, labels } = findTakeoffs({ cutoffs, bagOf, coverage, items });
  const listCache = new Map<string, V3List | null>();
  const listOf = (arm: string, day: string) => {
    const key = `${arm}/${day}`;
    if (!listCache.has(key)) {
      const path = NodePath.join(paths.lists, arm, `${day}.json`);
      listCache.set(key, NodeFS.existsSync(path) ? readListFile(path) : null);
    }
    return listCache.get(key)!;
  };
  const rows = captures({ takeoffs, arms: V3_ARMS, listOf, bagOf: indexOf, items });
  const recall = Object.fromEntries(
    V3_ARMS.map((arm) => [arm, { ...recallOf(rows, arm), blocks: recallBlocks(rows, arm) }]),
  );
  const eligible = Object.fromEntries(
    V3_VARIANTS.map((v) => [
      v,
      eligibility(new Map(cutoffs.map((d) => [d, listOf(v, d)])), cutoffs),
    ]),
  ) as Record<V3Variant, ReturnType<typeof eligibility>>;
  const judged: Array<JudgedCut> = paths.judges
    ? readJsonGuarded<{ cuts: Array<JudgedCut> }>(paths.judges).cuts
    : [];
  const index = judgedIndex(judged.filter((c) => cutoffs.includes(c.cutoff)));
  const eligibleVariants = V3_VARIANTS.filter((v) => eligible[v].eligible);
  const selectionSupport = pairedSupport(index, eligibleVariants, cutoffs);
  const contrasts = Object.fromEntries(
    V3_VARIANTS.map((v) => [
      v,
      Object.fromEntries(V3_CONTRASTS.map((r) => [r, u10Contrast(index, v, r, cutoffs)])),
    ]),
  ) as Record<V3Variant, Record<string, ReturnType<typeof u10Contrast>>>;
  const firstTakeoffs = recall["V1"]!;
  const decideInput: DecideInput = {
    premanifest_late: false,
    judge: {
      failed: judged.length === 0,
      kappa: null,
      agreement: null,
      selection_support: selectionSupport.length,
    },
    recall: { takeoffs: firstTakeoffs.takeoffs, inc040_denominator: firstTakeoffs.takeoffs_inc040 },
    variants: Object.fromEntries(
      V3_VARIANTS.map((v) => [
        v,
        {
          eligible: eligible[v].eligible,
          u10: eligible[v].eligible ? meanU10(index, v, selectionSupport) : null,
          recall_inc040: recall[v]!.recall_inc040,
        },
      ]),
    ) as DecideInput["variants"],
    r4: Object.fromEntries(
      V3_VARIANTS.map((v) => {
        const c = contrasts[v]["R4"]!;
        return [
          v,
          c.diff === null
            ? null
            : {
                diff: c.diff,
                low: c.families.low,
                high: c.families.high,
                estimable: c.families.estimable,
                support: c.support,
              },
        ];
      }),
    ) as DecideInput["r4"],
  };
  return {
    schema: "earlyscript.v3-dev-metrics/1",
    p4_sha256: p4DefinitionHash(),
    cutoffs: [...cutoffs],
    list_days: V3_LIST_DAYS,
    takeoffs: takeoffs.map((t) => ({
      T: t.T,
      topic_id: t.topic_id,
      include_score: t.include_score,
      label: t.label,
    })),
    unknown: unknown.map((l) => ({ cutoff: l.cutoff, topic_id: l.topic_id, reasons: l.reasons })),
    recall_evaluable: recallEvaluable(firstTakeoffs.takeoffs, firstTakeoffs.takeoffs_inc040),
    captures: rows,
    recall,
    eligibility: eligible,
    u10: {
      judged_cuts: judged.length,
      selection_support: selectionSupport,
      per_arm_support_valid: Object.fromEntries(
        V3_ARMS.map((arm) => [arm, pairedSupport(index, [arm], cutoffs).length]),
      ),
      contrasts,
    },
    decide_input: decideInput,
    labels,
  };
}

/** The p4 labels of every cutoff as JSON lines (one file per cutoff). */
export function writeLabels(dir: string, labels: ReadonlyMap<string, ReadonlyArray<unknown>>) {
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const [cutoff, list] of labels)
    NodeFS.writeFileSync(
      NodePath.join(dir, `etiquetas-p4-${cutoff}.jsonl`),
      list.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
}
