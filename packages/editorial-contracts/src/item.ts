import * as Schema from "effect/Schema";

import { SourceId } from "./source.ts";

export const MAX_ITEM_BODY_CHARS = 4000;

/** Ítem: one captured publication, the corpus/1 line format. Body is plain text. */
export const Item = Schema.Struct({
  id: Schema.String,
  source: SourceId,
  permalink: Schema.String,
  external_url: Schema.NullOr(Schema.String),
  published_at: Schema.String,
  author: Schema.NullOr(Schema.String),
  title: Schema.String,
  body: Schema.String.check(Schema.isMaxLength(MAX_ITEM_BODY_CHARS)),
  body_length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
  /** Origin of the body (rss): the feed's `summary`, or a cut of its full `content`. `truncated` says whether it was cut. */
  body_kind: Schema.optionalKey(Schema.Literals(["summary", "content"])),
  /** Feed the item came from (rss): the key of `engine purge --feed`. */
  feed_url: Schema.optionalKey(Schema.String),
  retrieved_at: Schema.String,
  /** Entities the item points to, such as "github:owner/repo"; they join sources. */
  entities: Schema.Array(Schema.String),
});
export type Item = typeof Item.Type;

/** Corte: the instant up to which a run may look. Whole UTC days, so series count full days. */
export const Cutoff = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/),
);
export type Cutoff = typeof Cutoff.Type;

export type ItemKey = keyof Item;

/** The fields every adapter writes on every item (`Item`'s required keys). */
const BASE_ITEM_KEYS = [
  "id",
  "source",
  "permalink",
  "external_url",
  "published_at",
  "author",
  "title",
  "body",
  "body_length",
  "truncated",
  "retrieved_at",
  "entities",
] as const satisfies ReadonlyArray<ItemKey>;

/**
 * The keys each source's items carry, as its adapter writes them. The trend-engine tests check
 * every adapter's items against this list, and the first-run consent step describes each key in
 * words, so what the operator accepts and what the corpus stores cannot drift apart silently.
 */
export const SOURCE_ITEM_KEYS: Readonly<Record<SourceId, ReadonlyArray<ItemKey>>> = {
  hn: BASE_ITEM_KEYS,
  github: BASE_ITEM_KEYS,
  arxiv: BASE_ITEM_KEYS,
  wikipedia: BASE_ITEM_KEYS,
  npm: BASE_ITEM_KEYS,
  stackexchange: BASE_ITEM_KEYS,
  bluesky: BASE_ITEM_KEYS,
  huggingface: BASE_ITEM_KEYS,
  lobsters: BASE_ITEM_KEYS,
  rss: [...BASE_ITEM_KEYS, "body_kind", "feed_url"],
};
