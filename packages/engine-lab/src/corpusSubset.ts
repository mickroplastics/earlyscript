// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - copies corpus files for the operator.
// A copy of some sources and days of a corpus/1, with its own manifest: a development corpus
// the lab may read and write without touching the original.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { hashCorpus } from "@earlyscript/trend-engine/corpus";

type CorpusFields = Parameters<typeof hashCorpus>[0];

import { sha256 } from "./hash.ts";

interface ManifestEntry {
  readonly source?: string;
}

export function subsetCorpus(input: {
  readonly from: string;
  readonly out: string;
  readonly sources: ReadonlyArray<string>;
  readonly fromDay: string;
  /** Exclusive, as corpus/1's `to_day`. */
  readonly toDay: string;
}) {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(input.from, "corpus-manifest.json"), "utf8"),
  );
  if (NodeFS.existsSync(input.out))
    throw new Error(`${input.out} exists; the copy never overwrites`);
  const inRange = (day: string) => day >= input.fromDay && day < input.toDay;
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const source of input.sources) {
    NodeFS.mkdirSync(NodePath.join(input.out, source), { recursive: true });
    for (const name of NodeFS.readdirSync(NodePath.join(input.from, source)).toSorted()) {
      const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (day === undefined || !inRange(day)) continue;
      const bytes = NodeFS.readFileSync(NodePath.join(input.from, source, name));
      NodeFS.writeFileSync(NodePath.join(input.out, source, name), bytes);
      files.push({ path: `${source}/${name}`, sha256: sha256(bytes), bytes: bytes.length });
    }
  }
  const coverage = NodeFS.readFileSync(NodePath.join(input.from, "coverage.jsonl"), "utf8")
    .split("\n")
    .filter((line) => {
      if (line.trim() === "") return false;
      const row = JSON.parse(line) as { source: string; day: string };
      return input.sources.includes(row.source) && inRange(row.day);
    });
  NodeFS.writeFileSync(
    NodePath.join(input.out, "coverage.jsonl"),
    coverage.map((line) => `${line}\n`).join(""),
  );
  const keep = (entries: ReadonlyArray<ManifestEntry> | undefined) =>
    (entries ?? []).filter(
      (entry) => entry.source === undefined || input.sources.includes(entry.source),
    );
  const fields = {
    schema_version: manifest.schema_version,
    from_day: input.fromDay,
    to_day: input.toDay,
    selection_bias: manifest.selection_bias,
    selection: Object.fromEntries(
      Object.entries(manifest.selection as Record<string, string>).filter(
        ([key]) => key === "to_day" || input.sources.includes(key),
      ),
    ),
    files: files.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    ...(manifest.purges === undefined ? {} : { purges: keep(manifest.purges) }),
    ...(manifest.robots_overrides === undefined
      ? {}
      : { robots_overrides: keep(manifest.robots_overrides) }),
    ...(manifest.repairs === undefined ? {} : { repairs: keep(manifest.repairs) }),
  } as unknown as CorpusFields;
  const written = {
    ...fields,
    corpus_hash: hashCorpus(fields),
    written_at: new Date().toISOString(),
    copied_from: { corpus_hash: manifest.corpus_hash },
  };
  NodeFS.writeFileSync(
    NodePath.join(input.out, "corpus-manifest.json"),
    `${JSON.stringify(written, null, 2)}\n`,
  );
  return {
    out: input.out,
    files: files.length,
    corpus_hash: written.corpus_hash,
    copied_from: manifest.corpus_hash,
  };
}
