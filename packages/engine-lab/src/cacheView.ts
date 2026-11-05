// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the executor's own copies of the embedding cache.
// The embedding cache as an input of one cutoff: the entries that cutoff's run reads, taken by
// the trusted side from the shared cache (or inferred by the installed embedder) into a small
// file of their own. The arms read only that file, cache-only and read-only, so neither needs
// the model, a child process or write access to a shared cache; its entries are hashed, and
// checked again before signing and on recovery.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import { readCorpus } from "@earlyscript/trend-engine/corpus";
import { asQuery } from "@earlyscript/trend-engine/run";
import { fixtureSources } from "@earlyscript/trend-engine/sources";

import { canonicalJson, sha256 } from "./hash.ts";
import { LabPolicyError } from "./policy.ts";

/** The installed engine's own text preparation and cache, which its package does not export. */
interface EngineInternals {
  readonly prepare: (
    items: ReadonlyArray<unknown>,
    cfg: EngineConfig["text"],
  ) => ReadonlyArray<{ readonly text: string; readonly excluded: string | null }>;
  readonly embeddingKey: (spec: unknown) => string;
  readonly embeddingSpec: (embedder: EngineConfig["embedder"]) => unknown;
  readonly createLocalEmbedder: (
    spec: unknown,
    options: Record<string, unknown>,
  ) => {
    embed: (texts: ReadonlyArray<string>) => Promise<Array<Float32Array>>;
    dispose: () => Promise<void>;
  };
}

const internals = async (engineRoot: string): Promise<EngineInternals> => {
  const src = NodePath.join(engineRoot, "packages", "trend-engine", "src");
  const load = (file: string) => import(NodeURL.pathToFileURL(NodePath.join(src, file)).href);
  const [prepare, spec, local] = await Promise.all([
    load("prepare.ts"),
    load("embed/spec.ts"),
    load("embed/local.ts"),
  ]);
  return {
    prepare: prepare.prepare,
    embeddingKey: spec.embeddingKey,
    embeddingSpec: spec.embeddingSpec,
    createLocalEmbedder: local.createLocalEmbedder,
  };
};

/** What one cutoff's run embeds: its kept items' texts and the profile's queries, by key. */
export async function textsOf(input: {
  readonly engineRoot: string;
  readonly corpusDir: string;
  readonly cutoff: string;
  readonly profilePath: string;
  readonly config: EngineConfig;
}): Promise<{ readonly key: string; readonly texts: ReadonlyArray<string> }> {
  const engine = await internals(input.engineRoot);
  const cutoffMs = Date.parse(input.cutoff);
  const corpus = await readCorpus({
    dir: input.corpusDir,
    adapters: fixtureSources(input.corpusDir, input.config.sources),
    untilDay: input.cutoff.slice(0, 10),
  });
  const items = corpus.items.filter((item) => Date.parse(item.published_at) < cutoffMs);
  const kept = engine.prepare(items, input.config.text).filter((item) => item.excluded === null);
  const profile = JSON.parse(NodeFS.readFileSync(input.profilePath, "utf8")) as {
    readonly include?: ReadonlyArray<string>;
    readonly exclude?: ReadonlyArray<string>;
  };
  const query = (topic: string) => asQuery(input.config.profile.query_instruction, topic);
  return {
    key: engine.embeddingKey(engine.embeddingSpec(input.config.embedder)),
    texts: [
      ...new Set([
        ...kept.map((item) => item.text),
        ...(profile.include ?? []).map(query),
        ...(profile.exclude ?? []).map(query),
      ]),
    ],
  };
}

const VECTOR_BYTES = 1024 * 4;

const createFile = (file: string) => {
  NodeFS.rmSync(file, { force: true });
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(file);
  // The engine's own table, in a plain rollback journal: the arms open it read-only.
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE embeddings (
      embedding_key TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      vector BLOB NOT NULL CHECK (length(vector) = ${VECTOR_BYTES}),
      PRIMARY KEY (embedding_key, text_hash)
    ) STRICT;
  `);
  return db;
};

type Row = {
  readonly embedding_key: string;
  readonly text_hash: string;
  readonly vector: Uint8Array;
};

const readRows = (file: string): Array<Row> => {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT embedding_key, text_hash, vector FROM embeddings")
      .all() as unknown as Array<Row>;
  } finally {
    db.close();
  }
};

/** The identity of a set of entries: key, text hash and vector hash of each, sorted. */
const entriesHash = (rows: ReadonlyArray<Row>) =>
  sha256(
    canonicalJson(
      rows.map((row) => `${row.embedding_key}\n${row.text_hash}\n${sha256(row.vector)}`).toSorted(),
    ),
  );

/** The entries hash of a cache view file, read back from its rows. */
export const cacheViewHash = (file: string) => entriesHash(readRows(file));

export interface CacheView {
  readonly file: string;
  readonly entries: number;
  readonly entries_hash: string;
  /** Texts no cache had and the installed embedder computed, into `inferredFile`. */
  readonly inferred: number;
  /** Texts no cache had and nothing computed: the cache-only arms fail on them. */
  readonly missing: number;
}

const lookup = (file: string | null, key: string) => {
  if (file === null || !NodeFS.existsSync(file)) return () => undefined;
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  const select = db.prepare(
    "SELECT vector FROM embeddings WHERE embedding_key = ? AND text_hash = ?",
  );
  return Object.assign(
    (text: string) => {
      const row = select.get(key, sha256(text)) as { vector?: Uint8Array } | undefined;
      return row?.vector;
    },
    { close: () => db.close() },
  );
};

/**
 * Writes `out`, the cache view of one cutoff: for each text that cutoff embeds, its vector
 * from the shared cache, else from the job's private cache of inferred vectors, else, when
 * `infer` is given, computed now by the installed embedder into that private cache. The
 * shared cache is only read.
 */
export async function buildCacheView(input: {
  readonly engineRoot: string;
  readonly corpusDir: string;
  readonly cutoff: string;
  readonly profilePath: string;
  readonly configs: ReadonlyArray<EngineConfig>;
  readonly sharedCache: string | null;
  readonly inferredFile: string;
  /**
   * Null leaves missing entries missing. `allowDownload` follows the installed engine: the
   * nightly fetches the pinned model when it is absent; an evaluation, whose models are fixed
   * by hash, fails clearly instead.
   */
  readonly infer: {
    readonly modelDir: string;
    readonly workers: number;
    readonly allowDownload: boolean;
  } | null;
  readonly out: string;
}): Promise<CacheView> {
  const engine = await internals(input.engineRoot);
  const db = createFile(input.out);
  const insert = db.prepare("INSERT OR IGNORE INTO embeddings VALUES (?, ?, ?)");
  let inferred = 0;
  let missing = 0;
  try {
    const seen = new Set<string>();
    for (const config of input.configs) {
      const { key, texts } = await textsOf({ ...input, config });
      const shared = lookup(input.sharedCache, key);
      let own = lookup(input.inferredFile, key);
      const absent = texts.filter((text) => shared(text) === undefined && own(text) === undefined);
      if (absent.length > 0 && input.infer !== null) {
        // The installed embedder, in this trusted process's children, writes only the job's
        // private cache; the shared one keeps exactly what it had.
        (own as { close?: () => void }).close?.();
        const embedder = engine.createLocalEmbedder(engine.embeddingSpec(config.embedder), {
          cacheFile: input.inferredFile,
          modelDir: input.infer.modelDir,
          workers: input.infer.workers,
          allowDownload: input.infer.allowDownload,
          cacheOnly: false,
        });
        try {
          await embedder.embed(absent);
        } finally {
          await embedder.dispose();
        }
        inferred += absent.length;
        own = lookup(input.inferredFile, key);
      }
      for (const text of texts) {
        const id = `${key}\n${text}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const vector = shared(text) ?? own(text);
        if (vector === undefined) missing++;
        else insert.run(key, sha256(text), vector);
      }
      (shared as { close?: () => void }).close?.();
      (own as { close?: () => void }).close?.();
    }
  } finally {
    db.close();
  }
  NodeFS.chmodSync(input.out, 0o444);
  const rows = readRows(input.out);
  return {
    file: input.out,
    entries: rows.length,
    entries_hash: entriesHash(rows),
    inferred,
    missing,
  };
}

/**
 * Throws unless every entry of the cache view `file` still has its vector in the shared
 * cache or in the job's private inferred cache, and the view still hashes to `expected`: an
 * entry the arms read, changed in either cache after the view was made, voids the result.
 */
export function verifyCacheView(input: {
  readonly file: string;
  readonly expected: string;
  readonly sharedCache: string | null;
  readonly inferredFile: string;
}): void {
  const rows = readRows(input.file);
  if (entriesHash(rows) !== input.expected) {
    throw new LabPolicyError("artifact-mismatch", `The cache view ${input.file} changed.`);
  }
  const open = (file: string | null) =>
    file === null || !NodeFS.existsSync(file)
      ? null
      : new NodeSqlite.DatabaseSync(file, { readOnly: true });
  const shared = open(input.sharedCache);
  const own = open(input.inferredFile);
  try {
    const select = (db: NodeSqlite.DatabaseSync | null, row: Row) =>
      db === null
        ? undefined
        : (
            db
              .prepare("SELECT vector FROM embeddings WHERE embedding_key = ? AND text_hash = ?")
              .get(row.embedding_key, row.text_hash) as { vector?: Uint8Array } | undefined
          )?.vector;
    for (const row of rows) {
      const source = select(shared, row) ?? select(own, row);
      if (source === undefined || sha256(source) !== sha256(row.vector)) {
        throw new LabPolicyError(
          "artifact-mismatch",
          `A cache entry the arms read (${row.text_hash.slice(0, 19)}…) changed or is gone from its cache.`,
        );
      }
    }
  } finally {
    shared?.close();
    own?.close();
  }
}
