// @effect-diagnostics nodeBuiltinImport:off - plain library; node:sqlite ships with Node.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { sha256 } from "../hash.ts";
import { DIMENSIONS } from "./spec.ts";

/** Vectors by (embedding key, text hash). Only the parent process writes it. */
export class EmbeddingCache {
  private readonly db: NodeSqlite.DatabaseSync;
  private readonly key: string;
  private readonly select;
  private readonly insert;

  constructor(file: string, key: string, readOnly = false) {
    if (!readOnly) NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    this.key = key;
    this.db = new NodeSqlite.DatabaseSync(file, { readOnly });
    if (!readOnly)
      this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS embeddings (
        embedding_key TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        vector BLOB NOT NULL CHECK (length(vector) = ${DIMENSIONS * 4}),
        PRIMARY KEY (embedding_key, text_hash)
      ) STRICT;
    `);
    this.select = this.db.prepare(
      "SELECT vector FROM embeddings WHERE embedding_key = ? AND text_hash = ?",
    );
    this.insert = this.db.prepare("INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?)");
  }

  get(text: string): Float32Array | undefined {
    const row = this.select.get(this.key, sha256(text));
    if (!row) return undefined;
    const blob = row.vector;
    if (!(blob instanceof Uint8Array) || blob.byteLength !== DIMENSIONS * 4) {
      throw new Error("Invalid embedding cache entry");
    }
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  }

  setMany(entries: ReadonlyArray<readonly [string, Float32Array]>): void {
    this.db.exec("BEGIN");
    try {
      for (const [text, vector] of entries) {
        this.insert.run(
          this.key,
          sha256(text),
          new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
