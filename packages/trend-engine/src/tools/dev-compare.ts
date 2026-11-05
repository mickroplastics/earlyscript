// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - offline tool.
//   node src/tools/dev-compare.ts --arm v1w=<runs-dir>:weighted --arm v1b=<runs-dir>:baseline \
//     --arm v2a=<runs-dir>:weighted --cache <judge-cache> --out <report.json> [--train-ids sample.jsonl]
// Development comparison of engine variants with the editorial judge, not the evaluation of
// record (U1 builds that). For each arm and cut: the top 5 of the arm's ranking, each topic
// shown to the judge as its label terms and the 5 most recent evidence headlines. P@5 has
// denominator 5: an empty place, "unsure", or a second topic of the same event (half or more
// of its evidence shared with a higher one) counts 0. With --train-ids, reports how many
// evidence items of the judged topics were relevance training items.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { Dossier } from "@earlyscript/editorial-contracts/dossier";

import { readRun } from "../check.ts";
import { DEFAULT_JUDGE_PATH, judgeEntries, loadJudge } from "./judge.ts";

export const TOPIC_HEADLINES = 5;

export function topicText(dossier: Dossier): string {
  const recent = dossier.evidence
    .toSorted((a, b) =>
      a.published_at > b.published_at ? -1 : a.published_at < b.published_at ? 1 : 0,
    )
    .slice(0, TOPIC_HEADLINES);
  return `Topic key terms: ${dossier.trend.top_terms.slice(0, 6).join(", ")}\nRecent headlines:\n${recent
    .map((e) => `- ${e.title}`)
    .join("\n")}`;
}

const sameEvent = (a: Dossier, b: Dossier) => {
  const ids = new Set(a.evidence.map((e) => e.item_id));
  const shared = b.evidence.filter((e) => ids.has(e.item_id)).length;
  return shared * 2 >= Math.min(a.evidence.length, b.evidence.length);
};

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      arm: { type: "string", multiple: true },
      cache: { type: "string" },
      out: { type: "string" },
      "train-ids": { type: "string" },
      judge: { type: "string" },
    },
  });
  if (!values.arm || !values.cache || !values.out) {
    console.error(
      "usage: dev-compare --arm name=<runs-dir>:weighted|baseline ... --cache <dir> --out <json>",
    );
    return 64;
  }
  const arms = values.arm.map((spec) => {
    const [name, rest] = spec.split("=");
    const [dir, ranking] = rest!.split(":");
    if (ranking !== "weighted" && ranking !== "baseline") throw new Error(`bad arm ${spec}`);
    return { name: name!, dir: dir!, ranking: ranking as "weighted" | "baseline" };
  });
  const tops: Array<{ arm: string; cut: string; dossiers: Array<Dossier>; emitted: number }> = [];
  for (const arm of arms) {
    for (const entry of NodeFS.readdirSync(arm.dir).toSorted()) {
      if (!entry.startsWith("run_")) continue;
      const { record, dossiers } = readRun(NodePath.join(arm.dir, entry));
      if (record.status !== "ok") throw new Error(`${entry} failed`);
      const ordered = dossiers.toSorted(
        (a, b) => a.rankings[arm.ranking].position - b.rankings[arm.ranking].position,
      );
      tops.push({
        arm: arm.name,
        cut: record.cutoff_at.slice(0, 10),
        dossiers: ordered.slice(0, 5),
        emitted: dossiers.length,
      });
    }
  }
  const entries = tops.flatMap((t) =>
    t.dossiers.map((d) => ({ id: `${t.cut}/${d.trend.id}`, text: topicText(d) })),
  );
  const judge = loadJudge(values.judge ?? DEFAULT_JUDGE_PATH);
  const { labels, stats } = await judgeEntries(entries, {
    judge,
    cacheDir: values.cache,
    concurrency: 3,
    log: (line) => console.error(line),
  });
  const labelOf = new Map(labels.map((l) => [l.id, l]));
  const trainIds = values["train-ids"]
    ? new Set(
        NodeFS.readFileSync(values["train-ids"], "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => (JSON.parse(l) as { id: string }).id),
      )
    : null;
  const perArm: Record<string, unknown> = {};
  const topics: Array<Record<string, unknown>> = [];
  for (const arm of arms) {
    const cuts = tops
      .filter((t) => t.arm === arm.name)
      .toSorted((a, b) => (a.cut < b.cut ? -1 : 1));
    const p5 = cuts.map((t) => {
      let hits = 0;
      t.dossiers.forEach((d, k) => {
        const label = labelOf.get(`${t.cut}/${d.trend.id}`)!;
        const duplicate = t.dossiers.slice(0, k).some((e) => sameEvent(e, d));
        if (label.label === "yes" && !duplicate) hits++;
        topics.push({
          arm: arm.name,
          cut: t.cut,
          position: k + 1,
          trend_id: d.trend.id,
          label: label.label,
          reason: label.reason,
          duplicate,
          relevance: d.relevance?.score ?? null,
          include_score: d.profile_fit.include_score,
          eligibility: d.relevance?.eligibility ?? null,
          terms: d.trend.top_terms.slice(0, 6),
          training_items_in_evidence: trainIds
            ? d.evidence.filter((e) => trainIds.has(e.item_id)).length
            : null,
        });
      });
      return { cut: t.cut, p_at_5: hits / 5, emitted: t.emitted, in_top5: t.dossiers.length };
    });
    perArm[arm.name] = {
      dir: arm.dir,
      ranking: arm.ranking,
      mean_p_at_5: p5.reduce((s, c) => s + c.p_at_5, 0) / Math.max(1, p5.length),
      min_emitted: Math.min(...p5.map((c) => c.emitted)),
      cuts: p5,
    };
  }
  const report = {
    judge_hash: judge.hash,
    judge_stats: stats,
    rule: "P@5 denominator 5; empty, unsure and same-event repeats count 0",
    arms: perArm,
    topics,
  };
  NodeFS.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(perArm).map(([k, v]) => [
          k,
          {
            mean_p_at_5: (v as { mean_p_at_5: number }).mean_p_at_5,
            min_emitted: (v as { min_emitted: number }).min_emitted,
          },
        ]),
      ),
    ),
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
