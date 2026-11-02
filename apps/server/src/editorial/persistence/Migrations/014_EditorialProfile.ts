// @effect-diagnostics nodeBuiltinImport:off -- the seed's hash is a pure sha256 of fixed bytes.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { SINGULARIDEV_PROFILE_V1 } from "../../channelProfile.ts";

// Versioned studio profile. Version 1 is seeded with the bytes of Earlywindow's
// profiles/singularidev.v1.json so existing runs keep matching it by hash. Replayable (creates
// only what is missing, seeds only an empty table): a merge may renumber it.
const Topics = Schema.Array(Schema.String);
const decodeSeed = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      audience: Schema.String,
      include: Topics,
      exclude: Topics,
    }),
  ),
);
const encodeTopics = Schema.encodeSync(Schema.fromJsonString(Topics));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_profiles (
      profile_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
      name TEXT NOT NULL,
      audience TEXT NOT NULL,
      include_json TEXT NOT NULL,
      exclude_json TEXT NOT NULL,
      bytes TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('earlywindow', 'operator')),
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS editorial_profiles_one_active
    ON editorial_profiles (active) WHERE active = 1
  `;

  const seed = decodeSeed(SINGULARIDEV_PROFILE_V1);
  const hash = NodeCrypto.createHash("sha256")
    .update(SINGULARIDEV_PROFILE_V1, "utf8")
    .digest("hex");
  yield* sql`
    INSERT INTO editorial_profiles (
      profile_id, version, name, audience, include_json, exclude_json, bytes, sha256, origin,
      created_at, active
    )
    SELECT
      'profile-v1', 1, ${seed.name}, ${seed.audience}, ${encodeTopics(seed.include)},
      ${encodeTopics(seed.exclude)}, ${SINGULARIDEV_PROFILE_V1}, ${hash}, 'earlywindow',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1
    WHERE NOT EXISTS (SELECT 1 FROM editorial_profiles)
  `;
});
