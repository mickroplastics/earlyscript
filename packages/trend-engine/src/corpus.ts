// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - plain library; the manifest is decoded with Schema.
// The corpus/1 reader. The manifest hash follows Earlywindow's src/engine/corpus.ts
// (manifestHash, item checks) so the frozen corpus keeps its corpus_hash.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { EarlywindowCorpusManifest } from "@earlyscript/editorial-contracts/earlywindow";
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { CoverageRecord, SourceId } from "@earlyscript/editorial-contracts/source";

import { daysBetween } from "./days.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import type { SourceAdapter } from "./sources/adapter.ts";

const decodeManifest = Schema.decodeUnknownSync(EarlywindowCorpusManifest);
const COVERAGE_FILE = "coverage.jsonl";

type ManifestFields = Pick<
  EarlywindowCorpusManifest,
  | "schema_version"
  | "from_day"
  | "to_day"
  | "selection_bias"
  | "selection"
  | "files"
  | "purges"
  | "robots_overrides"
  | "repairs"
>;
type FileHash = EarlywindowCorpusManifest["files"][number];

/** Earlywindow's corpus_hash: SHA-256 of the manifest fields and every file's hash and size. */
export function hashCorpus(manifest: ManifestFields): string {
  return sha256(
    JSON.stringify({
      schema_version: manifest.schema_version,
      from_day: manifest.from_day,
      to_day: manifest.to_day,
      selection_bias: manifest.selection_bias,
      selection: manifest.selection,
      files: manifest.files,
      ...(manifest.purges ? { purges: manifest.purges } : {}),
      // Earlyscript additions; absent, the hash is Earlywindow's.
      ...(manifest.robots_overrides ? { robots_overrides: manifest.robots_overrides } : {}),
      ...(manifest.repairs ? { repairs: manifest.repairs } : {}),
    }),
  );
}

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function hashFile(root: string, path: string): Promise<FileHash | null> {
  try {
    const bytes = await NodeFSP.readFile(NodePath.join(root, path));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export interface Corpus {
  /** SHA-256 of the day files and coverage rows read before the cutoff; nothing later enters it. */
  readonly usedHash: string;
  /** The frozen corpus's identity, the manifest's corpus_hash, taken without opening data files. */
  readonly manifestHash: string;
  /** The manifest is self-consistent and every file read matches its entry in it. */
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
  /** Accept a corpus whose files read no longer match its manifest, such as a copy with a day removed. */
  readonly allowUnverified?: boolean;
}

/**
 * Hashes coverage.jsonl and each source day file before `untilDay`, checks them against the
 * manifest, then replays those days through the adapters. Day files at or after `untilDay`
 * are never opened, so an unreadable or corrupt later day cannot fail or change a run.
 */
export async function readCorpus(options: ReadCorpusOptions): Promise<Corpus> {
  const root = NodePath.resolve(options.dir);
  const manifest = decodeManifest(
    JSON.parse(await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8")),
  );
  const days = daysBetween(manifest.from_day, manifest.to_day).filter(
    (day) => day < options.untilDay,
  );
  const paths = [
    COVERAGE_FILE,
    ...options.adapters.flatMap((adapter) =>
      days.map((day) => `${adapter.descriptor.id}/${day}.jsonl`),
    ),
  ];
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  const read: Array<FileHash> = [];
  let verified = hashCorpus(manifest) === manifest.corpus_hash;
  for (const path of paths) {
    const file = await hashFile(root, path);
    const entry = listed.get(path);
    if (file) read.push(file);
    if (file?.sha256 !== entry?.sha256 || file?.bytes !== entry?.bytes) verified = false;
  }
  if (!verified && options.allowUnverified !== true) {
    throw new Error(`Corpus files do not match corpus-manifest.json (${root})`);
  }

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
  // Coverage rows rather than coverage.jsonl's bytes: its rows for later days stay out.
  const usedHash = sha256(
    canonicalJson({
      schema_version: manifest.schema_version,
      until_day: options.untilDay,
      files: read.filter((file) => file.path !== COVERAGE_FILE),
      coverage,
    }),
  );
  return {
    usedHash,
    manifestHash: manifest.corpus_hash,
    verified,
    fromDay: manifest.from_day,
    toDay: manifest.to_day,
    items,
    coverage,
    missingDays,
  };
}
