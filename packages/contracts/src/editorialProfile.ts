import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, PositiveInt } from "./baseSchemas.ts";

// Earlyscript studio profile: the channel the trend engine scores affinity against and the
// assistant writes for. Versioned in editorial.sqlite; an edit makes a new active version and
// the nightly run and the drafting read the active one. Version 1 is Earlywindow's
// `profiles/singularidev.v1.json`, byte for byte, so its hash matches the runs scored with it.

export const EDITORIAL_PROFILE_WS_METHODS = {
  get: "editorial.profile.get",
  history: "editorial.profile.history",
  update: "editorial.profile.update",
} as const;

/** Limits of a profile, checked on both sides; the engine embeds every topic. */
export const EDITORIAL_PROFILE_LIMITS = {
  nameMax: 80,
  audienceMax: 300,
  topicMax: 200,
  topicsMax: 30,
} as const;

/** What the operator edits: the fields of Earlywindow's profile/1. */
export const EditorialProfileDraft = Schema.Struct({
  name: Schema.String,
  audience: Schema.String,
  language: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("en"))),
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
});
export type EditorialProfileDraft = typeof EditorialProfileDraft.Type;

export const EditorialProfileOrigin = Schema.Literals(["earlywindow", "operator"]);
export type EditorialProfileOrigin = typeof EditorialProfileOrigin.Type;

export const EditorialProfileVersion = Schema.Struct({
  version: PositiveInt,
  name: Schema.String,
  audience: Schema.String,
  language: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("en"))),
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
  /** `sha256:<hex>` of the file the engine reads: `profile.hash` in the dossiers it scores. */
  hash: Schema.String,
  createdAt: IsoDateTime,
  origin: EditorialProfileOrigin,
  active: Schema.Boolean,
});
export type EditorialProfileVersion = typeof EditorialProfileVersion.Type;

/** One named parameter of the engine configuration that weighs or filters trends. */
export const EditorialEngineParameter = Schema.Struct({
  /** Dotted path in the engine configuration, such as `profile.include_min`. */
  key: Schema.String,
  value: Schema.Finite,
});
export type EditorialEngineParameter = typeof EditorialEngineParameter.Type;

export const EditorialEngineScoring = Schema.Struct({
  configVersion: Schema.String,
  parameters: Schema.Array(EditorialEngineParameter),
});
export type EditorialEngineScoring = typeof EditorialEngineScoring.Type;

export const EditorialProfileView = Schema.Struct({
  active: EditorialProfileVersion,
  /** The engine's scoring parameters, read only here; null when the engine is not installed. */
  scoring: Schema.NullOr(EditorialEngineScoring),
});
export type EditorialProfileView = typeof EditorialProfileView.Type;

export const EditorialProfileHistory = Schema.Struct({
  /** Newest first. */
  versions: Schema.Array(EditorialProfileVersion),
});
export type EditorialProfileHistory = typeof EditorialProfileHistory.Type;

export const EditorialProfileUpdateResult = Schema.Struct({
  active: EditorialProfileVersion,
  /** False when the draft equalled the active version: no version was created. */
  changed: Schema.Boolean,
});
export type EditorialProfileUpdateResult = typeof EditorialProfileUpdateResult.Type;

export const EditorialProfileField = Schema.Literals([
  "name",
  "audience",
  "language",
  "include",
  "exclude",
]);
export type EditorialProfileField = typeof EditorialProfileField.Type;

export const EditorialProfileIssueCode = Schema.Literals([
  "invalid",
  "required",
  "too-long",
  "too-many",
  "overlap",
]);
export type EditorialProfileIssueCode = typeof EditorialProfileIssueCode.Type;

export const EditorialProfileIssue = Schema.Struct({
  field: EditorialProfileField,
  code: EditorialProfileIssueCode,
});
export type EditorialProfileIssue = typeof EditorialProfileIssue.Type;

export class EditorialProfileError extends Schema.TaggedError<EditorialProfileError>()(
  "EditorialProfileError",
  {
    reason: Schema.Literals(["unavailable", "storage", "invalid-profile"]),
    message: Schema.String,
    issues: Schema.optionalKey(Schema.Array(EditorialProfileIssue)),
  },
) {}

export const CHANNEL_LANGUAGES = [
  { code: "en", label: "Inglés" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Portugués" },
  { code: "fr", label: "Francés" },
  { code: "de", label: "Alemán" },
  { code: "it", label: "Italiano" },
] as const;

export function scriptLanguageInstruction(language = "en"): string {
  const name = new Intl.DisplayNames(["es"], { type: "language" }).of(language) ?? language;
  return `Idioma del guion: ${name} (${language})`;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Trimmed topics without blanks or repeats (case-insensitive), first spelling kept. */
const normalizeTopics = (topics: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const raw of topics) {
    const topic = collapse(raw);
    const key = topic.toLowerCase();
    if (topic.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
  }
  return out;
};

/** The draft as it is stored: single spaces, no blank or repeated topics. */
export function normalizeEditorialProfileDraft(
  draft: EditorialProfileDraft,
): EditorialProfileDraft {
  return {
    name: collapse(draft.name),
    audience: collapse(draft.audience),
    language: (draft.language ?? "en").trim().toLowerCase(),
    include: normalizeTopics(draft.include),
    exclude: normalizeTopics(draft.exclude),
  };
}

function validChannelLanguage(language: string): boolean {
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language) || language.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(language).length === 1;
  } catch {
    return false;
  }
}

/** What keeps a normalized draft from being saved; empty when it can be. */
export function editorialProfileIssues(
  draft: EditorialProfileDraft,
): ReadonlyArray<EditorialProfileIssue> {
  const limits = EDITORIAL_PROFILE_LIMITS;
  const issues: Array<EditorialProfileIssue> = [];
  if (!validChannelLanguage(draft.language ?? "en")) {
    issues.push({ field: "language", code: "invalid" });
  }
  if (draft.name.length === 0) issues.push({ field: "name", code: "required" });
  else if (draft.name.length > limits.nameMax) issues.push({ field: "name", code: "too-long" });
  if (draft.audience.length === 0) issues.push({ field: "audience", code: "required" });
  else if (draft.audience.length > limits.audienceMax) {
    issues.push({ field: "audience", code: "too-long" });
  }
  if (draft.include.length === 0) issues.push({ field: "include", code: "required" });
  for (const field of ["include", "exclude"] as const) {
    const topics = draft[field];
    if (topics.length > limits.topicsMax) issues.push({ field, code: "too-many" });
    if (topics.some((topic) => topic.length > limits.topicMax)) {
      issues.push({ field, code: "too-long" });
    }
  }
  const included = new Set(draft.include.map((topic) => topic.toLowerCase()));
  if (draft.exclude.some((topic) => included.has(topic.toLowerCase()))) {
    issues.push({ field: "exclude", code: "overlap" });
  }
  return issues;
}

/** Same stored profile: equal fields and topics in the same order. */
export function sameEditorialProfile(a: EditorialProfileDraft, b: EditorialProfileDraft): boolean {
  const sameList = (x: ReadonlyArray<string>, y: ReadonlyArray<string>) =>
    x.length === y.length && x.every((value, index) => value === y[index]);
  return (
    a.name === b.name &&
    (a.language ?? "en") === (b.language ?? "en") &&
    a.audience === b.audience &&
    sameList(a.include, b.include) &&
    sameList(a.exclude, b.exclude)
  );
}

const profileError = Schema.Union([EditorialProfileError, EnvironmentAuthorizationError]);

const EditorialProfileGetRpc = Rpc.make(EDITORIAL_PROFILE_WS_METHODS.get, {
  payload: Schema.Struct({}),
  success: EditorialProfileView,
  error: profileError,
});

const EditorialProfileHistoryRpc = Rpc.make(EDITORIAL_PROFILE_WS_METHODS.history, {
  payload: Schema.Struct({}),
  success: EditorialProfileHistory,
  error: profileError,
});

/**
 * Normalizes and validates the draft; when it differs from the active version it becomes a new
 * version and the active one. An unchanged draft answers the active version with `changed` false.
 */
const EditorialProfileUpdateRpc = Rpc.make(EDITORIAL_PROFILE_WS_METHODS.update, {
  payload: EditorialProfileDraft,
  success: EditorialProfileUpdateResult,
  error: profileError,
});

/** Merged into `WsRpcGroup` next to the other editorial groups. */
export const EditorialProfileRpcGroup = RpcGroup.make(
  EditorialProfileGetRpc,
  EditorialProfileHistoryRpc,
  EditorialProfileUpdateRpc,
);

export const EDITORIAL_PROFILE_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_PROFILE_WS_METHODS.get]: AuthOrchestrationReadScope,
  [EDITORIAL_PROFILE_WS_METHODS.history]: AuthOrchestrationReadScope,
  [EDITORIAL_PROFILE_WS_METHODS.update]: AuthOrchestrationOperateScope,
} as const;

/**
 * The write the client checks before it offers the form, spread into `CLIENT_GUARDED_RPC_SCOPES`
 * (`clientRpcPermissions.ts`); the server checks it again.
 */
export const EDITORIAL_PROFILE_CLIENT_GUARDED_SCOPES = {
  [EDITORIAL_PROFILE_WS_METHODS.update]: AuthOrchestrationOperateScope,
} as const;
