// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - offline tool.
//   node src/tools/relevance-sample.ts --corpus <dir> [--corpus <dir> ...] --from 2026-10-01 --before 2026-10-13 \
//     --take hn=1800,github=400,huggingface=500,npm=400,wikipedia=500,rss=250 --out sample.jsonl
// Items for the relevance probe: published from `--from` (inclusive) to `--before` (exclusive), prepared exactly as a run
// prepares them (config/engine.v1.json text rules, English filter, duplicate URLs), and
// sampled per source in the order of sha256(salt, id), so the sample is reproducible and
// independent of file order. The first corpus wins when two contain the same item id.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import { SourceId } from "@earlyscript/editorial-contracts/source";

import { readCorpus } from "../corpus.ts";
import { sha256 } from "../hash.ts";
import { prepare, type PreparedItem } from "../prepare.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../run.ts";
import { fixtureSources } from "../sources/index.ts";

export const SAMPLE_SALT = "earlyscript.relevance-sample.v1";

export interface SampleRow {
  readonly id: string;
  readonly source: SourceId;
  readonly day: string;
  readonly published_at: string;
  readonly permalink: string;
  readonly title: string;
  readonly excerpt: string;
  /** What the judge reads: title and excerpt. */
  readonly judge_text: string;
  /** What the run embeds; its vector is the probe's input. */
  readonly embed_text: string;
}

export const judgeText = (title: string, excerpt: string) =>
  excerpt === "" ? title : `${title}\n\n${excerpt}`;

export function sampleRow(item: PreparedItem, excerptChars: number): SampleRow {
  const excerpt = item.cleanBody.slice(0, excerptChars);
  return {
    id: item.id,
    source: item.source,
    day: item.day,
    published_at: item.published_at,
    permalink: item.permalink,
    title: item.title,
    excerpt,
    judge_text: judgeText(item.title, excerpt),
    embed_text: item.text,
  };
}

/** Per source, the first `take` items in hash order, then all rows by (source, hash). */
export function stratifiedSample(
  items: ReadonlyArray<PreparedItem>,
  take: ReadonlyMap<SourceId, number>,
  salt = SAMPLE_SALT,
): Array<PreparedItem> {
  const rank = (item: PreparedItem) => sha256(`${salt}\n${item.id}`);
  const out: Array<PreparedItem> = [];
  for (const [source, n] of [...take].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const pool = items
      .filter((item) => item.source === source)
      .map((item) => ({ item, r: rank(item) }))
      .toSorted((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0));
    out.push(...pool.slice(0, n).map(({ item }) => item));
  }
  return out;
}

const isSourceId = Schema.is(SourceId);

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      corpus: { type: "string", multiple: true },
      from: { type: "string" },
      before: { type: "string" },
      take: { type: "string" },
      out: { type: "string" },
      "allow-unverified-corpus": { type: "boolean" },
    },
  });
  if (!values.corpus || !values.before || !values.take || !values.out) {
    console.error(
      "usage: relevance-sample --corpus <dir> [--corpus <dir>] --before <day> --take hn=N,github=N --out <file>",
    );
    return 64;
  }
  const take = new Map<SourceId, number>();
  for (const part of values.take.split(",")) {
    const [source, n] = part.split("=");
    if (!source || !isSourceId(source) || !n) throw new Error(`bad --take ${part}`);
    take.set(source, Number(n));
  }
  const { config } = loadConfig(DEFAULT_CONFIG_PATH);
  const seen = new Set<string>();
  const pooled: Array<PreparedItem> = [];
  const perCorpus: Array<Record<string, unknown>> = [];
  for (const dir of values.corpus) {
    const manifest = JSON.parse(NodeFS.readFileSync(`${dir}/corpus-manifest.json`, "utf8")) as {
      files: Array<{ path: string }>;
    };
    const present = [...take.keys()].filter((source) =>
      manifest.files.some((f) => f.path.startsWith(`${source}/`)),
    );
    const corpus = await readCorpus({
      dir,
      adapters: fixtureSources(dir, present),
      untilDay: values.before,
      ...(values["allow-unverified-corpus"] ? { allowUnverified: true } : {}),
    });
    const beforeMs = Date.parse(`${values.before}T00:00:00Z`);
    const fromMs = values.from ? Date.parse(`${values.from}T00:00:00Z`) : -Infinity;
    // Duplicate URLs are found over everything read, as a run would, then the window applies.
    const prepared = prepare(
      corpus.items.filter((item) => Date.parse(item.published_at) < beforeMs),
      config.text,
    ).filter(
      (item) => item.excluded === null && item.publishedMs >= fromMs && !seen.has(item.id),
    );
    for (const item of prepared) seen.add(item.id);
    pooled.push(...prepared);
    perCorpus.push({
      dir,
      corpus_used_hash: corpus.usedHash,
      corpus_manifest_hash: corpus.manifestHash,
      verified: corpus.verified,
      sources: present,
      items_kept: prepared.length,
    });
  }
  const sample = stratifiedSample(pooled, take);
  const rows = sample.map((item) => sampleRow(item, config.text.excerpt_chars));
  const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  NodeFS.writeFileSync(values.out, text);
  const bySource: Record<string, { pool: number; sampled: number }> = {};
  for (const source of take.keys())
    bySource[source] = {
      pool: pooled.filter((i) => i.source === source).length,
      sampled: rows.filter((r) => r.source === source).length,
    };
  console.log(
    JSON.stringify({
      out: values.out,
      sample_sha256: sha256(text),
      salt: SAMPLE_SALT,
      from: values.from ?? null,
      before: values.before,
      corpora: perCorpus,
      by_source: bySource,
    }),
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
