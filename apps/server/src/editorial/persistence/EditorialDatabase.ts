import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerConfig from "../../config.ts";
import { runEditorialMigrations } from "./Migrations.ts";

export const EDITORIAL_DATABASE_FILENAME = "editorial.sqlite";

const WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * The editorial database client. Editorial services read it through this tag,
 * never through `SqlClient.SqlClient`: publishing it under the global tag would
 * silently replace the orchestration client for every layer below it.
 */
export class EditorialSql extends Context.Service<EditorialSql, SqlClient.SqlClient>()(
  "t3/editorial/persistence/EditorialDatabase/EditorialSql",
) {}

const editorialDatabasePath = Effect.fn("editorialDatabasePath")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, EDITORIAL_DATABASE_FILENAME);
});

// Mirrors the pragmas of persistence/Sqlite.ts, without T3's migrations. The
// editorial database is small and written by hand, so it skips the reader and
// checkpoint workers.
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  const tables = yield* sql<{
    readonly count: number;
  }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
  if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  yield* sql`PRAGMA synchronous = NORMAL;`;
  yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
  yield* sql`PRAGMA temp_store = MEMORY;`;
  yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
  yield* runEditorialMigrations();
  return sql;
});

// `Layer.provide`, not `provideMerge`: the raw client stays inside this layer.
const layerFromClient = (client: Layer.Layer<SqlClient.SqlClient, SqlError>) =>
  Layer.effect(EditorialSql, setup).pipe(Layer.provide(client));

export const layerFromPath = Effect.fn("makeEditorialDatabase")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  return layerFromClient(
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "earlyscript-editorial",
      },
    }),
  );
}, Layer.unwrap);

/** `editorial.sqlite` next to `statev2.sqlite`, in the configured state directory. */
export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return layerFromPath(yield* editorialDatabasePath(stateDir));
  }),
);
