// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - corpus/1 filesystem boundary.
// `engine repair-robots-override`: days collected under a robots.txt exception before the
// coverage row kept the exception's terms URL get it from the source descriptor. The repair
// is recorded in the manifest's `repairs`; the previous coverage.jsonl goes to history/.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { EarlywindowCorpusManifest } from "@earlyscript/editorial-contracts/earlywindow";
import { CoverageRecord, type SourceId } from "@earlyscript/editorial-contracts/source";

import { robotsOverridesOf } from "./collect.ts";
import { hashCorpus } from "./corpus.ts";
import { sha256 } from "./hash.ts";
import { readJsonLines } from "./sources/fixture.ts";
import { robotsOverrideNote, sourceDescriptor } from "./sources/index.ts";

const decodeManifest = Schema.decodeUnknownSync(EarlywindowCorpusManifest);
const decodeCoverage = Schema.decodeUnknownSync(CoverageRecord);

export interface RobotsOverrideRepair {
  readonly source: SourceId;
  readonly days: ReadonlyArray<string>;
  readonly corpus_hash_before: string;
  readonly corpus_hash_after: string;
}

export async function repairRobotsOverrideTerms(options: {
  readonly dir: string;
  readonly source: SourceId;
  readonly now?: () => string;
}): Promise<RobotsOverrideRepair> {
  const override = sourceDescriptor(options.source).robots_override;
  if (!override) throw new Error(`${options.source} has no robots.txt exception`);
  const root = NodePath.resolve(options.dir);
  const lockPath = NodePath.join(root, ".collect.lock");
  const lock = await NodeFSP.open(lockPath, "wx");
  try {
    const manifestPath = NodePath.join(root, "corpus-manifest.json");
    const manifest = decodeManifest(JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")));
    if (hashCorpus(manifest) !== manifest.corpus_hash) throw new Error("Invalid corpus hash");
    const coveragePath = NodePath.join(root, "coverage.jsonl");
    const old = await NodeFSP.readFile(coveragePath);
    const entry = manifest.files.find((file) => file.path === "coverage.jsonl");
    if (entry?.sha256 !== sha256(old) || entry.bytes !== old.length)
      throw new Error("coverage.jsonl does not match corpus-manifest.json");

    // Only the note the capture wrote, `robots_override: <reason>`, is rewritten.
    const captured = `robots_override: ${override.reason}`;
    const days: Array<string> = [];
    const rows = (await readJsonLines(coveragePath)).map((line) => {
      const row = decodeCoverage(line);
      const note = row.note ?? "";
      if (row.source !== options.source || row.robots_override || !note.startsWith(captured))
        return row;
      days.push(row.day);
      return {
        ...row,
        note: robotsOverrideNote(override) + note.slice(captured.length),
        robots_override: override,
      };
    });
    if (days.length === 0) {
      return {
        source: options.source,
        days,
        corpus_hash_before: manifest.corpus_hash,
        corpus_hash_after: manifest.corpus_hash,
      };
    }
    const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    const backup = `history/${sha256(old).slice(7)}.jsonl`;
    await NodeFSP.mkdir(NodePath.join(root, "history"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, backup), old);
    await NodeFSP.writeFile(`${coveragePath}.tmp`, text);
    await NodeFSP.rename(`${coveragePath}.tmp`, coveragePath);
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    files.set(backup, { path: backup, sha256: sha256(old), bytes: old.length });
    files.set("coverage.jsonl", {
      path: "coverage.jsonl",
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
    });
    const repairedAt = options.now?.() ?? new Date().toISOString();
    const next = {
      schema_version: manifest.schema_version,
      from_day: manifest.from_day,
      to_day: manifest.to_day,
      files: [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
      selection_bias: manifest.selection_bias,
      selection: manifest.selection,
      ...(manifest.purges ? { purges: manifest.purges } : {}),
      ...robotsOverridesOf(rows),
      repairs: [
        ...(manifest.repairs ?? []),
        {
          repaired_at: repairedAt,
          tool: "engine repair-robots-override",
          source: options.source,
          days,
          change: "terms_url added to robots_override notes from the source descriptor",
          reason:
            "the capture recorded only the exception's reason; this is a later repair, not part of the capture",
          coverage_before: backup,
        },
      ],
    };
    const after = hashCorpus(next);
    await NodeFSP.writeFile(
      `${manifestPath}.tmp`,
      `${JSON.stringify({ ...next, corpus_hash: after, written_at: repairedAt }, null, 2)}\n`,
    );
    await NodeFSP.rename(`${manifestPath}.tmp`, manifestPath);
    return {
      source: options.source,
      days,
      corpus_hash_before: manifest.corpus_hash,
      corpus_hash_after: after,
    };
  } finally {
    await lock.close();
    await NodeFSP.unlink(lockPath);
  }
}
