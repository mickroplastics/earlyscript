import * as Schema from "effect/Schema";

/** Perfil del canal: the topics a run scores affinity against (profile/1 of Earlywindow). */
export const ChannelProfile = Schema.Struct({
  schema_version: Schema.Literal("profile/1"),
  name: Schema.String,
  version: Schema.optionalKey(Schema.Int),
  audience: Schema.String,
  include: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  exclude: Schema.Array(Schema.String),
});
export type ChannelProfile = typeof ChannelProfile.Type;

export const ProfileRef = Schema.Struct({
  /** Null when read from a dossier/1, which keeps only version and hash. */
  name: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Int),
  hash: Schema.String,
});
export type ProfileRef = typeof ProfileRef.Type;
