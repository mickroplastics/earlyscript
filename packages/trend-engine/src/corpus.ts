// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - plain library; the manifest is decoded with Schema.
// The corpus/1 reader. Hashing follows Earlywindow's src/engine/corpus.ts (manifestHash,
// listFiles, item checks) so the frozen corpus keeps its corpus_hash.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { EarlywindowCorpusManifest } from "@earlyscript/editorial-contracts/earlywindow";
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { CoverageRecord, SourceId } from "@earlyscript/editorial-contracts/source";

import { daysBetween } from "./days.ts";
import { sha256 } from "./hash.ts";
import type { SourceAdapter } from "./sources/adapter.ts";

const decodeManifest = Schema.decodeUnknownSync(EarlywindowCorpusManifest);
const SKIPPED = new Set([".collect-lock", "corpus-manifest.json", ".DS_Store"]);

async function listFiles(root: string, prefix = ""): Promise<Array<string>> {
  const files: Array<string> = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (SKIPPED.has(relative) || SKIPPED.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in corpus: ${relative}`);
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported corpus entry: ${relative}`);
  }
  return files.toSorted();
}

type ManifestFields = Pick<
  EarlywindowCorpusManifest,
  "schema_version" | "from_day" | "to_day" | "selection_bias" | "selection" | "purges"
>;

/** Earlywindow's corpus_hash: SHA-256 of the manifest fields and every file's hash and size. */
export async function hashCorpus(root: string, manifest: ManifestFields): Promise<string> {
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const path of await listFiles(root)) {
    const bytes = await NodeFSP.readFile(NodePath.join(root, path));
    files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
  }
  return sha256(
    JSON.stringify({
      schema_version: manifest.schema_version,
      from_day: manifest.from_day,
      to_day: manifest.to_day,
      selection_bias: manifest.selection_bias,
      selection: manifest.selection,
      files,
      ...(manifest.purges ? { purges: manifest.purges } : {}),
    }),
  );
}

export interface Corpus {
  readonly hash: string;
  /** The manifest's corpus_hash equals the hash of the files on disk. */
  readonly verified: boolean;
  readonly fromDay: string;
  readonly toDay: string;
  readonly items: ReadonlyArray<Item>;
  /** One row per source and day read; a day with no row is a gap. */
  readonly coverage: ReadonlyArray<CoverageRecord>;
  readonly missingDays: ReadonlyArray<{ readonly source: SourceId; readonly day: string }>;
}

export interface ReadCorpusOptions {
  readonly dir: string;
  readonly adapters: ReadonlyArray<SourceAdapter>;
  /** Exclusive. Day files at or after it are never opened. */
  readonly untilDay: string;
  /** Accept a corpus whose files no longer match its manifest, such as a copy with a day removed. */
  readonly allowUnverified?: boolean;
}

/**
 * Hashes every file with Earlywindow's manifest rule, then replays each source day
 * before `untilDay` through its adapter.
 */
export async function readCorpus(options: ReadCorpusOptions): Promise<Corpus> {
  const root = NodePath.resolve(options.dir);
  const manifest = decodeManifest(
    JSON.parse(await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8")),
  );
  const hash = await hashCorpus(root, manifest);
  const verified = hash === manifest.corpus_hash;
  if (!verified && options.allowUnverified !== true) {
    throw new Error(`Corpus files do not match corpus-manifest.json (${root})`);
  }

  const days = daysBetween(manifest.from_day, manifest.to_day).filter(
    (day) => day < options.untilDay,
  );
  const items: Array<Item> = [];
  const coverage: Array<CoverageRecord> = [];
  const missingDays: Array<{ source: SourceId; day: string }> = [];
  const ids = new Set<string>();
  for (const adapter of options.adapters) {
    const source = adapter.descriptor.id;
    for (const day of days) {
      const result = await adapter.collectDay(day);
      if (result.coverage) coverage.push(result.coverage);
      else missingDays.push({ source, day });
      let last = "";
      for (const item of result.items) {
        const order = `${item.published_at}/${item.id}`;
        if (item.source !== source || !item.published_at.startsWith(`${day}T`)) {
          throw new Error(`Item date or source mismatch: ${item.id}`);
        }
        if (ids.has(item.id)) throw new Error(`Duplicate corpus id: ${item.id}`);
        if (order < last) throw new Error(`Unsorted corpus day: ${source}/${day}`);
        ids.add(item.id);
        last = order;
        items.push(item);
      }
    }
  }
  return {
    hash,
    verified,
    fromDay: manifest.from_day,
    toDay: manifest.to_day,
    items,
    coverage,
    missingDays,
  };
}
