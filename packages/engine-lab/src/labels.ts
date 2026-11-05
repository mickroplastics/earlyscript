// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - reads the operator's card and label files.
// Labels for the development comparison: a card file (one topic per line, with its headlines)
// and a label file keyed by card, as `engine eval-editorial` and the calibration page write
// them. Sealed cutoffs are dropped here as well as refused by the campaign.
import * as NodeFS from "node:fs";

import { type LabelledTopic, type LabelSource, memberKey } from "./compare.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { isSealedCutoff } from "./policy.ts";

interface CardLine {
  readonly card_id: string;
  readonly unit?: string;
  readonly topic_id?: string;
  readonly cutoff: string;
  readonly headlines?: ReadonlyArray<{ title: string; source: string; published_at: string }>;
}

interface LabelLine {
  readonly card_id: string;
  readonly unit?: string;
  readonly label: string;
  readonly grade?: string | null;
}

export function readLabelSource(input: {
  readonly cardsPath: string;
  readonly labelsPath: string;
  readonly kind: "human" | "judge";
}): LabelSource {
  const cards = new Map<string, CardLine>();
  for (const line of NodeFS.readFileSync(input.cardsPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const card = JSON.parse(line) as CardLine;
    if ((card.unit ?? "topic") === "topic") cards.set(card.card_id, card);
  }
  const file = JSON.parse(NodeFS.readFileSync(input.labelsPath, "utf8")) as {
    readonly labeler?: string;
    readonly labels?: ReadonlyArray<LabelLine>;
  };
  if (typeof file.labeler !== "string" || !Array.isArray(file.labels)) {
    throw new Error(`${input.labelsPath}: expected { labeler, labels: [...] }`);
  }
  const topics: Array<LabelledTopic> = [];
  for (const row of file.labels) {
    const card = cards.get(row.card_id);
    if (card === undefined || (row.unit ?? "topic") !== "topic") continue;
    if (row.label !== "yes" && row.label !== "no" && row.label !== "unsure") continue;
    const cutoff = card.cutoff.slice(0, 10);
    if (isSealedCutoff(cutoff)) continue;
    topics.push({
      topic_id: card.topic_id ?? card.card_id,
      cutoff,
      label: row.label,
      grade: row.grade === "core" || row.grade === "adjacent" ? row.grade : null,
      keys: (card.headlines ?? []).map(memberKey),
    });
  }
  return {
    labeler: file.labeler,
    kind: input.kind,
    hash: sha256(canonicalJson(topics)),
    topics,
  };
}
