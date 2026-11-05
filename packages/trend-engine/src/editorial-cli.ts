// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - command-line entry point.
// engine eval-editorial pool|cards|cards-html|hn-labels|score|seal|capture (protocol P1.1).
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import { SourceId } from "@earlyscript/editorial-contracts/source";

import {
  appendLedger,
  assertSealed,
  buildTopicCards,
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
  "usage: engine eval-editorial pool --corpus <dir> --profile <file> --out <dir> --cutoffs <days> (--references | --arm <name>=<config.json>[:baseline|:weighted|:keywords=<file>] ...) [--sources <ids>] [--top 5] [--ledger <ledger.jsonl>] [--no-cards] [--seed n] [--workers n] [--cache <sqlite>] [--cache-only] [--models <dir>]\n" +
  "       engine eval-editorial cards --universe <universe.json> --out <dir> [--name <set>] [--cutoffs <days>] [--sample N] [--seed S] [--ledger <ledger.jsonl>]\n" +
  "       engine eval-editorial cards-html --cards <cards.jsonl> --out <dir> [--name <set>] [--title <text>]\n" +
  "       engine eval-editorial hn-labels --universe <universe.json> --corpus <dir> --out <labels-hn.json> [--cache <sqlite>] [--cache-only] [--models <dir>] [--workers n]\n" +
  "       engine eval-editorial score --universe <universe.json> --rankings <rankings.json> --labels <file> [--labels <file> ...] --out <dir> [--dev <days>] [--retro <days>] [--prospective <days>] [--candidate <arm> ...] [--reference <arm> ...] [--ledger <ledger.jsonl>] [--bootstrap 2000] [--seed n] [--block-days 7]\n" +
  "       engine eval-editorial seal --ledger <ledger.jsonl> --kind <freeze|rankings|note> [--file <path> ...] [--note <text>]\n" +
  "       engine eval-editorial capture --corpus <dir> --ledger <ledger.jsonl> --snapshots <dir> [--day <YYYY-MM-DD>] [--first-day <day>] [--last-day <day>] [--sources <ids>] [--rss-feeds <file.json>] [--seed-from <corpus>]";

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
    const cards = buildTopicCards(universe, {
      seed: values.seed ? Number(values.seed) : DEFAULT_CARD_SEED,
      ...(values.cutoffs ? { cutoffs: parseCutoffList(values.cutoffs) } : {}),
      ...(values.sample ? { sample: Number(values.sample) } : {}),
    });
    assertSealed(universe, cards, values.ledger);
    const name = values.name ?? "cards";
    const written = writeCardSet(cards, values.out, name, {
      universeHash: universe.universe_hash,
      title: values.title ?? "Tarjetas de temas",
    });
    console.log(JSON.stringify({ ...written, cards: cards.length, universe_hash: universe.universe_hash }));
    return 0;
  }
  if (sub === "cards-html" && values.cards && values.out) {
    const cards = readCardsJsonl(values.cards);
    const name = values.name ?? NodePath.basename(values.cards).replace(/\.jsonl$/, "");
    const written = writeCardSet(cards, values.out, name, {
      title: values.title ?? (cards.every((c) => c.unit === "item") ? "Tarjetas de ítems" : "Tarjetas"),
    });
    console.log(JSON.stringify({ ...written, cards: cards.length }));
    return 0;
  }
  if (sub === "seal" && values.ledger && values.kind) {
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
