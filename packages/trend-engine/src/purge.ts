// @effect-diagnostics globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off - corpus/1 filesystem boundary.
// Deletion requests: removes one author's or one URI's items from every day and history file
// of a corpus/1 directory and records the purge in the manifest, so collect never stores them again.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { EarlywindowCorpusManifest } from "@earlyscript/editorial-contracts/earlywindow";
import { CoverageRecord, SourceId } from "@earlyscript/editorial-contracts/source";
import { hashCorpus } from "./corpus.ts";
import { sha256 } from "./hash.ts";
import { blueskyPermalink } from "./sources/bluesky.ts";

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
  match: Schema.Literals(["author", "uri"]),
  value_sha256: Schema.String,
  items_removed: Schema.Int,
  files_rewritten: Schema.Int,
});
export type PurgeRecord = typeof PurgeRecord.Type;
const isPurgeRecord = Schema.is(PurgeRecord);

export interface PurgeTarget {
  readonly source: SourceId;
  /** A Bluesky DID or handle, or the `author` field of any other source. */
  readonly author?: string;
  /** An item permalink; for Bluesky also the post's at:// URI. */
  readonly uri?: string;
}

interface Matchable {
  readonly source: string;
  readonly author?: unknown;
  readonly permalink?: unknown;
}

/** Values a target compares, normalized: lower-case authors and permalinks for URIs. */
function targetValue(target: PurgeTarget): { match: "author" | "uri"; value: string } {
  if ((target.author === undefined) === (target.uri === undefined))
    throw new Error("Purge needs exactly one of --author or --uri");
  if (target.author !== undefined) {
    const author = target.author.trim().replace(/^@/, "").toLowerCase();
    if (!author) throw new Error("Empty --author");
    return { match: "author", value: author };
  }
  const uri = target.uri!.trim();
  const permalink = uri.startsWith("at://") ? blueskyPermalink(uri) : uri;
  if (!permalink || (uri.startsWith("at://") && target.source !== "bluesky"))
    throw new Error(`Not a purgeable URI: ${uri}`);
  return { match: "uri", value: permalink };
}

/** Hashes an item would match under each purge kind. Bluesky authors match by handle and by DID. */
function itemValues(item: Matchable): { author: Array<string>; uri: Array<string> } {
  const permalink = typeof item.permalink === "string" ? item.permalink : "";
  const author = typeof item.author === "string" ? [item.author.toLowerCase()] : [];
  const did =
    item.source === "bluesky" ? /^https:\/\/bsky\.app\/profile\/(did:[^/]+)\//.exec(permalink) : null;
  return {
    author: [...author, ...(did?.[1] ? [did[1].toLowerCase()] : [])].map((value) => sha256(value)),
    uri: permalink ? [sha256(permalink)] : [],
  };
}

/** A predicate over items that any recorded purge removes; unknown purge shapes are ignored. */
export function purgeFilter(purges: ReadonlyArray<unknown> | undefined): (item: Matchable) => boolean {
  const records = (purges ?? []).filter(isPurgeRecord);
  if (!records.length) return () => false;
  return (item) => {
    const values = itemValues(item);
    return records.some(
      (record) => record.source === item.source && values[record.match].includes(record.value_sha256),
    );
  };
}

export async function purgeCorpus(options: { readonly dir: string } & PurgeTarget) {
  const { match, value } = targetValue(options);
  const record = { source: options.source, match, value_sha256: sha256(value) };
  const matches = purgeFilter([{ ...record, purged_at: "", items_removed: 0, files_rewritten: 0 }]);
  const root = NodePath.resolve(options.dir);
  const lockPath = NodePath.join(root, ".collect.lock");
  const lock = await NodeFSP.open(lockPath, "wx");
  try {
    const manifest = decodeManifest(
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8")),
    );
    if (hashCorpus(manifest) !== manifest.corpus_hash) throw new Error("Invalid corpus hash");
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
    let rewritten = 0;
    const dayCounts = new Map<string, { kept: number; removed: number }>();
    // Day files of the source and every history copy: an earlier version must not keep the item.
    for (const [path, bytes] of contents) {
      const isDay = path.startsWith(`${options.source}/`) && path.endsWith(".jsonl");
      if (!isDay && !path.startsWith("history/")) continue;
      const lines = bytes.toString("utf8").split("\n").filter(Boolean);
      const kept = lines.filter((line) => {
        const row: unknown = JSON.parse(line);
        return !(typeof row === "object" && row !== null && "source" in row && matches(row as Matchable));
      });
      if (kept.length === lines.length) continue;
      removed += isDay ? lines.length - kept.length : 0;
      rewritten++;
      const text = kept.map((line) => `${line}\n`).join("");
      if (isDay) {
        await write(path, text);
        dayCounts.set(path.slice(options.source.length + 1, -6), {
          kept: kept.length,
          removed: lines.length - kept.length,
        });
        continue;
      }
      // History files are named by their content hash; the scrubbed copy takes a new name.
      files.delete(path);
      await NodeFSP.rm(NodePath.join(root, path));
      if (kept.length) await write(`history/${sha256(text).slice(7)}.jsonl`, text);
    }
    if (dayCounts.size) {
      const raw = contents.get("coverage.jsonl")?.toString("utf8") ?? "";
      let coverage: Array<CoverageRecord> = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeCoverage(JSON.parse(line)));
      coverage = coverage.map((row) => {
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
      purged_at: new Date().toISOString(),
      items_removed: removed,
      files_rewritten: rewritten,
    };
    // A purge that removed nothing is still recorded: it keeps future collections from storing the items.
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
      JSON.stringify(
        { ...next, corpus_hash: hashCorpus(next), written_at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
    await NodeFSP.rename(
      NodePath.join(root, "corpus-manifest.json.tmp"),
      NodePath.join(root, "corpus-manifest.json"),
    );
    return purge;
  } finally {
    await lock.close();
    await NodeFSP.unlink(lockPath);
  }
}
