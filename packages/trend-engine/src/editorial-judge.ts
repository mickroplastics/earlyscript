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
import { DEFAULT_JUDGE_PATH, judgeEntries, loadJudge } from "./tools/judge.ts";

/** The card as text, in the format of tools/dev-compare.ts topicText. */
export const cardText = (card: TopicCard): string =>
  `Topic key terms: ${card.terms.slice(0, 6).join(", ")}\nRecent headlines:\n${card.headlines
    .map((h) => `- ${h.title}`)
    .join("\n")}`;

export async function judgeCards(options: {
  readonly cardsPath: string;
  readonly out: string;
  readonly cacheDir: string;
  readonly judgePath?: string;
  readonly concurrency?: number;
  readonly universeHash?: string | null;
  readonly log?: (line: string) => void;
}) {
  const cards = readCardsJsonl(options.cardsPath).filter(
    (card): card is TopicCard => card.unit === "topic",
  );
  const judge = loadJudge(options.judgePath ?? DEFAULT_JUDGE_PATH);
  const { labels, stats } = await judgeEntries(
    cards.map((card) => ({ id: card.card_id, text: cardText(card) })),
    {
      judge,
      cacheDir: options.cacheDir,
      concurrency: options.concurrency ?? 2,
      ...(options.log ? { log: options.log } : {}),
    },
  );
  const byCard = new Map(cards.map((card) => [card.card_id, card]));
  const out = {
    schema_version: LABELS_SCHEMA_VERSION,
    labeler: `judge:${judge.config.judge_version}`,
    judge: {
      judge_hash: judge.hash,
      rubric_sha256: judge.config.rubric_sha256,
      model: judge.config.model,
    },
    cards_hash: sha256(NodeFS.readFileSync(options.cardsPath)),
    universe_hash: options.universeHash ?? null,
    created_at: new Date().toISOString(),
    stats,
    labels: labels.map((l) => {
      const card = byCard.get(l.id)!;
      return {
        card_id: l.id,
        unit: "topic" as const,
        topic_id: card.topic_id,
        cutoff: card.cutoff,
        label: l.label,
        reason: l.reason,
        key: l.key,
        call: l.call,
      };
    }),
  };
  NodeFS.mkdirSync(NodePath.dirname(options.out), { recursive: true });
  NodeFS.writeFileSync(options.out, `${JSON.stringify(out, null, 2)}\n`);
  return { path: options.out, stats, labels: out.labels };
}
