// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over corpus/1 files; manifests and rows are decoded with Schema.
// `engine corpus import --from <corpus> --to <live> --backup <dir>`: gives a live corpus the
// source days it lacks from another corpus/1 (eval-largo), so engine v3's five weeks have history
// from the first night (B6). It decides per source and per day: a day of a source is copied when
// the live corpus has no coverage row for it (or an `unavailable` row with an empty or missing
// file) and the day falls before that source's first covered day in the live corpus or in a gap
// inside its covered span. A source the live corpus never covered takes every source day before
// the live corpus's `to_day`. Each copied file is verified against the source manifest; a file
// already in the live corpus with content is never replaced (an identical one counts as present,
// so an interrupted import resumes); only an empty file of an uncovered day is filled.
// coverage.jsonl and the manifest are rewritten as `engine collect` does, under its lock, after a
// verified copy of the whole live corpus goes to `--backup`; the manifest's `repairs` names every
// imported row with `imported_from`, and the full record goes to `imports/`. `--dry-run` checks
// everything, writes nothing and reports, per source, the days before and after and the gaps left.
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
const LOCK = ".collect.lock";
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
  /**
   * A directory that does not exist yet: before anything is written, the whole live corpus is
   * copied there and verified. Required unless `dryRun`.
   */
  readonly backup?: string;
  readonly now?: () => string;
}

export interface CorpusImportFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /**
   * `copied` now; `present`: an identical file was already there (a resumed import); `filled`:
   * an empty file of a day the live corpus had as `unavailable` or without coverage was replaced.
   */
  readonly status: "copied" | "present" | "filled";
  /** The live corpus's coverage row this day's row replaces: only ever an `unavailable` one. */
  readonly replaces: "unavailable" | null;
}

/** One source's days in the live corpus before and after the import. */
export interface CorpusImportSourceSummary {
  readonly source: SourceId;
  /** Days with a coverage row that is not an `unavailable` day with an empty file. */
  readonly days_before: number;
  readonly first_before: string | null;
  readonly last_before: string | null;
  /** Days inside [first, last] without such a row. */
  readonly gaps_before: number;
  readonly imported: number;
  readonly days_after: number;
  readonly first_after: string | null;
  readonly last_after: string | null;
  readonly gaps_after: number;
  /** Uncovered days the source corpus could not give (no file, no row, or `unavailable` too). */
  readonly skipped: number;
}

export interface CorpusImportRecord {
  readonly schema_version: "earlyscript.corpus-import/2";
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
  /** The verified copy of the live corpus made before writing; null when nothing was written. */
  readonly backup: { readonly dir: string; readonly files: number } | null;
  readonly sources: ReadonlyArray<SourceId>;
  readonly by_source: ReadonlyArray<CorpusImportSourceSummary>;
  readonly files: ReadonlyArray<CorpusImportFile>;
  /** Uncovered live days not filled, with why. */
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

/** The bytes at `file`, or null when there is no file. */
function bytesAt(file: string): Buffer | null {
  try {
    return NodeFS.readFileSync(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
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

/** Replaces an empty file, checking again just before that it is still empty. */
async function fillEmpty(file: string, bytes: Buffer) {
  if ((await NodeFSP.stat(file)).size !== 0) throw new Error(`${file} is no longer empty`);
  const tmp = `${file}.import-${process.pid}.tmp`;
  await NodeFSP.writeFile(tmp, bytes, { flag: "wx" });
  await NodeFSP.rename(tmp, file);
}

/** Replaces a file the corpus rewrites on every capture (coverage.jsonl, the manifest). */
async function replace(file: string, text: string) {
  await NodeFSP.writeFile(`${file}.tmp`, text);
  await NodeFSP.rename(`${file}.tmp`, file);
}

/** Copies the live corpus (without its lock) to `dir`, which must not exist, and verifies it. */
function backupCorpus(root: string, dir: string, manifest: Manifest) {
  const target = NodePath.resolve(dir);
  const inside = NodePath.relative(root, target);
  if (inside === "" || !inside.startsWith("..")) {
    throw new Error(`--backup ${target} is inside the live corpus`);
  }
  if (NodeFS.existsSync(target)) throw new Error(`--backup ${target} already exists`);
  NodeFS.cpSync(root, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: (src) => NodePath.basename(src) !== LOCK,
  });
  const copied = readManifest(target);
  if (copied.corpus_hash !== manifest.corpus_hash) {
    throw new Error(`--backup ${target}: the copied manifest differs`);
  }
  for (const entry of copied.files) verifiedBytes(target, entry);
  return { dir: target, files: copied.files.length };
}

const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);

/** Days inside [first, last] of `covered` that it lacks. */
function span(covered: ReadonlySet<string>) {
  const days = [...covered].toSorted();
  const first = days[0] ?? null;
  const last = days.at(-1) ?? null;
  const gaps = first && last ? daysBetween(first, last).filter((d) => !covered.has(d)).length : 0;
  return { days: days.length, first, last, gaps };
}

interface Planned {
  readonly source: SourceId;
  readonly day: string;
  readonly entry: FileEntry;
  readonly row: CoverageRecord;
  readonly bytes: Buffer;
  readonly replaces: CoverageRecord | null;
}

export async function importCorpus(options: CorpusImportOptions): Promise<CorpusImportRecord> {
  const now = options.now ?? (() => new Date().toISOString());
  const fromRoot = corpusRoot(options.from);
  const toRoot = NodePath.resolve(options.to);
  if (fromRoot === toRoot) throw new Error("--from and --to are the same corpus");
  if (!options.dryRun && !options.backup) {
    throw new Error("--backup <dir> is required: the live corpus is copied there before writing");
  }
  const lockPath = NodePath.join(toRoot, LOCK);
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
    const liveRows = new Map(liveCoverage.map((row) => [`${row.source}/${row.day}`, row]));
    const sourceCoverageEntry = sourceFiles.get(COVERAGE);
    if (!sourceCoverageEntry) throw new Error(`${fromRoot} lists no ${COVERAGE}`);
    const sourceRows = new Map(
      lines(verifiedBytes(fromRoot, sourceCoverageEntry))
        .map((row) => decodeCoverage(row))
        .map((row) => [`${row.source}/${row.day}`, row]),
    );
    const sources =
      options.sources ?? [...new Set(liveCoverage.map((row) => row.source))].toSorted();
    if (sources.length === 0) throw new Error("No source to import: pass --sources");

    // A live day is covered when it has a coverage row, unless that row says `unavailable` and
    // the day's file is empty or missing: a day collect reached nothing for.
    const covered = (id: SourceId, day: string) => {
      const row = liveRows.get(`${id}/${day}`);
      if (!row) return false;
      if (row.status !== "unavailable") return true;
      return (liveFiles.get(`${id}/${day}.jsonl`)?.bytes ?? 0) > 0;
    };

    const planned: Array<Planned> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const coveredBefore = new Map<SourceId, Set<string>>();
    for (const id of sources) {
      const before = new Set(
        liveCoverage.filter((r) => r.source === id && covered(id, r.day)).map((r) => r.day),
      );
      coveredBefore.set(id, before);
      // Before the source's first covered day or inside its span; never after its last one,
      // which the live captures keep. A source never covered: every day before `to_day`.
      const limit = [...before].toSorted().at(-1) ?? live.to_day;
      const end = [limit, source.to_day].toSorted()[0]!;
      for (const day of daysBetween(source.from_day, end)) {
        if (before.has(day)) continue;
        const path = `${id}/${day}.jsonl`;
        const entry = sourceFiles.get(path);
        const row = sourceRows.get(`${id}/${day}`);
        const replaces = liveRows.get(`${id}/${day}`) ?? null;
        if (!entry) skipped.push({ path, reason: "no file in the source corpus" });
        else if (!row) skipped.push({ path, reason: "no coverage row in the source corpus" });
        else if (replaces && row.status === "unavailable") {
          skipped.push({ path, reason: "unavailable in both corpora" });
        } else {
          planned.push({
            source: id,
            day,
            entry,
            row,
            replaces,
            bytes: verifiedBytes(fromRoot, entry),
          });
        }
      }
    }

    // A file already in the live corpus with content is never replaced: that day stays as it is.
    const imports: Array<Planned & { file: CorpusImportFile }> = [];
    for (const plan of planned) {
      const { entry, bytes } = plan;
      const old = bytesAt(NodePath.join(toRoot, entry.path));
      let status: CorpusImportFile["status"];
      if (old === null) status = "copied";
      else if (old.equals(bytes)) status = "present";
      else if (old.length === 0) status = "filled";
      else {
        skipped.push({
          path: entry.path,
          reason: "exists in the live corpus with other content; not replaced",
        });
        continue;
      }
      const file: CorpusImportFile = {
        path: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
        status,
        replaces: plan.replaces ? "unavailable" : null,
      };
      imports.push({ ...plan, file });
    }
    // What the live corpus refuses (its purges) never enters it, and no item id repeats (a live
    // file at the same path is the same day, identical by now).
    const purged = purgeFilter(live.purges);
    const liveIds = new Map<string, string>();
    for (const entry of live.files) {
      if (!sources.some((id) => entry.path.startsWith(`${id}/`))) continue;
      for (const raw of lines(verifiedBytes(toRoot, entry)))
        liveIds.set(decodeItem(raw).id, entry.path);
    }
    const seen = new Set<string>();
    for (const { entry, bytes } of imports) {
      for (const raw of lines(bytes)) {
        const item = decodeItem(raw);
        if (purged(item)) {
          throw new Error(`${entry.path} holds an item the live corpus purged; nothing imported`);
        }
        const livePath = liveIds.get(item.id);
        if ((livePath !== undefined && livePath !== entry.path) || seen.has(item.id)) {
          throw new Error(`${entry.path} repeats item ${item.id}; nothing imported`);
        }
        seen.add(item.id);
      }
    }
    skipped.sort(byPath);

    const bySource: Array<CorpusImportSourceSummary> = sources.map((id) => {
      const before = coveredBefore.get(id)!;
      const mine = imports.filter((p) => p.source === id);
      const after = new Set(before);
      for (const p of mine) if (p.row.status !== "unavailable") after.add(p.day);
      const b = span(before);
      const a = span(after);
      return {
        source: id,
        days_before: b.days,
        first_before: b.first,
        last_before: b.last,
        gaps_before: b.gaps,
        imported: mine.length,
        days_after: a.days,
        first_after: a.first,
        last_after: a.last,
        gaps_after: a.gaps,
        skipped: skipped.filter((s) => s.path.startsWith(`${id}/`)).length,
      };
    });

    const files = imports.map((p) => p.file);
    const importedAt = now();
    const fromDayAfter = [live.from_day, ...imports.map((p) => p.day)].toSorted()[0]!;
    const base = {
      schema_version: "earlyscript.corpus-import/2" as const,
      tool: CORPUS_IMPORT_TOOL,
      imported_at: importedAt,
      dry_run: options.dryRun === true,
      from: { dir: fromRoot, corpus_hash: source.corpus_hash },
      sources,
      by_source: bySource,
      files,
      skipped,
    };
    const toBefore = {
      dir: toRoot,
      corpus_hash_before: live.corpus_hash,
      from_day_before: live.from_day,
      from_day_after: fromDayAfter,
    };
    if (imports.length === 0 || options.dryRun) {
      return {
        ...base,
        to: { ...toBefore, corpus_hash_after: null },
        backup: null,
        record_path: null,
      };
    }

    // Nothing is written until the whole live corpus is copied and verified elsewhere.
    const backup = backupCorpus(toRoot, options.backup!, live);

    for (const { entry, bytes, file } of imports) {
      const target = NodePath.join(toRoot, entry.path);
      if (file.status === "copied") await writeNew(target, bytes);
      else if (file.status === "filled") await fillEmpty(target, bytes);
    }
    // coverage.jsonl changes as on a capture: the former bytes go to history/ by hash. Imported
    // rows keep the source's bytes, so the corpus reads as the source over those days; their
    // provenance (`imported_from`) is in the manifest's repairs, which collect carries over.
    const rows = new Map(liveRows);
    for (const { source: id, day, row } of imports) rows.set(`${id}/${day}`, row);
    const coverage = [...rows.values()].toSorted(
      (a, b) => a.source.localeCompare(b.source) || a.day.localeCompare(b.day),
    );
    const coverageText = jsonl(coverage);
    const nextFiles = new Map(liveFiles);
    for (const file of files) {
      nextFiles.set(file.path, { path: file.path, sha256: file.sha256, bytes: file.bytes });
    }
    if (liveCoverageEntry) {
      const old = verifiedBytes(toRoot, liveCoverageEntry);
      const kept = `history/${sha256(old).slice(7)}.jsonl`;
      if (!NodeFS.existsSync(NodePath.join(toRoot, kept))) {
        await writeNew(NodePath.join(toRoot, kept), old);
      }
      nextFiles.set(kept, { path: kept, sha256: sha256(old), bytes: old.length });
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
          change: `${files.length} source days of ${[...new Set(imports.map((p) => p.source))].join(", ")} the live corpus lacked, copied byte for byte with their coverage rows`,
          reason:
            "history for the weeks the engine compares, from a corpus captured with the same adapters; not part of a capture of this corpus",
          from_corpus_hash: source.corpus_hash,
          rows: imports.map(({ source: id, day, file }) => ({
            source: id,
            day,
            sha256: file.sha256,
            imported_from: source.corpus_hash,
            ...(file.replaces ? { replaces: file.replaces } : {}),
          })),
          backup: backup.dir,
          record: recordName,
        },
      ],
    };
    const corpusHash = hashCorpus(manifest);
    const record: CorpusImportRecord = {
      ...base,
      to: { ...toBefore, corpus_hash_after: corpusHash },
      backup,
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

/** The per-source table of a record, in Markdown, for the operator. */
export function formatImportTable(record: CorpusImportRecord): string {
  const range = (first: string | null, last: string | null) =>
    first && last ? `${first} … ${last}` : "none";
  const rows = record.by_source.map((s) =>
    [
      s.source,
      `${s.days_before} (${range(s.first_before, s.last_before)})`,
      s.gaps_before,
      s.imported,
      `${s.days_after} (${range(s.first_after, s.last_after)})`,
      s.gaps_after,
      s.skipped,
    ].join(" | "),
  );
  return [
    `${record.dry_run ? "dry run" : "import"}: from_day ${record.to.from_day_before} -> ${record.to.from_day_after}`,
    "| source | days before (first … last) | gaps before | imported | days after (first … last) | gaps left | skipped |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}
