// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off globalDate:off - offline tool.
//   node src/tools/relevance-train.ts --sample sample.jsonl --labels labels.jsonl --cache <sqlite> \
//     --models <dir> --out config/relevance.v1.json --report report.json \
//     [--profile profile.json --query-instruction "<text>"] [--workers 3] [--calibration provisional|accepted]
//     [--lambdas 0.03,0.1,0.3]
// Trains the relevance probe on judge labels ("unsure" dropped) over the Qwen vectors of
// the run's own item texts, chooses the penalty and the item threshold by cross-validation
// over blocks of whole days, and writes the model file the engine configuration names.
// The repo formatter repacks the weights array without changing a number: record in the
// configuration the sha256 of the file as committed, after `vp fmt`.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import { ChannelProfile } from "@earlyscript/editorial-contracts/profile";

import { dot } from "../cluster.ts";
import { createLocalEmbedder } from "../embed/local.ts";
import { embeddingSpec } from "../embed/spec.ts";
import { canonicalJson, sha256 } from "../hash.ts";
import { RELEVANCE_SCHEMA_VERSION } from "../relevance.ts";
import { asQuery, DEFAULT_CONFIG_PATH, loadConfig } from "../run.ts";
import { DEFAULT_JUDGE_PATH, loadJudge } from "./judge.ts";
import { auc, confusion, fitLogistic, type LogisticFit, logLoss, predict } from "./logistic.ts";
import type { SampleRow } from "./relevance-sample.ts";

const decodeProfile = Schema.decodeUnknownSync(ChannelProfile);

export const LAMBDAS = [0.01, 0.03, 0.1, 0.3, 1, 3, 10];
export const FOLDS = 5;

const readJsonl = <T>(path: string): Array<T> =>
  NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

/** Contiguous blocks of whole days with about the same number of rows each. */
export function dayFolds(days: ReadonlyArray<string>, folds: number): Array<number> {
  const counts = new Map<string, number>();
  for (const day of days) counts.set(day, (counts.get(day) ?? 0) + 1);
  const ordered = [...counts].toSorted(([a], [b]) => (a < b ? -1 : 1));
  const foldOfDay = new Map<string, number>();
  let seen = 0;
  for (const [day, count] of ordered) {
    foldOfDay.set(day, Math.min(folds - 1, Math.floor((seen * folds) / days.length)));
    seen += count;
  }
  return days.map((day) => foldOfDay.get(day)!);
}

function crossValidate(
  vectors: ReadonlyArray<Float32Array>,
  labels: ReadonlyArray<number>,
  fold: ReadonlyArray<number>,
  lambda: number,
): Array<number> {
  const oof = new Array<number>(vectors.length).fill(0);
  for (let f = 0; f < FOLDS; f++) {
    const train = vectors.flatMap((_, i) => (fold[i] === f ? [] : [i]));
    const test = vectors.flatMap((_, i) => (fold[i] === f ? [i] : []));
    if (test.length === 0) continue;
    const fit = fitLogistic(
      train.map((i) => vectors[i]!),
      train.map((i) => labels[i]!),
      lambda,
    );
    for (const i of test) oof[i] = predict(fit, vectors[i]!);
  }
  return oof;
}

const r6 = (x: number | null) => (x === null ? null : Math.round(x * 1e6) / 1e6);

function bestThreshold(probs: ReadonlyArray<number>, labels: ReadonlyArray<number>) {
  let best = { threshold: 0.5, f1: -1 };
  for (let t = 5; t <= 95; t++) {
    const { f1 } = confusion(probs, labels, t / 100);
    if (f1 > best.f1 + 1e-12) best = { threshold: t / 100, f1 };
  }
  return best.threshold;
}

function metrics(probs: ReadonlyArray<number>, labels: ReadonlyArray<number>, threshold: number) {
  const c = confusion(probs, labels, threshold);
  return {
    n: probs.length,
    positives: labels.filter((y) => y === 1).length,
    auc: r6(auc(probs, labels)),
    log_loss: r6(logLoss(probs, labels)),
    precision: r6(c.precision),
    recall: r6(c.recall),
    f1: r6(c.f1),
    accuracy: r6(c.accuracy),
  };
}

/** Separation of a score between labels: AUC and the gap of the means. */
function separation(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>) {
  const yes = scores.filter((_, i) => labels[i] === 1);
  const no = scores.filter((_, i) => labels[i] === 0);
  const mean = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    auc: r6(auc(scores, labels)),
    mean_yes: r6(mean(yes)),
    mean_no: r6(mean(no)),
    gap: r6(mean(yes) - mean(no)),
  };
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      sample: { type: "string" },
      labels: { type: "string" },
      cache: { type: "string" },
      models: { type: "string" },
      out: { type: "string" },
      report: { type: "string" },
      oof: { type: "string" },
      profile: { type: "string" },
      "query-instruction": { type: "string" },
      workers: { type: "string" },
      judge: { type: "string" },
      "model-id": { type: "string" },
      calibration: { type: "string" },
      lambdas: { type: "string" },
      targets: { type: "string" },
    },
  });
  if (!values.sample || !values.labels || !values.cache || !values.models || !values.out) {
    console.error(
      "usage: relevance-train --sample <jsonl> --labels <jsonl> --cache <sqlite> --models <dir> --out <model.json> [--report <json>] [--oof <jsonl>] [--profile <json> --query-instruction <text>]",
    );
    return 64;
  }
  const log = (line: string) => console.error(line);
  const { config } = loadConfig(DEFAULT_CONFIG_PATH);
  const judge = loadJudge(values.judge ?? DEFAULT_JUDGE_PATH);
  const sampleBytes = NodeFS.readFileSync(values.sample);
  const labelBytes = NodeFS.readFileSync(values.labels);
  const sample = readJsonl<SampleRow>(values.sample);
  const labelOf = new Map(
    readJsonl<{ id: string; label: string }>(values.labels).map((l) => [l.id, l.label]),
  );
  // Judge label -> training target; labels outside the map ("unsure") are dropped.
  const targets = new Map<string, number>(
    (values.targets ?? "yes=1,no=0").split(",").map((pair) => {
      const [label, value] = pair.split("=");
      return [label!, Number(value)];
    }),
  );
  const rows = sample
    .filter((row) => targets.has(labelOf.get(row.id) ?? ""))
    .toSorted((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id < b.id ? -1 : 1));
  const unsure = sample.filter(
    (row) => labelOf.has(row.id) && !targets.has(labelOf.get(row.id)!),
  ).length;
  const unlabeled = sample.filter((row) => !labelOf.has(row.id)).length;
  const labels = rows.map((row) => targets.get(labelOf.get(row.id)!)!);
  // Metrics, threshold and separation are on the binary question: any positive target is a yes.
  const binary = labels.map((y) => (y > 0 ? 1 : 0));
  const topTarget = Math.max(...targets.values());
  const core = labels.map((y) => (y === topTarget ? 1 : 0));

  const spec = embeddingSpec(config.embedder);
  const embedder = createLocalEmbedder(spec, {
    cacheFile: values.cache,
    modelDir: values.models,
    workers: values.workers ? Number(values.workers) : 2,
    allowDownload: false,
    log,
  });
  let vectors: Array<Float32Array>;
  let topics: { label: string; include: Array<Float32Array>; exclude: Array<Float32Array> }[] = [];
  try {
    vectors = await embedder.embed(rows.map((row) => row.embed_text));
    if (values.profile) {
      const profile = decodeProfile(JSON.parse(NodeFS.readFileSync(values.profile, "utf8")));
      const instructions: Array<[string, string | undefined]> = [["document", undefined]];
      if (values["query-instruction"]) instructions.push(["query", values["query-instruction"]]);
      for (const [label, instruction] of instructions)
        topics.push({
          label,
          include: await embedder.embed(profile.include.map((t) => asQuery(instruction, t))),
          exclude: await embedder.embed(profile.exclude.map((t) => asQuery(instruction, t))),
        });
    }
  } finally {
    await embedder.dispose();
  }

  const fold = dayFolds(
    rows.map((row) => row.day),
    FOLDS,
  );
  const lambdas = values.lambdas ? values.lambdas.split(",").map(Number) : LAMBDAS;
  const grid = lambdas.map((lambda) => {
    const t0 = performance.now();
    const oof = crossValidate(vectors, labels, fold, lambda);
    log(`lambda ${lambda}: ${Math.round(performance.now() - t0)} ms`);
    return { lambda, oof, log_loss: logLoss(oof, labels) };
  });
  const chosen = grid.reduce((best, g) => (g.log_loss < best.log_loss - 1e-12 ? g : best));
  const threshold = bestThreshold(chosen.oof, binary);
  const fit: LogisticFit = fitLogistic(vectors, labels, chosen.lambda);

  const bySource: Record<string, unknown> = {};
  for (const source of [...new Set(rows.map((r) => r.source))].toSorted()) {
    const idx = rows.flatMap((r, i) => (r.source === source ? [i] : []));
    bySource[source] = metrics(
      idx.map((i) => chosen.oof[i]!),
      idx.map((i) => binary[i]!),
      threshold,
    );
  }
  const trainingRows = rows.map((row, i) => ({
    id: row.id,
    embed_text_sha256: sha256(row.embed_text),
    label: labels[i],
  }));
  const model = {
    schema_version: RELEVANCE_SCHEMA_VERSION,
    model_id: values["model-id"] ?? "relevance.v1",
    method: "logistic_l2.newton",
    embedding: {
      model: config.embedder.model,
      revision: config.embedder.revision,
      dtype: config.embedder.dtype,
      pooling: config.embedder.pooling,
    },
    weights: [...fit.weights].map((w) => Number(w.toPrecision(12))),
    bias: Number(fit.bias.toPrecision(12)),
    threshold,
    training: {
      rows: rows.length,
      positives: binary.filter((y) => y === 1).length,
      negatives: binary.filter((y) => y === 0).length,
      targets: Object.fromEntries(targets),
      by_label: Object.fromEntries(
        [...targets.keys()].map((label) => [
          label,
          rows.filter((r) => labelOf.get(r.id) === label).length,
        ]),
      ),
      unsure_dropped: unsure,
      unlabeled_dropped: unlabeled,
      published_before: rows.reduce((max, r) => (r.day > max ? r.day : max), ""),
      first_day: rows[0]?.day ?? null,
      by_source: Object.fromEntries(
        Object.entries(bySource).map(([s, m]) => [
          s,
          { n: (m as { n: number }).n, positives: (m as { positives: number }).positives },
        ]),
      ),
      data_sha256: sha256(canonicalJson(trainingRows)),
      sample_sha256: sha256(sampleBytes),
      labels_sha256: sha256(labelBytes),
      judge_hash: judge.hash,
      judge_rubric_sha256: judge.config.rubric_sha256,
      judge_model: judge.config.model,
      judge_calibration: values.calibration ?? "provisional",
      embedding_platform: `${spec.platform}/${spec.arch}`,
      lambda: chosen.lambda,
      iterations: fit.iterations,
    },
    cv: {
      folds: FOLDS,
      fold_rule: "contiguous blocks of whole days, about equal rows",
      lambda_grid: grid.map((g) => ({ lambda: g.lambda, log_loss: r6(g.log_loss) })),
      threshold_rule: "maximum F1 of out-of-fold probabilities, thresholds 0.05 to 0.95",
      overall: metrics(chosen.oof, binary, threshold),
      log_loss_graded: r6(chosen.log_loss),
      core_vs_rest_auc: r6(auc(chosen.oof, core)),
      by_source: bySource,
    },
  };
  NodeFS.writeFileSync(values.out, `${JSON.stringify(model, null, 2)}\n`);
  const modelHash = sha256(NodeFS.readFileSync(values.out));

  const baselines: Record<string, unknown> = {
    relevance_oof: separation(chosen.oof, binary),
  };
  for (const t of topics) {
    const include = vectors.map((v) => Math.max(...t.include.map((u) => dot(v, u))));
    const exclude = vectors.map((v) => Math.max(...t.exclude.map((u) => dot(v, u))));
    baselines[`profile_include_${t.label}`] = separation(include, binary);
    baselines[`profile_margin_${t.label}`] = separation(
      include.map((x, i) => x - exclude[i]!),
      binary,
    );
  }
  if (values.oof)
    NodeFS.writeFileSync(
      values.oof,
      rows
        .map(
          (row, i) =>
            `${JSON.stringify({ id: row.id, source: row.source, day: row.day, label: labels[i], fold: fold[i], oof: r6(chosen.oof[i]!) })}\n`,
        )
        .join(""),
    );
  const report = {
    model: values.out,
    model_sha256: modelHash,
    query_instruction: values["query-instruction"] ?? null,
    cv: model.cv,
    training: model.training,
    separation_items: baselines,
  };
  if (values.report) NodeFS.writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      model_sha256: modelHash,
      cv: model.cv.overall,
      lambda: chosen.lambda,
      threshold,
    }),
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
