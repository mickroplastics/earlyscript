// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - tests lay out corpus/1 directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { hashCorpus, readCorpus } from "./corpus.ts";
import { CORPUS_IMPORT_TOOL, formatImportTable, importCorpus } from "./corpus-import.ts";
import { sha256 } from "./hash.ts";
import { GERTRUDIS, writeGertrudisCase } from "./testkit/corpusImportCase.ts";
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
    expect(dry.files.every((f) => f.path.slice(-16, -6) < LIVE_FROM)).toBe(true);
    expect(dry.files.length).toBe(2 * 15);
    expect(dry.by_source.map((s) => [s.source, s.imported, s.first_after, s.gaps_after])).toEqual([
      ["github", 15, "2026-09-20", 0],
      ["hn", 15, "2026-09-20", 0],
    ]);
    // A real import needs a backup.
    await expect(importCorpus({ from, to, now: () => NOW })).rejects.toThrow(/--backup/);
    expect(snapshot(to)).toEqual(before);

    const backup = NodePath.join(root, "backup");
    const record = await importCorpus({ from: NodePath.dirname(from), to, backup, now: () => NOW });
    // The backup is the live corpus as it was, every byte.
    expect(snapshot(backup)).toEqual(before);
    expect(record.backup).toEqual({ dir: backup, files: manifestOf(backup).files.length });
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
    const again = await importCorpus({
      from,
      to,
      backup: NodePath.join(root, "backup-2"),
      now: () => "2026-11-10T05:00:00.000Z",
    });
    expect(again.files).toEqual([]);
    expect(again.backup).toBeNull();
    expect(NodeFS.existsSync(NodePath.join(root, "backup-2"))).toBe(false);
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
    const record = await importCorpus({ from, to, backup: `${to}.bak`, now: () => NOW });
    expect(record.files.find((f) => f.path === "hn/2026-10-01.jsonl")?.status).toBe("present");
    expect((await read(to)).verified).toBe(true);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("never overwrites a file with content, never copies a file that differs from its manifest", async () => {
    const { root, from, to } = await corpora();
    // A file not in the live manifest, with other content, where an imported day would go.
    NodeFS.mkdirSync(NodePath.join(to, "hn"), { recursive: true });
    const stray = NodePath.join(to, "hn/2026-10-02.jsonl");
    NodeFS.writeFileSync(stray, "kept\n");
    const before = snapshot(to);

    // A source file changed after its manifest was written: nothing is written, not even a backup.
    const tampered = NodePath.join(from, "github/2026-09-25.jsonl");
    const original = NodeFS.readFileSync(tampered);
    NodeFS.appendFileSync(tampered, "\n");
    const backup = NodePath.join(root, "backup");
    await expect(importCorpus({ from, to, backup, now: () => NOW })).rejects.toThrow(
      /does not match its manifest entry/,
    );
    expect(snapshot(to)).toEqual(before);
    expect(NodeFS.existsSync(backup)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(to, ".collect.lock"))).toBe(false);
    NodeFS.writeFileSync(tampered, original);

    // A backup directory that exists already is refused before anything is written.
    NodeFS.mkdirSync(backup);
    await expect(importCorpus({ from, to, backup, now: () => NOW })).rejects.toThrow(
      /already exists/,
    );
    expect(snapshot(to)).toEqual(before);
    NodeFS.rmdirSync(backup);

    // The stray file stays as it was and its day is reported; every other day is imported.
    const record = await importCorpus({ from, to, backup, now: () => NOW });
    expect(NodeFS.readFileSync(stray, "utf8")).toBe("kept\n");
    expect(record.skipped).toEqual([
      {
        path: "hn/2026-10-02.jsonl",
        reason: "exists in the live corpus with other content; not replaced",
      },
    ]);
    expect(record.files.length).toBe(2 * 15 - 1);
    const hn = record.by_source.find((s) => s.source === "hn")!;
    expect([hn.imported, hn.gaps_after, hn.skipped]).toEqual([14, 1, 1]);
    expect(
      manifestOf(to).files.some((f: { path: string }) => f.path === "hn/2026-10-02.jsonl"),
    ).toBe(false);
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
    await expect(
      importCorpus({ from, to, backup: NodePath.join(root, "backup"), now: () => NOW }),
    ).rejects.toThrow(/purged/);
    expect(snapshot(to)).toEqual(before);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("fills each source from its own first day: the Gertrudis case (9 Nov 2026)", async () => {
    const root = tempDir("corpus-import-gertrudis");
    const { from, to } = await writeGertrudisCase(root);
    const before = snapshot(to);
    const dry = await importCorpus({
      from: NodePath.dirname(from),
      to,
      dryRun: true,
      now: () => NOW,
    });
    expect(snapshot(to)).toEqual(before);
    const row = (id: string) => {
      const s = dry.by_source.find((x) => x.source === id)!;
      return [
        s.days_before,
        s.first_before,
        s.imported,
        s.days_after,
        s.first_after,
        s.last_after,
        s.gaps_after,
      ];
    };
    // hn and github: the days before 3 Oct, as before.
    expect(row("hn")).toEqual([36, "2026-10-03", 34, 70, "2026-08-30", "2026-11-07", 0]);
    expect(row("github")).toEqual([36, "2026-10-03", 34, 70, "2026-08-30", "2026-11-07", 0]);
    // The sources enabled on 3 Nov get 30 Aug to 31 Oct, not only the days before 3 Oct; 1 and
    // 2 Nov stay a gap because the long corpus ends on 31 Oct.
    for (const id of ["huggingface", "npm", "wikipedia"]) {
      expect(row(id), id).toEqual([5, "2026-11-03", 63, 68, "2026-08-30", "2026-11-07", 2]);
    }
    expect(row("rss")).toEqual([5, "2026-11-03", 29, 34, "2026-10-03", "2026-11-07", 2]);
    // arxiv has nothing in the long corpus: every uncovered day is skipped, nothing imported.
    expect(row("arxiv")).toEqual([5, "2026-11-03", 0, 5, "2026-11-03", "2026-11-07", 0]);
    expect(dry.to.from_day_after).toBe(GERTRUDIS.sourceFrom);
    expect(dry.files.length).toBe(2 * 34 + 3 * 63 + 29);
    expect(formatImportTable(dry)).toContain(
      "| huggingface | 5 (2026-11-03 … 2026-11-07) | 0 | 63 |",
    );

    const backup = NodePath.join(root, "live.bak");
    const record = await importCorpus({ from, to, backup, now: () => NOW });
    expect(record.by_source).toEqual(dry.by_source);
    expect(record.files.every((f) => f.status === "copied" && f.replaces === null)).toBe(true);
    expect(snapshot(backup)).toEqual(before);
    // Every imported file is the source's, byte for byte, and listed in the live manifest.
    const manifest = manifestOf(to);
    expect(hashCorpus(manifest)).toBe(manifest.corpus_hash);
    const listed = new Map(
      manifest.files.map((f: { path: string; sha256: string }) => [f.path, f.sha256]),
    );
    for (const file of record.files) {
      expect(sha256(NodeFS.readFileSync(NodePath.join(to, file.path))), file.path).toBe(
        file.sha256,
      );
      expect(listed.get(file.path)).toBe(file.sha256);
    }
    // Each imported row is in coverage.jsonl as the source has it, and in repairs with imported_from.
    const coverage = NodeFS.readFileSync(NodePath.join(to, "coverage.jsonl"), "utf8");
    const sourceCoverage = NodeFS.readFileSync(NodePath.join(from, "coverage.jsonl"), "utf8");
    const sourceLines = new Set(sourceCoverage.split("\n"));
    const huggingface = coverage.split("\n").filter((l) => l.includes('"source":"huggingface"'));
    expect(huggingface.length).toBe(68);
    expect(huggingface.slice(0, 63).every((l) => sourceLines.has(l))).toBe(true);
    const repair = manifest.repairs.at(-1);
    expect(repair.rows.length).toBe(record.files.length);
    expect(repair.rows[0]).toMatchObject({ imported_from: record.from.corpus_hash });
    expect(repair.backup).toBe(backup);
    // It reads, verified, with no duplicate ids, over every source.
    const ids = ["hn", "github", "huggingface", "npm", "wikipedia", "rss", "arxiv"] as const;
    const live = await readCorpus({
      dir: to,
      adapters: fixtureSources(to, [...ids]),
      untilDay: GERTRUDIS.liveTo,
    });
    expect(live.verified).toBe(true);
    expect(live.coverage.length).toBe(70 * 2 + 68 * 3 + 34 + 5);

    // Idempotent: nothing more to copy, nothing changes, no new backup.
    const after = snapshot(to);
    const again = await importCorpus({ from, to, backup: `${backup}-2`, now: () => NOW });
    expect(again.files).toEqual([]);
    expect(again.by_source.map((s) => s.gaps_after)).toEqual(
      record.by_source.map((s) => s.gaps_after),
    );
    expect(snapshot(to)).toEqual(after);
    expect(NodeFS.existsSync(`${backup}-2`)).toBe(false);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("fills a gap inside a source's span, and an unavailable day with an empty file", async () => {
    const root = tempDir("corpus-import-gap");
    const from = NodePath.join(root, "eval-largo", "corpus");
    const to = NodePath.join(root, "live");
    await writeSyntheticCorpus(from, { toDay: TO });
    await writeSyntheticCorpus(to, {
      fromDay: LIVE_FROM,
      toDay: TO,
      items: syntheticItems().filter((i) => i.published_at.slice(0, 10) >= LIVE_FROM),
      coverage: (row) => {
        if (row.source === "hn" && (row.day === "2026-10-08" || row.day === "2026-10-09"))
          return null;
        if (row.source === "github" && row.day === "2026-10-06") {
          return { ...row, status: "unavailable", items: 0, note: "fetch failed" };
        }
        return row;
      },
    });
    expect(NodeFS.statSync(NodePath.join(to, "github/2026-10-06.jsonl")).size).toBe(0);
    const record = await importCorpus({
      from,
      to,
      backup: NodePath.join(root, "bak"),
      now: () => NOW,
    });
    const hn = record.by_source.find((s) => s.source === "hn")!;
    const github = record.by_source.find((s) => s.source === "github")!;
    expect([hn.gaps_before, hn.imported, hn.gaps_after]).toEqual([2, 15 + 2, 0]);
    expect([github.gaps_before, github.imported, github.gaps_after]).toEqual([1, 15 + 1, 0]);
    expect(record.files.find((f) => f.path === "github/2026-10-06.jsonl")).toMatchObject({
      status: "filled",
      replaces: "unavailable",
    });
    expect(record.files.find((f) => f.path === "hn/2026-10-08.jsonl")?.status).toBe("copied");
    // The live corpus now reads exactly as the long one: same items, coverage and usedHash.
    const live = await read(to);
    const long = await read(from);
    expect(live.verified).toBe(true);
    expect(live.items.map((i) => i.id)).toEqual(long.items.map((i) => i.id));
    expect(live.coverage).toEqual(long.coverage);
    expect(live.usedHash).toBe(long.usedHash);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});
