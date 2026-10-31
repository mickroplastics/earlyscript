// @effect-diagnostics globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off - corpus/1 filesystem boundary.
// Deletion requests: removes one author's, one URL's or one feed's items from every day and
// history file of a corpus/1 directory and records the purge in the manifest, so collect never
// stores them again. Same record shape as the purge of es/sources-earlywindow (S2), plus the
// `feed` match for rss; the two merge into one module.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { EarlywindowCorpusManifest } from "@earlyscript/editorial-contracts/earlywindow";
import { CoverageRecord, SourceId } from "@earlyscript/editorial-contracts/source";
import { hashCorpus } from "./corpus.ts";
import { sha256 } from "./hash.ts";

const decodeManifest = Schema.decodeUnknownSync(EarlywindowCorpusManifest);
const decodeCoverage = Schema.decodeUnknownSync(CoverageRecord);

/**
 * One manifest `purges` entry. The identifier is stored as a SHA-256, not in clear: the
 * manifest keeps proof that a purge ran and lets collect refuse the items again, without
 * listing who asked.
 */
export const PurgeRecord = Schema.Struct({
  purged_at: Schema.String,
  source: SourceId,
  match: Schema.Literals(["author", "uri", "feed"]),
  value_sha256: Schema.String,
  items_removed: Schema.Int,
  files_rewritten: Schema.Int,
});
export type PurgeRecord = typeof PurgeRecord.Type;
const isPurgeRecord = Schema.is(PurgeRecord);

export interface PurgeTarget {
  readonly source: SourceId;
  /** The `author` field of an item. */
  readonly author?: string;
  /** An item permalink. */
  readonly uri?: string;
  /** A feed URL (rss): every item whose `feed_url` is this feed. */
  readonly feed?: string;
}

interface Matchable {
  readonly source: string;
  readonly author?: unknown;
  readonly permalink?: unknown;
  readonly feed_url?: unknown;
}

/** Values a target compares, normalized: lower-case authors, URLs as given. */
function targetValue(target: PurgeTarget): { match: PurgeRecord["match"]; value: string } {
  const given = (["author", "uri", "feed"] as const).filter((key) => target[key] !== undefined);
  if (given.length !== 1) throw new Error("Purge needs exactly one of --author, --url or --feed");
  const match = given[0]!;
  const raw = target[match]!.trim();
  if (!raw) throw new Error(`Empty --${match}`);
  if (match === "author") return { match, value: raw.replace(/^@/, "").toLowerCase() };
  if (match === "feed" && target.source !== "rss") throw new Error("--feed applies to rss only");
  return { match, value: raw };
}

/** Hashes an item would match under each purge kind. */
function itemValues(item: Matchable): Record<PurgeRecord["match"], Array<string>> {
  const text = (value: unknown) => (typeof value === "string" && value ? [value] : []);
  return {
    author: text(item.author).map((value) => sha256(value.toLowerCase())),
    uri: text(item.permalink).map((value) => sha256(value)),
    feed: text(item.feed_url).map((value) => sha256(value)),
  };
}

/** A predicate over items that any recorded purge removes; unknown purge shapes are ignored. */
export function purgeFilter(
  purges: ReadonlyArray<unknown> | undefined,
): (item: Matchable) => boolean {
  const records = (purges ?? []).filter(isPurgeRecord);
  if (!records.length) return () => false;
  return (item) => {
    const values = itemValues(item);
    return records.some(
      (record) =>
        record.source === item.source && values[record.match].includes(record.value_sha256),
    );
  };
}

export async function purgeCorpus(
  options: { readonly dir: string; readonly now?: () => string } & PurgeTarget,
) {
  const { match, value } = targetValue(options);
  const record = { source: options.source, match, value_sha256: sha256(value) };
  const matches = purgeFilter([{ ...record, purged_at: "", items_removed: 0, files_rewritten: 0 }]);
  const now = options.now ?? (() => new Date().toISOString());
  const root = NodePath.resolve(options.dir);
  const lockPath = NodePath.join(root, ".collect.lock");
  const lock = await NodeFSP.open(lockPath, "wx");
  try {
    const manifest = decodeManifest(
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8")),
    );
    if (hashCorpus(manifest) !== manifest.corpus_hash) throw new Error("Invalid corpus hash");
    // Idempotent: a purge already recorded is never written again.
    const already = (manifest.purges ?? [])
      .filter(isPurgeRecord)
      .find(
        (row) =>
          row.source === record.source &&
          row.match === record.match &&
          row.value_sha256 === record.value_sha256,
      );
    if (already)
      return { ...already, unchanged: true, message: "Already purged; corpus unchanged" };
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    const contents = new Map<string, Buffer>();
    for (const file of files.values()) {
      const bytes = await NodeFSP.readFile(NodePath.join(root, file.path));
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes)
        throw new Error(`Existing corpus mismatch: ${file.path}`);
      contents.set(file.path, bytes);
    }
    async function write(path: string, text: string) {
      const file = NodePath.join(root, path);
      await NodeFSP.writeFile(`${file}.tmp`, text);
      await NodeFSP.rename(`${file}.tmp`, file);
      files.set(path, { path, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    }
    let removed = 0;
    const dayCounts = new Map<string, { kept: number; removed: number }>();
    const edits: Array<{ path: string; text: string; isDay: boolean }> = [];
    // Day files of the source and every history copy: an earlier version must not keep the item.
    // Edits are planned first, so a target without matches leaves the corpus untouched.
    for (const [path, bytes] of contents) {
      const isDay = path.startsWith(`${options.source}/`) && path.endsWith(".jsonl");
      if (!isDay && !path.startsWith("history/")) continue;
      const lines = bytes.toString("utf8").split("\n").filter(Boolean);
      const kept = lines.filter((line) => {
        const row: unknown = JSON.parse(line);
        return !(
          typeof row === "object" &&
          row !== null &&
          "source" in row &&
          matches(row as Matchable)
        );
      });
      if (kept.length === lines.length) continue;
      removed += isDay ? lines.length - kept.length : 0;
      edits.push({ path, text: kept.map((line) => `${line}\n`).join(""), isDay });
      if (isDay)
        dayCounts.set(path.slice(options.source.length + 1, -6), {
          kept: kept.length,
          removed: lines.length - kept.length,
        });
    }
    // Nothing matched: no record, no rewrite, the manifest and corpus_hash stay as they were.
    if (!edits.length)
      return {
        ...record,
        purged_at: now(),
        items_removed: 0,
        files_rewritten: 0,
        unchanged: true,
        message: "No matches; corpus unchanged",
      };
    for (const { path, text, isDay } of edits) {
      if (isDay) {
        await write(path, text);
        continue;
      }
      // History files are named by their content hash; the scrubbed copy takes a new name.
      files.delete(path);
      await NodeFSP.rm(NodePath.join(root, path));
      if (text) await write(`history/${sha256(text).slice(7)}.jsonl`, text);
    }
    if (dayCounts.size) {
      const raw = contents.get("coverage.jsonl")?.toString("utf8") ?? "";
      const coverage = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeCoverage(JSON.parse(line)))
        .map((row) => {
          const counts = row.source === options.source ? dayCounts.get(row.day) : undefined;
          return counts
            ? {
                ...row,
                items: counts.kept,
                note: [row.note, `purged ${counts.removed} item(s) on request`]
                  .filter(Boolean)
                  .join("; "),
              }
            : row;
        });
      await write("coverage.jsonl", coverage.map((row) => `${JSON.stringify(row)}\n`).join(""));
    }
    const purge: PurgeRecord = {
      ...record,
      purged_at: now(),
      items_removed: removed,
      files_rewritten: edits.length,
    };
    // The record keeps future collections from storing the purged items again.
    const next = {
      schema_version: manifest.schema_version,
      from_day: manifest.from_day,
      to_day: manifest.to_day,
      files: [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
      selection_bias: manifest.selection_bias,
      selection: manifest.selection,
      purges: [...(manifest.purges ?? []), purge],
    };
    await NodeFSP.writeFile(
      NodePath.join(root, "corpus-manifest.json.tmp"),
      JSON.stringify({ ...next, corpus_hash: hashCorpus(next), written_at: now() }, null, 2) + "\n",
    );
    await NodeFSP.rename(
      NodePath.join(root, "corpus-manifest.json.tmp"),
      NodePath.join(root, "corpus-manifest.json"),
    );
    return { ...purge, unchanged: false, message: null };
  } finally {
    await lock.close();
    await NodeFSP.unlink(lockPath);
  }
}
