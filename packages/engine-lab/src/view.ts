// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the executor's own copies of the corpus.
// What an arm may read of the corpus: for each cutoff, a copy made by the executor, outside any
// candidate, of the day files and coverage rows before that cutoff, with its own manifest. Both
// arms of a cutoff read the same copy; nothing later, and no path to the whole corpus, is ever
// visible to them. The copy is checked byte for byte against the corpus manifest as it is made.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { hashCorpus } from "@earlyscript/trend-engine/corpus";

import { sha256 } from "./hash.ts";
import { LabPolicyError } from "./policy.ts";

type CorpusFields = Parameters<typeof hashCorpus>[0];

interface CorpusManifest {
  readonly schema_version: string;
  readonly from_day: string;
  readonly to_day: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }>;
  readonly selection_bias: string;
  readonly selection: Readonly<Record<string, string>>;
  readonly purges?: ReadonlyArray<unknown>;
  readonly robots_overrides?: ReadonlyArray<{ readonly day: string }>;
  readonly repairs?: ReadonlyArray<unknown>;
  readonly corpus_hash: string;
}

const COVERAGE = "coverage.jsonl";
const DAY_FILE = /^([a-z0-9_-]+)\/(\d{4}-\d{2}-\d{2})\.jsonl$/;

const mismatch = (message: string) => new LabPolicyError("artifact-mismatch", message);

const readManifest = (corpusDir: string): CorpusManifest => {
  try {
    return JSON.parse(
      NodeFS.readFileSync(NodePath.join(corpusDir, "corpus-manifest.json"), "utf8"),
    ) as CorpusManifest;
  } catch {
    throw mismatch(`${corpusDir} has no readable corpus-manifest.json.`);
  }
};

/** The bytes of a listed file, only when they are the ones the manifest lists. */
const listedBytes = (corpusDir: string, entry: CorpusManifest["files"][number]) => {
  let bytes: Buffer;
  try {
    bytes = NodeFS.readFileSync(NodePath.join(corpusDir, entry.path));
  } catch {
    throw mismatch(`${entry.path} is listed by the corpus manifest but missing.`);
  }
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw mismatch(`${entry.path} differs from the corpus manifest.`);
  }
  return bytes;
};

/**
 * The corpus' identity: its manifest's corpus_hash, after checking the manifest hashes to it
 * and every file it lists has the listed bytes. A corpus edited under the same path has
 * another identity, or fails here.
 */
export function corpusIdentity(corpusDir: string): string {
  const manifest = readManifest(corpusDir);
  if (hashCorpus(manifest as unknown as CorpusFields) !== manifest.corpus_hash) {
    throw mismatch(`${corpusDir}: the corpus manifest does not hash to its corpus_hash.`);
  }
  for (const entry of manifest.files) listedBytes(corpusDir, entry);
  return manifest.corpus_hash;
}

/** A content hash of every regular file below `dir`, by relative path. */
export function treeHash(dir: string): string {
  const entries: Array<string> = [];
  const walk = (rel: string) => {
    const full = NodePath.join(dir, rel);
    for (const name of NodeFS.readdirSync(full).toSorted()) {
      const path = NodePath.join(rel, name);
      const stat = NodeFS.statSync(NodePath.join(dir, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries.push(`${path}\n${fileHash(NodePath.join(dir, path))}`);
    }
  };
  walk("");
  return sha256(entries.join("\n"));
}

/** sha256 of a file read in chunks: model weights do not fit a single buffer comfortably. */
export function fileHash(path: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = NodeFS.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

export interface CorpusView {
  readonly cutoff: string;
  readonly dir: string;
  /** The view's own corpus_hash: its files and coverage rows, nothing at or after the cutoff. */
  readonly corpus_hash: string;
  readonly files: number;
  /** The last day the view holds coverage for; a shadow cutoff needs the day before it. */
  readonly last_covered_day: string | null;
}

const dayOf = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const day = (value as { day?: unknown }).day;
  return typeof day === "string" ? day.slice(0, 10) : null;
};

/**
 * Writes into `out` the view of `corpusDir` before `cutoff`: the listed day files of earlier
 * days, the coverage rows of earlier days and a corpus/1 manifest of exactly those, so the
 * engine's reader verifies it as any corpus. Files only, read-only once written.
 */
export function buildView(input: {
  readonly corpusDir: string;
  readonly cutoff: string;
  readonly out: string;
}): CorpusView {
  const untilDay = input.cutoff.slice(0, 10);
  const manifest = readManifest(input.corpusDir);
  NodeFS.rmSync(input.out, { recursive: true, force: true });
  NodeFS.mkdirSync(input.out, { recursive: true });
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const entry of manifest.files) {
    const match = DAY_FILE.exec(entry.path);
    if (match === null || match[2]! >= untilDay) continue;
    const bytes = listedBytes(input.corpusDir, entry);
    NodeFS.mkdirSync(NodePath.join(input.out, match[1]!), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(input.out, entry.path), bytes);
    files.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
  }
  const coverageEntry = manifest.files.find((entry) => entry.path === COVERAGE);
  const coverageText =
    coverageEntry === undefined ? "" : listedBytes(input.corpusDir, coverageEntry).toString("utf8");
  let lastCovered: string | null = null;
  const rows = coverageText.split("\n").filter((line) => {
    if (line.trim() === "") return false;
    const day = dayOf(JSON.parse(line));
    if (day === null || day >= untilDay) return false;
    if (lastCovered === null || day > lastCovered) lastCovered = day;
    return true;
  });
  const coverage = Buffer.from(rows.map((line) => `${line}\n`).join(""), "utf8");
  NodeFS.writeFileSync(NodePath.join(input.out, COVERAGE), coverage);
  files.push({ path: COVERAGE, sha256: sha256(coverage), bytes: coverage.length });
  const before = <T>(entries: ReadonlyArray<T> | undefined) =>
    entries?.filter((entry) => {
      const day = dayOf(entry);
      return day === null || day < untilDay;
    });
  const purges = before(manifest.purges);
  const robots = before(manifest.robots_overrides);
  const repairs = before(manifest.repairs);
  const fields = {
    schema_version: manifest.schema_version,
    from_day: manifest.from_day < untilDay ? manifest.from_day : untilDay,
    to_day: untilDay,
    selection_bias: manifest.selection_bias,
    // The original's planned end is a later date; the view ends at its cutoff.
    selection: Object.fromEntries(
      Object.entries(manifest.selection).map(([key, value]) => [
        key,
        key === "to_day" ? untilDay : value,
      ]),
    ),
    files: files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ...(purges === undefined ? {} : { purges }),
    ...(robots === undefined ? {} : { robots_overrides: robots }),
    ...(repairs === undefined ? {} : { repairs }),
  } as unknown as CorpusFields;
  const corpusHash = hashCorpus(fields);
  NodeFS.writeFileSync(
    NodePath.join(input.out, "corpus-manifest.json"),
    `${JSON.stringify({ ...fields, corpus_hash: corpusHash, written_at: input.cutoff }, null, 2)}\n`,
  );
  readOnly(input.out);
  return {
    cutoff: input.cutoff,
    dir: input.out,
    corpus_hash: corpusHash,
    files: files.length,
    last_covered_day: lastCovered,
  };
}

const readOnly = (path: string) => {
  const stat = NodeFS.lstatSync(path);
  if (stat.isDirectory()) {
    for (const name of NodeFS.readdirSync(path)) readOnly(NodePath.join(path, name));
  } else NodeFS.chmodSync(path, 0o444);
};
