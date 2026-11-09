// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over corpus/1 files; manifests and rows are decoded with Schema.
// `engine corpus import --from <corpus> --to <live>`: gives a live corpus the days before its
// first one from another corpus/1 (eval-largo), so engine v3's five weeks have history from the
// first night (B6). Only days before the live corpus's `from_day` are copied, byte for byte and
// each verified against the source manifest; no existing file is overwritten (an identical one
// counts as copied, so an interrupted import resumes); coverage.jsonl and the manifest are
// rewritten as `engine collect` does, under its lock; and a record of what was imported goes to
// `imports/` and to the manifest's `repairs`. `--dry-run` checks everything and writes nothing.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { EarlywindowCorpusManifest } from "@earlyscript/editorial-contracts/earlywindow";
import { Item } from "@earlyscript/editorial-contracts/item";
import { CoverageRecord, type SourceId } from "@earlyscript/editorial-contracts/source";

import { robotsOverridesOf } from "./collect.ts";
import { hashCorpus } from "./corpus.ts";
import { daysBetween } from "./days.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { purgeFilter } from "./purge.ts";

const decodeManifest = Schema.decodeUnknownSync(EarlywindowCorpusManifest);
const decodeCoverage = Schema.decodeUnknownSync(CoverageRecord);
const decodeItem = Schema.decodeUnknownSync(Item);

const MANIFEST = "corpus-manifest.json";
const COVERAGE = "coverage.jsonl";
export const CORPUS_IMPORT_TOOL = "engine corpus import";

type Manifest = EarlywindowCorpusManifest;
type FileEntry = Manifest["files"][number];

export interface CorpusImportOptions {
  /** A corpus/1 directory, or a directory whose `corpus/` is one (eval-largo). */
  readonly from: string;
  /** The live corpus; it must exist and verify. */
  readonly to: string;
  /** Default: the sources the live corpus has coverage for. */
  readonly sources?: ReadonlyArray<SourceId>;
  readonly dryRun?: boolean;
  readonly now?: () => string;
}

export interface CorpusImportFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** `copied` now, or `present`: an identical file was already there (a resumed import). */
  readonly status: "copied" | "present";
}

export interface CorpusImportRecord {
  readonly schema_version: "earlyscript.corpus-import/1";
  readonly tool: string;
  readonly imported_at: string;
  readonly dry_run: boolean;
  readonly from: { readonly dir: string; readonly corpus_hash: string };
  readonly to: {
    readonly dir: string;
    readonly corpus_hash_before: string;
    readonly corpus_hash_after: string | null;
    readonly from_day_before: string;
    readonly from_day_after: string;
  };
  readonly sources: ReadonlyArray<SourceId>;
  /** The days considered: the source corpus's days before the live corpus's first one. */
  readonly days: { readonly from: string | null; readonly to_exclusive: string | null };
  readonly files: ReadonlyArray<CorpusImportFile>;
  /** Source days not copied, with why: no file or no coverage row in the source corpus. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** Where this record was written; null for a dry run or when nothing was imported. */
  readonly record_path: string | null;
}

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function corpusRoot(dir: string): string {
  const root = NodePath.resolve(dir);
  if (NodeFS.existsSync(NodePath.join(root, MANIFEST))) return root;
  const nested = NodePath.join(root, "corpus");
  if (NodeFS.existsSync(NodePath.join(nested, MANIFEST))) return nested;
  throw new Error(`${root} has no ${MANIFEST}`);
}

function readManifest(root: string): Manifest {
  const manifest = decodeManifest(
    JSON.parse(NodeFS.readFileSync(NodePath.join(root, MANIFEST), "utf8")),
  );
  if (hashCorpus(manifest) !== manifest.corpus_hash) {
    throw new Error(`${root}/${MANIFEST} does not hash to its corpus_hash`);
  }
  return manifest;
}

/** The bytes of `path` if they are the manifest's; throws otherwise. */
function verifiedBytes(root: string, entry: FileEntry): Buffer {
  const bytes = NodeFS.readFileSync(NodePath.join(root, entry.path));
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
    throw new Error(`${root}/${entry.path} does not match its manifest entry`);
  }
  return bytes;
}

const lines = (bytes: Buffer): Array<unknown> =>
  bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));

const jsonl = (rows: ReadonlyArray<unknown>) =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/** Writes `bytes` at `file` only if nothing is there: a hard link never replaces a file. */
async function writeNew(file: string, bytes: Buffer | string) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const tmp = `${file}.import-${process.pid}.tmp`;
  await NodeFSP.writeFile(tmp, bytes, { flag: "wx" });
  try {
    await NodeFSP.link(tmp, file);
  } finally {
    await NodeFSP.unlink(tmp);
  }
}

/** Replaces a file the corpus rewrites on every capture (coverage.jsonl, the manifest). */
async function replace(file: string, text: string) {
  await NodeFSP.writeFile(`${file}.tmp`, text);
  await NodeFSP.rename(`${file}.tmp`, file);
}

const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);

export async function importCorpus(options: CorpusImportOptions): Promise<CorpusImportRecord> {
  const now = options.now ?? (() => new Date().toISOString());
  const fromRoot = corpusRoot(options.from);
  const toRoot = NodePath.resolve(options.to);
  if (fromRoot === toRoot) throw new Error("--from and --to are the same corpus");
  const lockPath = NodePath.join(toRoot, ".collect.lock");
  // The live corpus must exist: an import never creates one.
  const lock = options.dryRun ? null : await NodeFSP.open(lockPath, "wx");
  try {
    const source = readManifest(fromRoot);
    const live = readManifest(toRoot);
    // The live corpus verifies as collect requires before it writes.
    for (const entry of live.files) verifiedBytes(toRoot, entry);
    const sourceFiles = new Map(source.files.map((file) => [file.path, file]));
    const liveFiles = new Map(live.files.map((file) => [file.path, file]));
    const liveCoverageEntry = liveFiles.get(COVERAGE);
    const liveCoverage = liveCoverageEntry
      ? lines(verifiedBytes(toRoot, liveCoverageEntry)).map((row) => decodeCoverage(row))
      : [];
    const sourceCoverageEntry = sourceFiles.get(COVERAGE);
    if (!sourceCoverageEntry) throw new Error(`${fromRoot} lists no ${COVERAGE}`);
    const sourceCoverage = new Map(
      lines(verifiedBytes(fromRoot, sourceCoverageEntry))
        .map((row) => decodeCoverage(row))
        .map((row) => [`${row.source}/${row.day}`, row]),
    );
    const sources =
      options.sources ?? [...new Set(liveCoverage.map((row) => row.source))].toSorted();
    if (sources.length === 0) throw new Error("No source to import: pass --sources");

    // Only days before the live corpus's first day, and within the source corpus.
    const end = [live.from_day, source.to_day].toSorted()[0]!;
    const days = daysBetween(source.from_day, end);
    const planned: Array<{ day: string; entry: FileEntry; row: CoverageRecord; bytes: Buffer }> =
      [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const id of sources) {
      for (const day of days) {
        const path = `${id}/${day}.jsonl`;
        const entry = sourceFiles.get(path);
        const row = sourceCoverage.get(`${id}/${day}`);
        if (!entry) skipped.push({ path, reason: "no file in the source corpus" });
        else if (!row) skipped.push({ path, reason: "no coverage row in the source corpus" });
        else planned.push({ day, entry, row, bytes: verifiedBytes(fromRoot, entry) });
      }
    }

    // What the live corpus refuses (its purges) never enters it, and no item id repeats.
    const purged = purgeFilter(live.purges);
    const liveIds = new Set<string>();
    for (const entry of live.files) {
      if (!sources.some((id) => entry.path.startsWith(`${id}/`))) continue;
      for (const raw of lines(verifiedBytes(toRoot, entry))) liveIds.add(decodeItem(raw).id);
    }
    const seen = new Set<string>();
    for (const { entry, bytes } of planned) {
      for (const raw of lines(bytes)) {
        const item = decodeItem(raw);
        if (purged(item)) {
          throw new Error(`${entry.path} holds an item the live corpus purged; nothing imported`);
        }
        if (liveIds.has(item.id) || seen.has(item.id)) {
          throw new Error(`${entry.path} repeats item ${item.id}; nothing imported`);
        }
        seen.add(item.id);
      }
      const existing = liveFiles.get(entry.path);
      if (existing && existing.sha256 !== entry.sha256) {
        throw new Error(`${toRoot}/${entry.path} is in the live manifest with other bytes`);
      }
      if (liveCoverage.some((row) => `${row.source}/${row.day}.jsonl` === entry.path)) {
        throw new Error(`the live corpus already has coverage for ${entry.path}`);
      }
    }

    const files: Array<CorpusImportFile> = [];
    for (const { entry, bytes } of planned) {
      const target = NodePath.join(toRoot, entry.path);
      let present = false;
      try {
        const old = await NodeFSP.readFile(target);
        if (!old.equals(bytes)) throw new Error(`${target} exists with other bytes; not replaced`);
        present = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      files.push({
        path: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
        status: present ? "present" : "copied",
      });
    }

    const importedAt = now();
    const base = {
      schema_version: "earlyscript.corpus-import/1" as const,
      tool: CORPUS_IMPORT_TOOL,
      imported_at: importedAt,
      dry_run: options.dryRun === true,
      from: { dir: fromRoot, corpus_hash: source.corpus_hash },
      sources,
      days: { from: days[0] ?? null, to_exclusive: days.length > 0 ? end : null },
      files,
      skipped,
    };
    const fromDayAfter = [live.from_day, ...planned.map((p) => p.day)].toSorted()[0]!;
    if (files.length === 0 || options.dryRun) {
      return {
        ...base,
        to: {
          dir: toRoot,
          corpus_hash_before: live.corpus_hash,
          corpus_hash_after: null,
          from_day_before: live.from_day,
          from_day_after: fromDayAfter,
        },
        record_path: null,
      };
    }

    for (const { entry, bytes } of planned) {
      const target = NodePath.join(toRoot, entry.path);
      if (!NodeFS.existsSync(target)) await writeNew(target, bytes);
    }
    // coverage.jsonl changes as on a capture: the former bytes go to history/ by hash.
    const coverage = [...liveCoverage, ...planned.map(({ row }) => row)].toSorted(
      (a, b) => a.source.localeCompare(b.source) || a.day.localeCompare(b.day),
    );
    const coverageText = jsonl(coverage);
    const nextFiles = new Map(liveFiles);
    for (const file of files) {
      nextFiles.set(file.path, { path: file.path, sha256: file.sha256, bytes: file.bytes });
    }
    if (liveCoverageEntry) {
      const old = verifiedBytes(toRoot, liveCoverageEntry);
      const backup = `history/${sha256(old).slice(7)}.jsonl`;
      if (!NodeFS.existsSync(NodePath.join(toRoot, backup))) {
        await writeNew(NodePath.join(toRoot, backup), old);
      }
      nextFiles.set(backup, { path: backup, sha256: sha256(old), bytes: old.length });
    }
    await replace(NodePath.join(toRoot, COVERAGE), coverageText);
    nextFiles.set(COVERAGE, {
      path: COVERAGE,
      sha256: sha256(coverageText),
      bytes: Buffer.byteLength(coverageText),
    });

    const recordName = `imports/${importedAt.replace(/[:.]/g, "-")}-corpus-import.json`;
    const purges = [
      ...new Map(
        [...(live.purges ?? []), ...(source.purges ?? [])].map((p) => [canonicalJson(p), p]),
      ).values(),
    ];
    const manifest = {
      schema_version: "corpus/1" as const,
      from_day: fromDayAfter,
      to_day: live.to_day,
      files: [...nextFiles.values()].toSorted(byPath),
      selection_bias: live.selection_bias,
      // The live corpus's own description wins; a source it lacks keeps the imported one's.
      selection: { ...source.selection, ...live.selection },
      ...(purges.length > 0 ? { purges } : {}),
      ...robotsOverridesOf(coverage),
      repairs: [
        ...(live.repairs ?? []),
        {
          repaired_at: importedAt,
          tool: CORPUS_IMPORT_TOOL,
          change: `${files.length} day files of ${sources.join(", ")} before ${live.from_day} copied byte for byte with their coverage rows`,
          reason:
            "history for the weeks the engine compares, from a corpus captured with the same adapters; not part of a capture of this corpus",
          from_corpus_hash: source.corpus_hash,
          days: base.days,
          record: recordName,
        },
      ],
    };
    const corpusHash = hashCorpus(manifest);
    const record: CorpusImportRecord = {
      ...base,
      to: {
        dir: toRoot,
        corpus_hash_before: live.corpus_hash,
        corpus_hash_after: corpusHash,
        from_day_before: live.from_day,
        from_day_after: fromDayAfter,
      },
      record_path: NodePath.join(toRoot, recordName),
    };
    // The record first, so a manifest that names it always has it beside.
    await writeNew(NodePath.join(toRoot, recordName), `${JSON.stringify(record, null, 2)}\n`);
    await replace(
      NodePath.join(toRoot, MANIFEST),
      `${JSON.stringify({ ...manifest, corpus_hash: corpusHash, written_at: importedAt }, null, 2)}\n`,
    );
    return record;
  } finally {
    if (lock) {
      await lock.close();
      await NodeFSP.unlink(lockPath);
    }
  }
}
