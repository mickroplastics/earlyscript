// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over the card files.
// `engine eval-editorial judge`: labels blind topic cards with the frozen editorial judge
// (tools/judge.ts: rubric and model by hash, Claude CLI with no tools, web or MCP). The judge sees
// exactly what the card shows a person, never the arm, position, score or cutoff; its labels
// go to a labels.json `score` reads like Miguel's. Development only (P1.2): test cards are his.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LABELS_SCHEMA_VERSION } from "./editorial-cards-html.ts";
import type { TopicCard } from "./editorial-eval.ts";
import { readCardsJsonl } from "./editorial-eval.ts";
import { sha256 } from "./hash.ts";
import {
  DEFAULT_JUDGE_PATH,
  type JudgedEntry,
  judgeEntries,
  labelKey,
  type LoadedJudge,
  loadJudge,
} from "./tools/judge.ts";

/** The card as text, in the format of tools/dev-compare.ts topicText. */
export const cardText = (card: TopicCard): string =>
  `Topic key terms: ${card.terms.slice(0, 6).join(", ")}\nRecent headlines:\n${card.headlines
    .map((h) => `- ${h.title}`)
    .join("\n")}`;

export const topicCards = (path: string): Array<TopicCard> =>
  readCardsJsonl(path).filter((card): card is TopicCard => card.unit === "topic");

/** Judge entries {id, text} of the cards, for `node src/tools/judge.ts --in` on another machine. */
export const cardEntries = (cards: ReadonlyArray<TopicCard>) =>
  cards.map((card) => ({ id: card.card_id, text: cardText(card) }));

/** labels.json for `score` from the judge's output lines {id, label, reason, key, call}. */
export function judgeLabelsFile(options: {
  readonly cardsPath: string;
  readonly judged: ReadonlyArray<JudgedEntry>;
  readonly judge: LoadedJudge;
  readonly universeHash: string | null;
  readonly stats?: unknown;
}) {
  const cards = topicCards(options.cardsPath);
  const byCard = new Map(cards.map((card) => [card.card_id, card]));
  const judged = new Map(options.judged.map((l) => [l.id, l]));
  const missing = cards.filter((card) => !judged.has(card.card_id)).length;
  if (missing > 0) throw new Error(`${missing} cards have no judge label`);
  for (const card of cards) {
    if (
      judged.get(card.card_id)!.key !==
      labelKey(options.judge, cardText(card).slice(0, options.judge.config.max_text_chars))
    )
      throw new Error(`judge label of ${card.card_id} is for another text, rubric or model`);
  }
  return {
    schema_version: LABELS_SCHEMA_VERSION,
    labeler: `judge:${options.judge.config.judge_version}`,
    judge: {
      judge_hash: options.judge.hash,
      rubric_sha256: options.judge.config.rubric_sha256,
      model: options.judge.config.model,
    },
    cards_hash: sha256(NodeFS.readFileSync(options.cardsPath)),
    universe_hash: options.universeHash,
    created_at: new Date().toISOString(),
    stats: options.stats ?? null,
    labels: [...judged.values()]
      .filter((l) => byCard.has(l.id))
      .map((l) => {
        const card = byCard.get(l.id)!;
        return {
          card_id: l.id,
          unit: "topic" as const,
          topic_id: card.topic_id,
          cutoff: card.cutoff,
          // A graded judge (v2) answers core/adjacent: a yes with its grade.
          label: l.label === "core" || l.label === "adjacent" ? "yes" : l.label,
          grade: l.label === "core" || l.label === "adjacent" ? l.label : null,
          reason: l.reason,
          key: l.key,
          call: l.call,
        };
      }),
  };
}

/** Judges the cards in this process (needs the Claude CLI here) and writes labels.json. */
export async function judgeCards(options: {
  readonly cardsPath: string;
  readonly out: string;
  readonly cacheDir: string;
  readonly judgePath?: string;
  readonly concurrency?: number;
  readonly universeHash?: string | null;
  readonly log?: (line: string) => void;
}) {
  const judge = loadJudge(options.judgePath ?? DEFAULT_JUDGE_PATH);
  const { labels, stats } = await judgeEntries(cardEntries(topicCards(options.cardsPath)), {
    judge,
    cacheDir: options.cacheDir,
    concurrency: options.concurrency ?? 2,
    ...(options.log ? { log: options.log } : {}),
  });
  const out = judgeLabelsFile({
    cardsPath: options.cardsPath,
    judged: labels,
    judge,
    universeHash: options.universeHash ?? null,
    stats,
  });
  NodeFS.mkdirSync(NodePath.dirname(options.out), { recursive: true });
  NodeFS.writeFileSync(options.out, `${JSON.stringify(out, null, 2)}\n`);
  return { path: options.out, stats, labels: out.labels };
}
