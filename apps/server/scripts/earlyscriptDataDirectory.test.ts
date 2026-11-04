// @effect-diagnostics nodeBuiltinImport:off - names paths below the real home without touching them.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import { runMigrateDevDb } from "./migrate-dev-db.ts";
import { runSqliteState } from "./t3-sqlite-state.ts";

// Paths that do not exist: even without the guard, both scripts would stop at "missing".
const insideT3 = NodePath.join(NodeOS.homedir(), ".t3", "earlyscript-guard-test-missing");

const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

it.layer(NodeServices.layer)("dev database scripts (Earlyscript guard)", (it) => {
  it.effect("migrate-dev-db never reads T3 Code's database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "es-migrate-dest-" });
      const exit = yield* Effect.exit(
        runMigrateDevDb({
          baseDir: destDir,
          source: NodePath.join(insideT3, "statev2.sqlite"),
          projects: 1,
          threadsPerProject: 0,
        }),
      );
      assert.include(refusalOf(exit), "pertenece a T3 Code");
    }).pipe(Effect.scoped),
  );

  it.effect("t3-sqlite-state never opens T3 Code's database", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runSqliteState({ operation: "query", baseDir: insideT3, sql: "SELECT 1" }),
      );
      assert.include(refusalOf(exit), "pertenece a T3 Code");
    }),
  );
});
