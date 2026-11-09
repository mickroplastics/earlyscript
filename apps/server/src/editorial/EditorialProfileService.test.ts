// @effect-diagnostics nodeBuiltinImport:off - the test hashes the seed bytes itself.
import * as NodeCrypto from "node:crypto";

import * as NodeFS from "node:fs";

import { DEFAULT_CONFIG_PATH } from "@earlyscript/trend-engine/run";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EDITORIAL_PROFILE_WS_METHODS,
  EditorialProfileRpcGroup,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { SINGULARIDEV_PROFILE_V1 } from "./channelProfile.ts";
import * as EditorialProfileService from "./EditorialProfileService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { runEditorialMigrations } from "./persistence/Migrations.ts";
import * as EditorialProfileRpc from "./profileRpc.ts";

/** editorial.sqlite in memory, migrated as at startup. */
const memoryDatabase = Layer.effect(
  EditorialSql,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runEditorialMigrations();
    return sql;
  }),
).pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const withProfiles = <A, E>(
  body: Effect.Effect<
    A,
    E,
    EditorialProfileService.EditorialProfileService | EditorialSql | NodeServices.NodeServices
  >,
) =>
  body.pipe(
    Effect.provide(
      EditorialProfileService.layer.pipe(
        Layer.provideMerge(memoryDatabase),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const group = EditorialProfileRpcGroup.middleware(RpcScopeAuthorization);

const V1_HASH = `sha256:${NodeCrypto.createHash("sha256").update(SINGULARIDEV_PROFILE_V1).digest("hex")}`;

const V2_FIXTURE = new URL("./fixtures/profiles/singularidev.v2.json", import.meta.url);
const V2_HASH = "sha256:cc5cc20d8be7faa6eb28eaa09b35fb8200e61da269acdaefac85cf3ecd0e2298";

const EDITED = {
  name: "SingulariDev",
  language: "en",
  audience: "Solo founders and developers building products with AI agents, in English",
  include: ["AI coding agents", "local language models", "developer tooling for AI products"],
  exclude: ["cryptocurrency prices"],
};

describe("EditorialProfileService", () => {
  it.effect("persists channel language in a new version and keeps the original bytes", () =>
    withProfiles(
      Effect.gen(function* () {
        const profiles = yield* EditorialProfileService.EditorialProfileService;
        const original = yield* profiles.activeFile;
        const active = yield* profiles.get;
        assert.strictEqual((yield* profiles.update(active)).changed, false);
        const saved = yield* profiles.update({ ...active, language: "es" });
        assert.strictEqual(saved.active.language, "es");
        assert.strictEqual(saved.active.version, 2);
        assert.notStrictEqual(saved.active.hash, original.hash);
        assert.include((yield* profiles.activeFile).bytes, '"language": "es"');
        const previous = yield* profiles.fileByHash(original.hash);
        assert.isTrue(previous._tag === "Some" && previous.value.bytes === original.bytes);
      }),
    ),
  );
  it.effect("seeds version 1 with Earlywindow's bytes, so its hash is the runs' hash", () =>
    withProfiles(
      Effect.gen(function* () {
        const profiles = yield* EditorialProfileService.EditorialProfileService;
        const active = yield* profiles.get;
        assert.strictEqual(active.language, "en");
        assert.strictEqual(active.version, 1);
        assert.strictEqual(active.origin, "earlywindow");
        assert.strictEqual(active.hash, V1_HASH);
        assert.strictEqual(
          active.hash,
          "sha256:db510e303cb7f3cff7099230a00d36b1918f28a0e6aa6b8be01727649b8bb80d",
        );
        assert.strictEqual(active.include.length, 5);
        assert.strictEqual(active.exclude.length, 4);
        const file = yield* profiles.activeFile;
        assert.strictEqual(file.bytes, SINGULARIDEV_PROFILE_V1);
        // The serializer reproduces the seed from its fields: one format for every version.
        assert.strictEqual(EditorialProfileService.editorialProfileBytes(active, 1), file.bytes);
        const presentation = yield* EditorialProfileService.currentPresentationProfile(
          yield* EditorialSql,
        );
        assert.strictEqual(presentation.hash, V1_HASH);
        assert.strictEqual(presentation.version, 1);
      }),
    ),
  );

  it.effect("makes a changed draft version 2 and the active one", () =>
    withProfiles(
      Effect.gen(function* () {
        const profiles = yield* EditorialProfileService.EditorialProfileService;
        const result = yield* profiles.update({
          ...EDITED,
          include: ["  AI coding agents ", "ai coding agents", "", ...EDITED.include.slice(1)],
        });
        assert.isTrue(result.changed);
        assert.strictEqual(result.active.version, 2);
        assert.strictEqual(result.active.origin, "operator");
        assert.deepStrictEqual(result.active.include, EDITED.include);
        assert.notStrictEqual(result.active.hash, V1_HASH);
        const file = yield* profiles.activeFile;
        const parsed = JSON.parse(file.bytes) as Record<string, unknown>;
        assert.strictEqual(parsed["schema_version"], "profile/1");
        assert.strictEqual(parsed["version"], 2);
        assert.strictEqual(
          `sha256:${NodeCrypto.createHash("sha256").update(file.bytes).digest("hex")}`,
          result.active.hash,
        );
        const history = yield* profiles.history;
        assert.deepStrictEqual(
          history.versions.map((entry) => [entry.version, entry.active]),
          [
            [2, true],
            [1, false],
          ],
        );
        // An earlier version stays readable by hash, for a job keyed with it.
        const old = yield* profiles.fileByHash(V1_HASH);
        assert.strictEqual(old._tag === "Some" ? old.value.bytes : null, SINGULARIDEV_PROFILE_V1);
        const presentation = yield* EditorialProfileService.currentPresentationProfile(
          yield* EditorialSql,
        );
        assert.strictEqual(presentation.version, 2);
        assert.include(presentation.text, "- local language models");
      }),
    ),
  );

  it.effect("creates no version for an unchanged draft, spacing aside", () =>
    withProfiles(
      Effect.gen(function* () {
        const profiles = yield* EditorialProfileService.EditorialProfileService;
        const active = yield* profiles.get;
        const result = yield* profiles.update({
          language: active.language,
          name: ` ${active.name} `,
          audience: active.audience.replace(" ", "  "),
          include: [...active.include, ""],
          exclude: active.exclude,
        });
        assert.isFalse(result.changed);
        assert.strictEqual(result.active.version, 1);
        assert.strictEqual((yield* profiles.history).versions.length, 1);
      }),
    ),
  );

  it.effect("refuses an invalid draft with its issues and keeps the active version", () =>
    withProfiles(
      Effect.gen(function* () {
        const profiles = yield* EditorialProfileService.EditorialProfileService;
        const error = yield* profiles
          .update({ language: "en", name: " ", audience: "", include: [], exclude: ["crypto"] })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid-profile");
        assert.deepStrictEqual(error.issues, [
          { field: "name", code: "required" },
          { field: "audience", code: "required" },
          { field: "include", code: "required" },
        ]);
        assert.strictEqual((yield* profiles.get).version, 1);
      }),
    ),
  );

  it.effect(
    "imports a profile file byte for byte, so its hash is the file's, and again changes nothing (B5)",
    () =>
      withProfiles(
        Effect.gen(function* () {
          const profiles = yield* EditorialProfileService.EditorialProfileService;
          const sql = yield* EditorialSql;
          // v3/perfil/singularidev.v2.json: no `version` or `language` key, a `version_note`, no
          // final newline. engine.v3.json pins this sha256.
          const bytes = NodeFS.readFileSync(V2_FIXTURE, "utf8");
          const first = yield* profiles.importFile(bytes);
          assert.deepInclude(first, { changed: true, created: true });
          assert.strictEqual(first.active.version, 2);
          assert.strictEqual(first.active.hash, V2_HASH);
          assert.strictEqual(first.active.include.length, 6);
          const file = yield* profiles.activeFile;
          assert.strictEqual(file.hash, V2_HASH);
          assert.strictEqual(file.bytes, bytes);
          const rows = yield* sql<{ readonly sha256: string; readonly origin: string }>`
            SELECT sha256, origin FROM editorial_profiles WHERE active = 1
          `;
          assert.deepStrictEqual([...rows], [{ sha256: V2_HASH.slice(7), origin: "operator" }]);

          const again = yield* profiles.importFile(bytes);
          assert.deepInclude(again, { changed: false, created: false });
          assert.strictEqual((yield* profiles.history).versions.length, 2);

          // Saving from Ajustes stores its own layout: another version and hash.
          const unchanged = yield* profiles.update({ ...first.active, language: "en" });
          assert.isFalse(unchanged.changed);
          const saved = yield* profiles.update({
            ...first.active,
            language: "en",
            exclude: [...first.active.exclude, "celebrity news"],
          });
          assert.isTrue(saved.changed);
          assert.notStrictEqual(saved.active.hash, V2_HASH);
          // Importing the file again activates the stored version; no third copy of the bytes.
          const back = yield* profiles.importFile(bytes);
          assert.deepInclude(back, { changed: true, created: false });
          assert.strictEqual(back.active.version, 2);
          assert.strictEqual((yield* profiles.activeFile).hash, V2_HASH);
          assert.strictEqual((yield* profiles.history).versions.length, 3);
        }),
      ),
  );

  it.effect(
    "refuses a file that is not a valid, normalized profile/1 and keeps the active one",
    () =>
      withProfiles(
        Effect.gen(function* () {
          const profiles = yield* EditorialProfileService.EditorialProfileService;
          const v2 = JSON.parse(NodeFS.readFileSync(V2_FIXTURE, "utf8")) as Record<string, unknown>;
          for (const bytes of [
            "not json",
            JSON.stringify({ ...v2, schema_version: "profile/2" }),
            JSON.stringify({ ...v2, include: [] }),
            JSON.stringify({ ...v2, name: "  SingulariDev  " }),
          ]) {
            const error = yield* Effect.flip(profiles.importFile(bytes));
            assert.strictEqual(error.reason, "invalid-profile");
          }
          assert.strictEqual((yield* profiles.get).version, 1);
        }),
      ),
  );

  it.effect("reads the scoring of the configuration the operator chose for the nightly run", () =>
    withProfiles(
      Effect.gen(function* () {
        const sql = yield* EditorialSql;
        yield* sql`
          INSERT INTO editorial_engine_config_choices (config_file, config_sha256, previous_file, actor, created_at)
          VALUES ('engine.v3.json', 'sha256:x', 'engine.v1.json', 'operator', '2026-11-09T05:00:00.000Z')
        `;
        const handlers = yield* EditorialProfileRpc.makeHandlers;
        const view = yield* handlers[EDITORIAL_PROFILE_WS_METHODS.get]();
        assert.strictEqual(view.scoring?.configVersion, "earlyscript.engine.v3");
      }),
    ),
  );

  it("reads with orchestration:read and writes with orchestration:operate", () => {
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_PROFILE_WS_METHODS.get),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_PROFILE_WS_METHODS.update),
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("answers the profile and the engine's scoring over RPC; refuses read-only writes", () =>
    withProfiles(
      Effect.gen(function* () {
        const handlers = yield* EditorialProfileRpc.makeHandlers;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayer(handlers),
              RpcAuthorization.layer([AuthOrchestrationReadScope]),
            ),
          ),
        );
        const view = yield* client[EDITORIAL_PROFILE_WS_METHODS.get]({});
        assert.strictEqual(view.active.version, 1);
        const config = JSON.parse(NodeFS.readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as {
          config_version: string;
          profile: { include_min: number };
        };
        assert.strictEqual(view.scoring?.configVersion, config.config_version);
        assert.deepInclude(view.scoring?.parameters ?? [], {
          key: "profile.include_min",
          value: config.profile.include_min,
        });
        const refused = yield* Effect.flip(client[EDITORIAL_PROFILE_WS_METHODS.update](EDITED));
        assert.strictEqual(refused._tag, "EnvironmentAuthorizationError");
        assert.strictEqual(
          (yield* client[EDITORIAL_PROFILE_WS_METHODS.history]({})).versions.length,
          1,
        );
      }).pipe(Effect.scoped),
    ),
  );

  it("reads the named scoring parameters in a fixed order and skips what is missing", () => {
    assert.isNull(EditorialProfileRpc.engineScoringOf({}));
    assert.deepStrictEqual(
      EditorialProfileRpc.engineScoringOf({
        config_version: "v",
        profile: { include_min: 0.6 },
        rank: { weighted: { weights: { growth: 0.5, include_score: 0.3 } } },
        emit: { max_dossiers: "20" },
      }),
      {
        configVersion: "v",
        parameters: [
          { key: "profile.include_min", value: 0.6 },
          { key: "rank.weighted.weights.growth", value: 0.5 },
          { key: "rank.weighted.weights.include_score", value: 0.3 },
        ],
      },
    );
  });
});
