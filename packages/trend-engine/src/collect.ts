// @effect-diagnostics globalDate:off nodeBuiltinImport:off - plain async library with native fetch and UTC timestamps.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - corpus/1 filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { EarlywindowCorpusManifest } from "@earlyscript/editorial-contracts/earlywindow";
import { CoverageRecord } from "@earlyscript/editorial-contracts/source";
import { Item } from "@earlyscript/editorial-contracts/item";
import { hashCorpus } from "./corpus.ts";
import { daysBetween } from "./days.ts";
import { sha256 } from "./hash.ts";
import { readJsonLines } from "./sources/fixture.ts";
import type { SourceAdapter } from "./sources/adapter.ts";

const decodeManifest = Schema.decodeUnknownSync(EarlywindowCorpusManifest);
const decodeCoverage = Schema.decodeUnknownSync(CoverageRecord);
const decodeItem = Schema.decodeUnknownSync(Item);
const decodeTypedItem = Schema.decodeSync(Item);

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const jsonl = (rows: ReadonlyArray<unknown>) =>
  rows.map((row) => JSON.stringify(row) + "\n").join("");

export async function collectCorpus(options: {
  readonly dir: string;
  readonly from: string;
  /** Exclusive, as in corpus/1. */
  readonly to: string;
  readonly adapters: ReadonlyArray<SourceAdapter>;
  readonly force?: boolean;
}) {
  const days = daysBetween(options.from, options.to);
  if (!days.length || !options.adapters.length)
    throw new Error("Expected sources and from < to (exclusive)");
  const root = NodePath.resolve(options.dir);
  await NodeFSP.mkdir(root, { recursive: true });
  const lockPath = NodePath.join(root, ".collect.lock");
  const lock = await NodeFSP.open(lockPath, "wx");
  try {
    let previous: EarlywindowCorpusManifest | undefined;
    try {
      previous = decodeManifest(
        JSON.parse(await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8")),
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const files = new Map(previous?.files.map((file) => [file.path, file]));
    if (previous && hashCorpus(previous) !== previous.corpus_hash)
      throw new Error("Invalid existing corpus hash");
    for (const file of files.values()) {
      const bytes = await NodeFSP.readFile(NodePath.join(root, file.path));
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes)
        throw new Error(`Existing corpus mismatch: ${file.path}`);
    }
    let coverage: Array<CoverageRecord> = [];
    try {
      coverage = (await readJsonLines(NodePath.join(root, "coverage.jsonl"))).map((row) =>
        decodeCoverage(row),
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const index = new Map(coverage.map((row) => [`${row.source}/${row.day}`, row]));
    async function write(path: string, text: string) {
      const file = NodePath.join(root, path);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      try {
        const old = await NodeFSP.readFile(file);
        if (!old.equals(Buffer.from(text))) {
          const backup = `history/${sha256(old).slice(7)}.jsonl`;
          await NodeFSP.mkdir(NodePath.join(root, "history"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(root, backup), old);
          files.set(backup, { path: backup, sha256: sha256(old), bytes: old.length });
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await NodeFSP.writeFile(`${file}.tmp`, text);
      await NodeFSP.rename(`${file}.tmp`, file);
      files.set(path, { path, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    }
    const results: Array<CoverageRecord> = [];
    for (const adapter of options.adapters) {
      for (const day of days) {
        const key = `${adapter.descriptor.id}/${day}`;
        const existing = index.get(key);
        if (!options.force && existing?.status === "complete") {
          results.push(existing);
          continue;
        }
        const result = await adapter.collectDay(day);
        const path = `${key}.jsonl`;
        let old: Array<Item> = [];
        try {
          old = (await readJsonLines(NodePath.join(root, path))).map((row) => decodeItem(row));
        } catch (error) {
          if (!missing(error)) throw error;
        }
        const merged = new Map(old.map((item) => [item.id, item]));
        for (const raw of result.items) {
          const item = decodeTypedItem(raw);
          if (item.source !== adapter.descriptor.id || !item.published_at.startsWith(`${day}T`))
            throw new Error("Invalid source day");
          merged.set(item.id, item);
        }
        const items = [...merged.values()].toSorted(
          (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
        );
        const row = decodeCoverage({
          ...result.coverage,
          items: items.length,
          status:
            items.length && result.coverage?.status === "unavailable"
              ? "partial"
              : result.coverage?.status,
        });
        await write(path, jsonl(items));
        index.set(key, row);
        results.push(row);
      }
    }
    coverage = [...index.values()].toSorted(
      (a, b) => a.source.localeCompare(b.source) || a.day.localeCompare(b.day),
    );
    await write("coverage.jsonl", jsonl(coverage));
    const manifest = {
      schema_version: "corpus/1" as const,
      from_day: [previous?.from_day ?? options.from, options.from].toSorted()[0]!,
      to_day: [previous?.to_day ?? options.to, options.to].toSorted().at(-1)!,
      files: [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
      selection_bias: "present_stars" as const,
      selection: {
        ...previous?.selection,
        ...Object.assign({}, ...options.adapters.map((adapter) => adapter.descriptor.selection)),
        to_day: "exclusive",
      },
      ...(previous?.purges ? { purges: previous.purges } : {}),
    };
    await NodeFSP.writeFile(
      NodePath.join(root, "corpus-manifest.json.tmp"),
      JSON.stringify(
        { ...manifest, corpus_hash: hashCorpus(manifest), written_at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
    await NodeFSP.rename(
      NodePath.join(root, "corpus-manifest.json.tmp"),
      NodePath.join(root, "corpus-manifest.json"),
    );
    return results;
  } finally {
    await lock.close();
    await NodeFSP.unlink(lockPath);
  }
}
