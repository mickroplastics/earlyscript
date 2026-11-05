// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - command-line entry point.
// engine eval-editorial pool|cards|cards-html|hn-labels|score|seal|capture (protocol P1.1).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import { SourceId } from "@earlyscript/editorial-contracts/source";

import { httpTraceWriter } from "./collect.ts";
import { captureDay } from "./editorial-capture.ts";
import { writeFollowupLabels } from "./editorial-followup.ts";
import { cardEntries, judgeCards, judgeLabelsFile, topicCards } from "./editorial-judge.ts";
import { DEFAULT_JUDGE_PATH, type JudgedEntry, loadJudge } from "./tools/judge.ts";
import { runScore } from "./editorial-score.ts";
import { liveSources, readRssFeedList } from "./sources/index.ts";
import {
  appendLedger,
  assertCheckout,
  assertSealed,
  buildTopicCards,
  freezeEntry,
  readRankings,
  candidateArm,
  withRepeats,
  DEFAULT_CARD_SEED,
  EVAL_SOURCES,
  fileSha256,
  parseArm,
  parseCutoffList,
  readCardsJsonl,
  readUniverse,
  referenceArms,
  runPool,
  writeCardSet,
} from "./editorial-eval.ts";

const isSourceId = Schema.is(SourceId);

export const EDITORIAL_USAGE =
  "usage: engine eval-editorial pool --corpus <dir> --profile <file> --out <dir> --cutoffs <days> (--references | --candidate-v2 | --arm <name>=<config.json>[:baseline|:weighted|:keywords=<file>] ...) [--sources <ids>] [--top 5] [--ledger <ledger.jsonl>] [--registry dev=<families.json>] [--no-cards] [--seed n] [--workers n] [--cache <sqlite>] [--cache-only] [--models <dir>]\n" +
  "       engine eval-editorial cards --universe <universe.json> [--rankings <rankings.json> --ledger <ledger.jsonl>] --out <dir> [--name <set>] [--cutoffs <days>] [--sample N] [--seed S] [--repeat 10]\n" +
  "       engine eval-editorial cards-html --cards <cards.jsonl> --out <dir> [--name <set>] [--title <text>]\n" +
  "       engine eval-editorial hn-labels --universe <universe.json> --corpus <dir> --out <labels-hn.json> [--cache <sqlite>] [--cache-only] [--models <dir>] [--workers n]\n" +
  "       engine eval-editorial score --universe <universe.json> --rankings <rankings.json> (--labels <file> | --migrate-labels <labels>=<cards.jsonl>) ... --out <dir> [--dev <days>] [--retro <days>] [--prospective <days>] [--partition <name>=<days> ...] [--candidate <arm> ...] [--reference <arm> ...] [--ledger <ledger.jsonl>] [--bootstrap 2000] [--seed n] [--block-days 7]\n" +
  "       engine eval-editorial judge --cards <cards.jsonl> (--out <labels.json> --judge-cache <dir> | --entries-out <entries.jsonl> | --judged <judge-output.jsonl> --out <labels.json>) [--universe <universe.json>] [--judge <judge.json>] [--concurrency n]\n" +
  "       engine eval-editorial freeze --ledger <ledger.jsonl> --profile <file> (--references | --candidate-v2 | --arm …) [--sources <ids>] [--registry dev=<families.json>] --file <path> [--file …] [--note <text>]\n" +
  "       engine eval-editorial seal --ledger <ledger.jsonl> --kind <note|…> [--file <path> ...] [--note <text>]\n" +
  "       engine eval-editorial capture --corpus <dir> --ledger <ledger.jsonl> --snapshots <dir> [--day <YYYY-MM-DD>] [--first-day <day>] [--last-day <day>] [--sources <ids>] [--rss-feeds <file.json>] [--seed-from <corpus>]";

/** `name=path` pairs, as for --registry dev=<families.json>. */
function namedPaths(pairs: ReadonlyArray<string>): Record<string, string> {
  return Object.fromEntries(
    pairs.map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`${pair}: expected <name>=<path>`);
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}

function sourceList(text: string): Array<SourceId> {
  const ids = [...new Set(text.split(",").map((id) => id.trim()))];
  if (!ids.every(isSourceId)) throw new Error(`Unknown source in ${text}`);
  return ids;
}

export async function editorialCommand(argv: ReadonlyArray<string>): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = NodeUtil.parseArgs({
    args: [...rest],
    options: {
      corpus: { type: "string" },
      profile: { type: "string" },
      out: { type: "string" },
      cutoffs: { type: "string" },
      arm: { type: "string", multiple: true },
      references: { type: "boolean" },
      "candidate-v2": { type: "boolean" },
      judge: { type: "string" },
      "judge-cache": { type: "string" },
      "entries-out": { type: "string" },
      registry: { type: "string", multiple: true },
      partition: { type: "string", multiple: true },
      repeat: { type: "string" },
      "migrate-labels": { type: "string", multiple: true },
      judged: { type: "string" },
      concurrency: { type: "string" },
      sources: { type: "string" },
      top: { type: "string" },
      ledger: { type: "string" },
      "no-cards": { type: "boolean" },
      seed: { type: "string" },
      workers: { type: "string" },
      cache: { type: "string" },
      "cache-only": { type: "boolean" },
      models: { type: "string" },
      "allow-unverified-corpus": { type: "boolean" },
      universe: { type: "string" },
      rankings: { type: "string" },
      name: { type: "string" },
      title: { type: "string" },
      sample: { type: "string" },
      cards: { type: "string" },
      labels: { type: "string", multiple: true },
      dev: { type: "string" },
      retro: { type: "string" },
      prospective: { type: "string" },
      candidate: { type: "string", multiple: true },
      reference: { type: "string", multiple: true },
      bootstrap: { type: "string" },
      "block-days": { type: "string" },
      kind: { type: "string" },
      file: { type: "string", multiple: true },
      note: { type: "string" },
      snapshots: { type: "string" },
      day: { type: "string" },
      "first-day": { type: "string" },
      "last-day": { type: "string" },
      "rss-feeds": { type: "string" },
      "seed-from": { type: "string" },
    },
  });
  const log = (line: string) => console.error(line);
  const embedding = {
    ...(values.workers ? { workers: Number(values.workers) } : {}),
    ...(values.cache ? { cacheFile: values.cache } : {}),
    ...(values["cache-only"] ? { cacheOnly: true } : {}),
    ...(values.models ? { modelDir: values.models } : {}),
    ...(values["allow-unverified-corpus"] ? { allowUnverifiedCorpus: true } : {}),
  };
  if (sub === "pool" && values.corpus && values.profile && values.out && values.cutoffs) {
    const arms = [
      ...(values.references ? referenceArms() : []),
      ...(values["candidate-v2"] ? [candidateArm()] : []),
      ...(values.arm ?? []).map(parseArm),
    ];
    const result = await runPool({
      ...embedding,
      log,
      corpusDir: values.corpus,
      profilePath: values.profile,
      outDir: values.out,
      cutoffs: parseCutoffList(values.cutoffs),
      arms,
      sources: values.sources ? sourceList(values.sources) : EVAL_SOURCES,
      ...(values.top ? { top: Number(values.top) } : {}),
      ...(values.ledger ? { ledgerPath: values.ledger } : {}),
      ...(values["no-cards"] ? { cards: false } : {}),
      ...(values.seed ? { cardSeed: Number(values.seed) } : {}),
      ...(values.registry ? { registries: namedPaths(values.registry) } : {}),
      ...(values.ledger ? { checkout: true } : {}),
    });
    console.log(
      JSON.stringify({
        universe: result.universePath,
        universe_hash: result.universe.universe_hash,
        rankings: result.rankingsPath,
        rankings_hash: result.rankings.rankings_hash,
        topics: result.universe.logical.topics.length,
        families: result.universe.logical.families.length,
        cards: result.cardsPath,
      }),
    );
    return 0;
  }
  if (sub === "cards" && values.universe && values.out) {
    const universe = readUniverse(values.universe);
    const seed = values.seed ? Number(values.seed) : DEFAULT_CARD_SEED;
    const cards = withRepeats(
      buildTopicCards(universe, {
        seed,
        ...(values.cutoffs ? { cutoffs: parseCutoffList(values.cutoffs) } : {}),
        ...(values.sample ? { sample: Number(values.sample) } : {}),
      }),
      { count: values.repeat ? Number(values.repeat) : 0, seed: seed + 3 },
    );
    const prospective = universe.logical.cutoffs.some((c) => c.prospective);
    if (values.ledger || prospective) {
      if (!values.ledger || !values.rankings) {
        throw new Error("sealed or prospective cards need --ledger and --rankings");
      }
      assertCheckout(assertSealed(universe, readRankings(values.rankings), values.ledger));
    }
    const name = values.name ?? "cards";
    const written = writeCardSet(cards, values.out, name, {
      universeHash: universe.universe_hash,
      title: values.title ?? "Tarjetas de temas",
    });
    console.log(
      JSON.stringify({ ...written, cards: cards.length, universe_hash: universe.universe_hash }),
    );
    return 0;
  }
  if (sub === "cards-html" && values.cards && values.out) {
    const cards = readCardsJsonl(values.cards);
    const name = values.name ?? NodePath.basename(values.cards).replace(/\.jsonl$/, "");
    const written = writeCardSet(cards, values.out, name, {
      title:
        values.title ?? (cards.every((c) => c.unit === "item") ? "Tarjetas de ítems" : "Tarjetas"),
    });
    console.log(JSON.stringify({ ...written, cards: cards.length }));
    return 0;
  }
  if (sub === "hn-labels" && values.universe && values.corpus && values.out) {
    const result = await writeFollowupLabels({
      ...embedding,
      log,
      universePath: values.universe,
      corpusDir: values.corpus,
      out: values.out,
    });
    const counts: Record<string, number> = {};
    for (const l of result.labels) counts[l.label] = (counts[l.label] ?? 0) + 1;
    console.log(JSON.stringify({ path: result.path, sha256: result.sha256, labels: counts }));
    return 0;
  }
  if (
    sub === "score" &&
    values.universe &&
    values.rankings &&
    (values.labels || values["migrate-labels"]) &&
    values.out
  ) {
    const result = await runScore({
      universePath: values.universe,
      rankingsPath: values.rankings,
      labelPaths: values.labels ?? [],
      ...(values["migrate-labels"]
        ? {
            migrateLabels: values["migrate-labels"].map((pair) => {
              const [labels, cards] = pair.split("=");
              if (!labels || !cards)
                throw new Error(`--migrate-labels ${pair}: expected <labels>=<cards.jsonl>`);
              return { labels, cards };
            }),
          }
        : {}),
      outDir: values.out,
      ...(values.dev ? { dev: parseCutoffList(values.dev) } : {}),
      ...(values.retro ? { retro: parseCutoffList(values.retro) } : {}),
      ...(values.prospective ? { prospective: parseCutoffList(values.prospective) } : {}),
      ...(values.partition
        ? {
            partitions: Object.fromEntries(
              Object.entries(namedPaths(values.partition)).map(([name, days]) => [
                name,
                parseCutoffList(days),
              ]),
            ),
          }
        : {}),
      ...(values.candidate ? { candidates: values.candidate } : {}),
      ...(values.reference ? { references: values.reference } : {}),
      ...(values.ledger ? { ledgerPath: values.ledger, checkout: true } : {}),
      ...(values.bootstrap ? { replicates: Number(values.bootstrap) } : {}),
      ...(values.seed ? { seed: Number(values.seed) } : {}),
      ...(values["block-days"] ? { blockDays: Number(values["block-days"]) } : {}),
    });
    console.log(
      JSON.stringify({
        metrics: result.metricsPath,
        report: result.reportPath,
        metrics_hash: result.metrics.metrics_hash,
      }),
    );
    return 0;
  }
  if (sub === "capture" && values.corpus && values.ledger && values.snapshots) {
    const sources = values.sources ? sourceList(values.sources) : [...EVAL_SOURCES];
    const rssFeeds = values["rss-feeds"] ? await readRssFeedList(values["rss-feeds"]) : undefined;
    const traceDir = values.corpus;
    const result = await captureDay({
      log,
      corpusDir: values.corpus,
      ledgerPath: values.ledger,
      snapshotsDir: values.snapshots,
      sources,
      adapters: (ids) => {
        const { file, trace } = httpTraceWriter(traceDir);
        console.error(`HTTP trace: ${file}`);
        return liveSources(ids, { trace }, rssFeeds ? { rssFeeds } : {});
      },
      ...(values.day ? { day: values.day } : {}),
      ...(values["first-day"] ? { firstDay: values["first-day"] } : {}),
      ...(values["last-day"] ? { lastDay: values["last-day"] } : {}),
      ...(values["seed-from"] ? { seedFrom: values["seed-from"] } : {}),
    });
    console.log(JSON.stringify(result));
    return 0;
  }
  if (sub === "judge" && values.cards && values["entries-out"]) {
    const entries = cardEntries(topicCards(values.cards));
    NodeFS.writeFileSync(
      values["entries-out"],
      entries.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    console.log(JSON.stringify({ entries: entries.length, path: values["entries-out"] }));
    return 0;
  }
  if (sub === "judge" && values.cards && values.judged && values.out) {
    const out = judgeLabelsFile({
      cardsPath: values.cards,
      judged: NodeFS.readFileSync(values.judged, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as JudgedEntry),
      judge: loadJudge(values.judge ?? DEFAULT_JUDGE_PATH),
      universeHash: values.universe ? readUniverse(values.universe).universe_hash : null,
    });
    NodeFS.writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`);
    const counts: Record<string, number> = {};
    for (const l of out.labels) counts[l.label] = (counts[l.label] ?? 0) + 1;
    console.log(JSON.stringify({ path: values.out, labels: counts }));
    return 0;
  }
  if (sub === "judge" && values.cards && values.out && values["judge-cache"]) {
    const result = await judgeCards({
      log,
      cardsPath: values.cards,
      out: values.out,
      cacheDir: values["judge-cache"],
      ...(values.judge ? { judgePath: values.judge } : {}),
      ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
      ...(values.universe ? { universeHash: readUniverse(values.universe).universe_hash } : {}),
    });
    const counts: Record<string, number> = {};
    for (const l of result.labels) counts[l.label] = (counts[l.label] ?? 0) + 1;
    console.log(JSON.stringify({ path: result.path, stats: result.stats, labels: counts }));
    return 0;
  }
  if (sub === "freeze" && values.ledger && values.profile) {
    const arms = [
      ...(values.references ? referenceArms() : []),
      ...(values["candidate-v2"] ? [candidateArm()] : []),
      ...(values.arm ?? []).map(parseArm),
    ];
    if (arms.length === 0) throw new Error("freeze needs the arms the pool will run");
    const entry = appendLedger(
      values.ledger,
      freezeEntry({
        arms,
        sources: values.sources ? sourceList(values.sources) : EVAL_SOURCES,
        profilePath: values.profile,
        files: values.file ?? [],
        ...(values.registry ? { registries: namedPaths(values.registry) } : {}),
        ...(values.note ? { note: values.note } : {}),
      }),
    );
    console.log(JSON.stringify(entry));
    return 0;
  }
  if (sub === "seal" && values.ledger && values.kind) {
    if (values.kind === "freeze")
      throw new Error("use `eval-editorial freeze`: a freeze names every artifact");
    const entry = appendLedger(values.ledger, {
      kind: values.kind,
      files: (values.file ?? []).map((path) => ({
        path: NodePath.resolve(path),
        sha256: fileSha256(path),
      })),
      ...(values.note ? { note: values.note } : {}),
    });
    console.log(JSON.stringify(entry));
    return 0;
  }
  console.error(EDITORIAL_USAGE);
  return 64;
}
