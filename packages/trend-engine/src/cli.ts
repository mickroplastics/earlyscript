// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - command-line entry point.
//   node src/cli.ts run --corpus <dir> --cutoff <iso> --profile <file> --out <dir> [--config <file>] [--workers n] [--cache <sqlite>] [--models <dir>] [--allow-unverified-corpus]
//   node src/cli.ts check --run <run_dir> [--rerun --out <dir>]
//   node src/cli.ts purge --corpus <dir> --source <id> (--author <name> | --url <permalink> | --feed <feed-url>)
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { checkRun, rerunAndCheck } from "./check.ts";
import { collectCorpus } from "./collect.ts";
import { purgeCorpus } from "./purge.ts";
import { liveSources, readRssFeedList } from "./sources/index.ts";
import * as Schema from "effect/Schema";
import { SourceId } from "@earlyscript/editorial-contracts/source";
import { runEngine } from "./run.ts";

const isSourceId = Schema.is(SourceId);

const USAGE =
  "usage: engine run --corpus <dir> --cutoff <iso> --profile <file> --out <dir> [--config <file>] [--workers n] [--cache <sqlite>] [--models <dir>] [--allow-unverified-corpus]\n" +
  "       engine check --run <run_dir> [--rerun --out <dir>]\n" +
  "       engine collect --corpus <dir> --sources hn,github,lobsters,rss --from <day> --to <exclusive-day> [--rss-feeds <file.json>] [--force]\n" +
  "       engine purge --corpus <dir> --source <id> (--author <name> | --url <permalink> | --feed <feed-url>)";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
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
      models: { type: "string" },
      run: { type: "string" },
      rerun: { type: "boolean" },
      "allow-unverified-corpus": { type: "boolean" },
    },
  });
  if (command === "collect" && values.corpus && values.from && values.to && values.sources) {
    const ids = [...new Set(values.sources.split(","))];
    if (!ids.every(isSourceId)) throw new Error("Unknown source");
    const rows = await collectCorpus({
      dir: values.corpus,
      from: values.from,
      to: values.to,
      adapters: liveSources(
        ids,
        {},
        values["rss-feeds"] ? { rssFeeds: await readRssFeedList(values["rss-feeds"]) } : {},
      ),
      ...(values.force ? { force: true } : {}),
    });
    console.log(JSON.stringify(rows));
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
    ...(values.models ? { modelDir: values.models } : {}),
    ...(values["allow-unverified-corpus"] ? { allowUnverifiedCorpus: true } : {}),
  };
  if (command === "run" && values.corpus && values.cutoff && values.profile && values.out) {
    NodeFS.mkdirSync(values.out, { recursive: true });
    const record = await runEngine({
      ...common,
      corpusDir: values.corpus,
      cutoff: values.cutoff,
      profilePath: values.profile,
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
