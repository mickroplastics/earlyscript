// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - tests lay out corpus/1 directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { hashCorpus, readCorpus } from "./corpus.ts";
import { CORPUS_IMPORT_TOOL, importCorpus } from "./corpus-import.ts";
import { sha256 } from "./hash.ts";
import { fixtureSources } from "./sources/index.ts";
import { syntheticItems, tempDir, writeSyntheticCorpus } from "./testkit/syntheticCorpus.ts";

const LIVE_FROM = "2026-10-05";
const TO = "2026-10-12";
const NOW = "2026-11-09T05:00:00.000Z";

/** A long corpus (eval-largo) and a live one that starts later, with the same days after that. */
async function corpora() {
  const root = tempDir("corpus-import");
  const from = NodePath.join(root, "eval-largo", "corpus");
  const to = NodePath.join(root, "live");
  await writeSyntheticCorpus(from, { toDay: TO });
  await writeSyntheticCorpus(to, {
    fromDay: LIVE_FROM,
    toDay: TO,
    items: syntheticItems().filter((item) => item.published_at.slice(0, 10) >= LIVE_FROM),
  });
  return { root, from, to };
}

/** Every file under `dir` with its bytes, to show that nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out[path] = sha256(NodeFS.readFileSync(NodePath.join(dir, path)));
    }
  };
  walk("");
  return out;
}

const read = (dir: string) =>
  readCorpus({ dir, adapters: fixtureSources(dir, ["hn", "github"]), untilDay: TO });

const manifestOf = (dir: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "corpus-manifest.json"), "utf8"));

describe("engine corpus import", () => {
  it("copies only the days before the live corpus's first day, verified, and the result reads as the long corpus", async () => {
    const { root, from, to } = await corpora();
    const before = snapshot(to);
    // A dry run checks everything and writes nothing.
    const dry = await importCorpus({
      from: NodePath.dirname(from),
      to,
      dryRun: true,
      now: () => NOW,
    });
    expect(dry.dry_run).toBe(true);
    expect(dry.record_path).toBeNull();
    expect(snapshot(to)).toEqual(before);
    expect(dry.days).toEqual({ from: "2026-09-20", to_exclusive: LIVE_FROM });
    expect(dry.files.every((f) => f.path.slice(-16, -6) < LIVE_FROM)).toBe(true);
    expect(dry.files.length).toBe(2 * 15);

    const record = await importCorpus({ from: NodePath.dirname(from), to, now: () => NOW });
    expect(record.files.every((f) => f.status === "copied")).toBe(true);
    expect(record.to.from_day_before).toBe(LIVE_FROM);
    expect(record.to.from_day_after).toBe("2026-09-20");
    // Every byte that was there before is still there, except the two rewritten files.
    for (const [path, hash] of Object.entries(before)) {
      if (path === "coverage.jsonl" || path === "corpus-manifest.json") continue;
      expect(sha256(NodeFS.readFileSync(NodePath.join(to, path))), path).toBe(hash);
    }
    // The former coverage.jsonl is kept in history/, as a capture keeps it.
    expect(
      NodeFS.existsSync(NodePath.join(to, `history/${before["coverage.jsonl"]!.slice(7)}.jsonl`)),
    ).toBe(true);
    // The live corpus verifies and reads exactly as the long one over the same days.
    const live = await read(to);
    const long = await read(from);
    expect(live.verified).toBe(true);
    expect(live.items.map((i) => i.id)).toEqual(long.items.map((i) => i.id));
    expect(live.usedHash).toBe(long.usedHash);
    expect(live.coverage).toEqual(long.coverage);
    // The record: a file named in the manifest's repairs, with each copied file and its hash.
    const manifest = manifestOf(to);
    expect(hashCorpus(manifest)).toBe(manifest.corpus_hash);
    expect(manifest.corpus_hash).toBe(record.to.corpus_hash_after);
    const repair = manifest.repairs.at(-1);
    expect(repair).toMatchObject({
      tool: CORPUS_IMPORT_TOOL,
      from_corpus_hash: record.from.corpus_hash,
    });
    const saved = JSON.parse(NodeFS.readFileSync(NodePath.join(to, repair.record), "utf8"));
    expect(saved.files).toEqual(record.files);
    expect(record.record_path).toBe(NodePath.join(to, repair.record));

    // Idempotent: again, nothing is copied and nothing changes.
    const after = snapshot(to);
    const again = await importCorpus({ from, to, now: () => "2026-11-10T05:00:00.000Z" });
    expect(again.files).toEqual([]);
    expect(snapshot(to)).toEqual(after);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("resumes an interrupted import: an identical file already there counts as copied", async () => {
    const { root, from, to } = await corpora();
    NodeFS.mkdirSync(NodePath.join(to, "hn"), { recursive: true });
    NodeFS.copyFileSync(
      NodePath.join(from, "hn/2026-10-01.jsonl"),
      NodePath.join(to, "hn/2026-10-01.jsonl"),
    );
    const record = await importCorpus({ from, to, now: () => NOW });
    expect(record.files.find((f) => f.path === "hn/2026-10-01.jsonl")?.status).toBe("present");
    expect((await read(to)).verified).toBe(true);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("never overwrites, never copies a file that differs from its manifest, and changes nothing then", async () => {
    const { root, from, to } = await corpora();
    const before = snapshot(to);
    // A file not in the live manifest, with other bytes, where an imported day would go.
    NodeFS.mkdirSync(NodePath.join(to, "hn"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(to, "hn/2026-10-02.jsonl"), "");
    await expect(importCorpus({ from, to, now: () => NOW })).rejects.toThrow(/not replaced/);
    NodeFS.rmSync(NodePath.join(to, "hn/2026-10-02.jsonl"));
    expect(snapshot(to)).toEqual(before);

    // A source file changed after its manifest was written.
    const tampered = NodePath.join(from, "github/2026-09-25.jsonl");
    NodeFS.appendFileSync(tampered, "\n");
    await expect(importCorpus({ from, to, now: () => NOW })).rejects.toThrow(
      /does not match its manifest entry/,
    );
    expect(snapshot(to)).toEqual(before);
    expect(NodeFS.existsSync(NodePath.join(to, ".collect.lock"))).toBe(false);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("refuses items the live corpus purged", async () => {
    const { root, from, to } = await corpora();
    const victim = syntheticItems().find((i) => i.source === "hn" && i.published_at < LIVE_FROM)!;
    const manifest = manifestOf(to);
    const { corpus_hash: _hash, written_at: _at, ...fields } = manifest;
    const purged = {
      ...fields,
      purges: [
        {
          purged_at: NOW,
          source: "hn",
          match: "uri",
          value_sha256: sha256(String(victim.permalink)),
          items_removed: 0,
          files_rewritten: 0,
        },
      ],
    };
    NodeFS.writeFileSync(
      NodePath.join(to, "corpus-manifest.json"),
      JSON.stringify({ ...purged, corpus_hash: hashCorpus(purged), written_at: NOW }),
    );
    const before = snapshot(to);
    await expect(importCorpus({ from, to, now: () => NOW })).rejects.toThrow(/purged/);
    expect(snapshot(to)).toEqual(before);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});
