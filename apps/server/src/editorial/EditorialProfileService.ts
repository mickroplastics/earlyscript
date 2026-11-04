import {
  editorialProfileIssues,
  EditorialProfileDraft as ProfileSchema,
  EditorialProfileError,
  normalizeEditorialProfileDraft,
  sameEditorialProfile,
  type EditorialProfileDraft,
  type EditorialProfileHistory,
  type EditorialProfileUpdateResult,
  type EditorialProfileVersion,
} from "@t3tools/contracts";
import type { TrendPresentationProfile } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { presentationProfileFromBytes } from "./channelProfile.ts";
import { sha256 } from "./nightlySchedule.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId, nowIso } from "./persistence/support.ts";

/** The file the engine reads for one version: its bytes and their `sha256:` hash. */
export interface EditorialProfileFile {
  readonly version: number;
  readonly hash: string;
  readonly bytes: string;
}

export interface EditorialProfileServiceShape {
  /** The active version: what the nightly run scores with and the assistant writes for. */
  readonly get: Effect.Effect<EditorialProfileVersion, EditorialProfileError>;
  readonly history: Effect.Effect<EditorialProfileHistory, EditorialProfileError>;
  /** A changed draft becomes the next version and the active one; an unchanged one, nothing. */
  readonly update: (
    draft: EditorialProfileDraft,
  ) => Effect.Effect<EditorialProfileUpdateResult, EditorialProfileError>;
  readonly activeFile: Effect.Effect<EditorialProfileFile, EditorialProfileError>;
  /** The stored file with this `sha256:` hash, for a job created under an earlier version. */
  readonly fileByHash: (
    hash: string,
  ) => Effect.Effect<Option.Option<EditorialProfileFile>, EditorialProfileError>;
}

/** The only reader and writer of `editorial_profiles`. */
export class EditorialProfileService extends Context.Service<
  EditorialProfileService,
  EditorialProfileServiceShape
>()("t3/editorial/EditorialProfileService") {}

interface ProfileRow {
  readonly version: number;
  readonly name: string;
  readonly audience: string;
  readonly include_json: string;
  readonly exclude_json: string;
  readonly bytes: string;
  readonly sha256: string;
  readonly origin: "earlywindow" | "operator";
  readonly created_at: string;
  readonly active: number;
}

const COLUMNS =
  "version, name, audience, include_json, exclude_json, bytes, sha256, origin, created_at, active";

const storage = (cause: unknown) =>
  new EditorialProfileError({
    reason: "storage",
    message: `The studio profile could not be read or written: ${String(cause)}`,
  });

const TopicsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeTopics = Schema.encodeSync(TopicsJson);
const decodeTopics = Schema.decodeUnknownOption(TopicsJson);

const topicsOf = (json: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeTopics(json), () => []);

const decodeProfileBytes = Schema.decodeSync(Schema.fromJsonString(ProfileSchema));

const versionOf = (row: ProfileRow): EditorialProfileVersion => ({
  version: row.version,
  name: row.name,
  audience: row.audience,
  language: decodeProfileBytes(row.bytes).language,
  include: topicsOf(row.include_json),
  exclude: topicsOf(row.exclude_json),
  hash: `sha256:${row.sha256}`,
  createdAt: row.created_at,
  origin: row.origin,
  active: row.active === 1,
});

const fileOf = (row: ProfileRow): EditorialProfileFile => ({
  version: row.version,
  hash: `sha256:${row.sha256}`,
  bytes: row.bytes,
});

/**
 * The engine's profile/1 file for a version, in the layout of Earlywindow's
 * `profiles/singularidev.v1.json` (two-space JSON and a final newline). Version 1 carries no
 * `version` key, as that file; later versions do, so the engine records it in `run.json` and
 * the dossiers, and two versions with the same topics still hash apart.
 */
export function editorialProfileBytes(draft: EditorialProfileDraft, version: number): string {
  const file = {
    schema_version: "profile/1",
    name: draft.name,
    ...(version === 1 ? {} : { version }),
    audience: draft.audience,
    ...(version === 1 ? {} : { language: draft.language ?? "en" }),
    include: draft.include,
    exclude: draft.exclude,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const selectActive = (sql: SqlClient.SqlClient) =>
  sql<ProfileRow>`
    SELECT ${sql.literal(COLUMNS)} FROM editorial_profiles WHERE active = 1
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.die(new Error("editorial_profiles has no active version; migration not applied"))
        : Effect.succeed(rows[0]),
    ),
  );

/**
 * The active profile as the assistant's prompt reads it. Its version and hash enter each
 * presentation's input identity, so a new version marks earlier drafts as out of date.
 */
export const currentPresentationProfile = (
  sql: SqlClient.SqlClient,
): Effect.Effect<TrendPresentationProfile, SqlError> =>
  selectActive(sql).pipe(Effect.map((row) => presentationProfileFromBytes(row.bytes, row.version)));

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const newId = yield* makeNewId;

  const get = selectActive(sql).pipe(Effect.map(versionOf), Effect.mapError(storage));

  const history = sql<ProfileRow>`
    SELECT ${sql.literal(COLUMNS)} FROM editorial_profiles ORDER BY version DESC
  `.pipe(
    Effect.map((rows): EditorialProfileHistory => ({ versions: rows.map(versionOf) })),
    Effect.mapError(storage),
  );

  const update = Effect.fn("EditorialProfileService.update")(function* (
    input: EditorialProfileDraft,
  ) {
    const draft = normalizeEditorialProfileDraft(input);
    const issues = editorialProfileIssues(draft);
    if (issues.length > 0) {
      return yield* new EditorialProfileError({
        reason: "invalid-profile",
        message: `The profile is not valid: ${issues.map((i) => `${i.field} ${i.code}`).join(", ")}`,
        issues,
      });
    }
    const id = yield* newId;
    const createdAt = yield* nowIso;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* selectActive(sql);
          if (sameEditorialProfile(draft, versionOf(current))) {
            return { active: versionOf(current), changed: false };
          }
          const latest = yield* sql<{ readonly top: number }>`
            SELECT MAX(version) AS top FROM editorial_profiles
          `;
          const next = (latest[0]?.top ?? 0) + 1;
          const bytes = editorialProfileBytes(draft, next);
          const hash = sha256(bytes).slice("sha256:".length);
          yield* sql`UPDATE editorial_profiles SET active = 0 WHERE active = 1`;
          yield* sql`
            INSERT INTO editorial_profiles (
              profile_id, version, name, audience, include_json, exclude_json, bytes, sha256,
              origin, created_at, active
            ) VALUES (
              ${`profile-${id}`}, ${next}, ${draft.name}, ${draft.audience},
              ${encodeTopics(draft.include)}, ${encodeTopics(draft.exclude)}, ${bytes},
              ${hash}, 'operator', ${createdAt}, 1
            )
          `;
          return { active: versionOf(yield* selectActive(sql)), changed: true };
        }),
      )
      .pipe(Effect.mapError(storage));
  });

  const activeFile = selectActive(sql).pipe(Effect.map(fileOf), Effect.mapError(storage));

  const fileByHash = (hash: string) =>
    sql<ProfileRow>`
      SELECT ${sql.literal(COLUMNS)} FROM editorial_profiles
      WHERE sha256 = ${hash.replace(/^sha256:/, "")}
      ORDER BY version DESC LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), fileOf)),
      Effect.mapError(storage),
    );

  return EditorialProfileService.of({ get, history, update, activeFile, fileByHash });
});

export const layer = Layer.effect(EditorialProfileService, make);
