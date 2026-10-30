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
