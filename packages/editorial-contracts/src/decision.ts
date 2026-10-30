import * as Schema from "effect/Schema";

// Not produced by anything yet (pending, engine step 2 or later): minimal shapes that fix
// the vocabulary of the primitives so the server tables can follow it.

/** Hilo de video: a T3 thread tied to a dossier or to an own idea. */
export const VideoThread = Schema.Struct({
  thread_id: Schema.String,
  run_id: Schema.NullOr(Schema.String),
  dossier_id: Schema.NullOr(Schema.String),
  mode: Schema.Literals(["assisted", "manual"]),
  opened_at: Schema.String,
});
export type VideoThread = typeof VideoThread.Type;

/** Decisión: recorded by the operator through a path the model cannot call. */
export const Decision = Schema.Struct({
  thread_id: Schema.String,
  dossier_id: Schema.NullOr(Schema.String),
  action: Schema.Literals(["accept", "edit", "reject", "defer"]),
  utility: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
  reason: Schema.String.check(Schema.isMinLength(3)),
  elapsed_ms: Schema.Int,
  script_sha256: Schema.NullOr(Schema.String),
  decided_at: Schema.String,
});
export type Decision = typeof Decision.Type;

/** Resultado: descriptive metrics of a published video, never attributed to the engine. */
export const Outcome = Schema.Struct({
  thread_id: Schema.String,
  video_url: Schema.String,
  published_at: Schema.String,
  read_at: Schema.String,
  metrics: Schema.Record(Schema.String, Schema.Number),
});
export type Outcome = typeof Outcome.Type;
