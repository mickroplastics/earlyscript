// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - command-line entry point.
//   node src/cli.ts run --corpus <dir> --cutoff <iso> --profile <file> --out <dir> [--config <file>] [--workers n] [--cache <sqlite>] [--cache-only] [--models <dir>] [--allow-unverified-corpus]
//   node src/cli.ts check --run <run_dir> [--rerun --out <dir>]
//   node src/cli.ts backtest --corpus <dir> --profile <file> --out <dir> --cutoffs 2026-10-17..2026-10-30 --baseline hn,github --candidate hn,github,npm [--truth hn,github] [--config <file>] [--workers n] [--cache <sqlite>] [--cache-only] [--models <dir>]
//   node src/cli.ts check --backtest <backtest.json> [--rerun --out <dir>]
//   node src/cli.ts repair-robots-override --corpus <dir> --source arxiv
//   node src/cli.ts model status|prepare [--models <dir>]
//   node src/cli.ts purge --corpus <dir> --source <id> (--author <name|bluesky did> | --url <permalink|bluesky at-uri> | --feed <feed-url>)
//   node src/cli.ts v3 lists --corpus <dir> --cutoff <day|day,day|from..to> --arm <V1|V2|V3|V4|R4|R2|R5|v1|v2|all|A,B> --out <file.json|dir> [--bags <dir>] [--runs <dir>] [--dev <days>] [--lists <days>] [--config <file>] [--profile <file>] [--cache <sqlite>] [--cache-only] [--models <dir>] [--workers n]
//   node src/cli.ts eval-editorial pool|cards|cards-html|hn-labels|score|seal|capture ... (see editorial-cli.ts)
//   node src/cli.ts v3 judge-diag|judge-score|judge-smoke ... (see judge-v3-cli.ts)
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { checkBacktest, parseCutoffList, runBacktest, runBacktestMatrix } from "./backtest.ts";
import { checkRun, rerunAndCheck } from "./check.ts";
import { collectCorpus, httpTraceWriter } from "./collect.ts";
import { editorialCommand } from "./editorial-cli.ts";
import { v3Command as v3JudgeCommand } from "./judge-v3-cli.ts";
import { purgeCorpus } from "./purge.ts";
import { repairRobotsOverrideTerms } from "./repair.ts";
import { liveSources, readRssFeedList } from "./sources/index.ts";
import * as Schema from "effect/Schema";
import { SourceId } from "@earlyscript/editorial-contracts/source";
import { defaultModelDir, modelStatus } from "./embed/model.ts";
import {
  classifyModelError,
  prepareModelCommand,
  type ModelCommandLine,
} from "./embed/modelCommand.ts";
import { DEFAULT_DATA_DIR, runEngine } from "./run.ts";
import { v3Command as v3ListsCommand } from "./v3-cli.ts";

/** A mirror of Hugging Face with the same layout, for tests and machines behind a proxy. */
const MODEL_BASE_URL_ENV = "EARLYSCRIPT_MODEL_BASE_URL";

const isSourceId = Schema.is(SourceId);

function sourceList(text: string): Array<SourceId> {
  const ids = [...new Set(text.split(",").map((id) => id.trim()))];
  if (!ids.every(isSourceId)) throw new Error(`Unknown source in ${text}`);
  return ids;
}

const USAGE =
  "usage: engine run --corpus <dir> --cutoff <iso> --profile <file> --out <dir> [--config <file>] [--workers n] [--cache <sqlite>] [--cache-only] [--models <dir>] [--allow-unverified-corpus]\n" +
  "       engine check --run <run_dir> [--rerun --out <dir>]\n" +
  "       engine backtest --corpus <dir> --profile <file> --out <dir> --cutoffs <day,day|from..to> --baseline <ids> --candidate <ids> [--candidate <ids> ...] [--independent-cuts] [--truth <ids>] [--config <file>] [--workers n] [--cache <sqlite>] [--cache-only] [--models <dir>] [--allow-unverified-corpus]\n" +
  "       engine check --backtest <backtest.json> [--rerun --out <dir> --corpus <dir> --profile <file>] [--cache <sqlite>] [--cache-only]\n" +
  "       engine collect --corpus <dir> --sources hn,github,lobsters,rss,huggingface,arxiv,wikipedia,npm,stackexchange,bluesky --from <day> --to <exclusive-day> [--rss-feeds <file.json>] [--force]\n" +
  "       engine v3 lists --corpus <dir> --cutoff <day|day,day|from..to> --arm <arm|A,B|all> --out <file.json|dir> [--bags <dir>] [--runs <dir>] [--dev <days>] [--lists <days>] [--config <file>] [--profile <file>] [--cache <sqlite>] [--cache-only] [--models <dir>] [--workers n]\n" +
  "       engine v3 judge-diag|judge-score|judge-smoke ... (see judge-v3-cli.ts)\n" +
  "       engine model status|prepare [--models <dir>]\n" +
  "       engine repair-robots-override --corpus <dir> --source <id>\n" +
  "       engine purge --corpus <dir> --source <id> (--author <name|bluesky did> | --url <permalink|bluesky at-uri> | --feed <feed-url>)";

/**
 * `model status` prints `{ status, revision, path, bytesPresent, bytesExpected }`; `model
 * prepare` downloads what is missing, printing `{ file, bytesDone, bytesTotal }` lines and
 * then `{ done: true, path }`. `--models` is the revision directory, as for `run`.
 */
async function modelCommand(argv: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { models: { type: "string" }, "lock-token": { type: "string" } },
  });
  const dir = values.models ?? defaultModelDir(DEFAULT_DATA_DIR);
  if (positionals.length === 1 && positionals[0] === "status") {
    console.log(JSON.stringify(await modelStatus(dir)));
    return 0;
  }
  if (positionals.length === 1 && positionals[0] === "prepare") {
    const baseUrl = process.env[MODEL_BASE_URL_ENV];
    const write = (line: ModelCommandLine) => console.log(JSON.stringify(line));
    try {
      await prepareModelCommand(dir, write, baseUrl ? { baseUrl } : {});
      return 0;
    } catch (error) {
      write({ error: classifyModelError(error) });
      return 1;
    }
  }
  console.error(USAGE);
  return 64;
}

/** `engine v3 <sub>`: one entry for the list builder (A) and the judges (B). */
function v3Command(argv: ReadonlyArray<string>): Promise<number> {
  const sub = argv[0];
  if (sub === "lists") return v3ListsCommand(argv);
  if (sub === "judge-diag" || sub === "judge-score" || sub === "judge-smoke") {
    return v3JudgeCommand(argv);
  }
  console.error(USAGE);
  return Promise.resolve(64);
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "model") return modelCommand(rest);
  if (command === "eval-editorial") return editorialCommand(rest);
  if (command === "v3") return v3Command(rest);
  const { values } = NodeUtil.parseArgs({
    args: [...rest],
    options: {
      from: { type: "string" },
      to: { type: "string" },
      sources: { type: "string" },
      "rss-feeds": { type: "string" },
      source: { type: "string" },
      author: { type: "string" },
      url: { type: "string" },
      uri: { type: "string" },
      feed: { type: "string" },
      force: { type: "boolean" },
      corpus: { type: "string" },
      cutoff: { type: "string" },
      profile: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      workers: { type: "string" },
      cache: { type: "string" },
      "cache-only": { type: "boolean" },
      "independent-cuts": { type: "boolean" },
      models: { type: "string" },
      run: { type: "string" },
      rerun: { type: "boolean" },
      "allow-unverified-corpus": { type: "boolean" },
      cutoffs: { type: "string" },
      baseline: { type: "string" },
      candidate: { type: "string", multiple: true },
      truth: { type: "string" },
      backtest: { type: "string" },
      // Ignored: the server tags the children it launches so it can tell them from a recycled pid.
      "lock-token": { type: "string" },
    },
  });
  if (command === "collect" && values.corpus && values.from && values.to && values.sources) {
    const ids = [...new Set(values.sources.split(","))];
    if (!ids.every(isSourceId)) throw new Error("Unknown source");
    const { file, trace } = httpTraceWriter(values.corpus);
    console.error(`HTTP trace: ${file}`);
    const rows = await collectCorpus({
      dir: values.corpus,
      from: values.from,
      to: values.to,
      adapters: liveSources(
        ids,
        { trace },
        values["rss-feeds"] ? { rssFeeds: await readRssFeedList(values["rss-feeds"]) } : {},
      ),
      ...(values.force ? { force: true } : {}),
    });
    console.log(JSON.stringify(rows));
    return 0;
  }
  if (command === "repair-robots-override" && values.corpus && values.source) {
    if (!isSourceId(values.source)) throw new Error("Unknown source");
    const repair = await repairRobotsOverrideTerms({ dir: values.corpus, source: values.source });
    console.log(JSON.stringify(repair));
    return 0;
  }
  if (command === "purge" && values.corpus && values.source) {
    if (!isSourceId(values.source)) throw new Error("Unknown source");
    // --uri is the spelling of the es/sources-earlywindow purge; --url the same match.
    const uri = values.url ?? values.uri;
    const purge = await purgeCorpus({
      dir: values.corpus,
      source: values.source,
      ...(values.author !== undefined ? { author: values.author } : {}),
      ...(uri !== undefined ? { uri } : {}),
      ...(values.feed !== undefined ? { feed: values.feed } : {}),
    });
    console.log(JSON.stringify(purge));
    return 0;
  }
  const log = (line: string) => console.error(line);
  const common = {
    log,
    ...(values.workers ? { workers: Number(values.workers) } : {}),
    ...(values.cache ? { cacheFile: values.cache } : {}),
    ...(values["cache-only"] ? { cacheOnly: true } : {}),
    ...(values.models ? { modelDir: values.models } : {}),
    ...(values["allow-unverified-corpus"] ? { allowUnverifiedCorpus: true } : {}),
  };
  // engine.v3.json names its profile; v1 and v2 need --profile.
  if (
    command === "run" &&
    values.corpus &&
    values.cutoff &&
    (values.profile || values.config) &&
    values.out
  ) {
    NodeFS.mkdirSync(values.out, { recursive: true });
    const record = await runEngine({
      ...common,
      corpusDir: values.corpus,
      cutoff: values.cutoff,
      profilePath: values.profile ?? "",
      outDir: values.out,
      ...(values.config ? { configPath: values.config } : {}),
    });
    const { run_id, status, error, dossiers, logical_hash, duration_ms, peak_rss_bytes } = record;
    console.log(
      JSON.stringify({
        run_id,
        status,
        error,
        dossiers,
        logical_hash,
        duration_ms,
        peak_rss_bytes,
      }),
    );
    return status === "ok" ? 0 : 1;
  }
  if (
    command === "backtest" &&
    values.corpus &&
    values.profile &&
    values.out &&
    values.cutoffs &&
    values.baseline &&
    values.candidate
  ) {
    const options = {
      ...common,
      corpusDir: values.corpus,
      profilePath: values.profile,
      outDir: values.out,
      cutoffs: parseCutoffList(values.cutoffs),
      baselineSources: sourceList(values.baseline),
      ...(values["independent-cuts"] ? { independentCuts: true } : {}),
      ...(values.truth ? { truthSources: sourceList(values.truth) } : {}),
      ...(values.config ? { configPath: values.config } : {}),
    };
    const candidateSourceSets = values.candidate.map(sourceList);
    const results =
      candidateSourceSets.length === 1
        ? [await runBacktest({ ...options, candidateSources: candidateSourceSets[0]! })]
        : await runBacktestMatrix({ ...options, candidateSourceSets });
    for (const result of results)
      console.log(
        JSON.stringify({
          path: result.path,
          backtest_id: result.report.backtest_id,
          logical_hash: result.report.logical_hash,
          status: result.status,
          total: result.total,
          verdict: result.verdict,
        }),
      );
    return 0;
  }
  if (command === "check" && values.backtest) {
    if (values.rerun && !values.out) {
      console.error(USAGE);
      return 64;
    }
    const result = await checkBacktest(
      values.backtest,
      values.rerun && values.out
        ? {
            outDir: values.out,
            options: {
              ...common,
              ...(values.corpus ? { corpusDir: values.corpus } : {}),
              ...(values.profile ? { profilePath: values.profile } : {}),
              ...(values["independent-cuts"] ? { independentCuts: true } : {}),
            },
          }
        : undefined,
    );
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  if (command === "check" && values.run) {
    if (values.rerun && !values.out) {
      console.error(USAGE);
      return 64;
    }
    const result =
      values.rerun && values.out
        ? await rerunAndCheck(values.run, values.out, common)
        : checkRun(values.run);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  console.error(USAGE);
  return 64;
}

process.exitCode = await main(process.argv.slice(2));
