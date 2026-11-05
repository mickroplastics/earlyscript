// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over the corpus and the ledger.
// `engine eval-editorial capture`: the prospective capture of protocol P1.1 (rule 7). Captures
// one closed UTC day into the prospective corpus, freezes a hard-linked snapshot of it (collect
// replaces files by rename, so later captures never change a snapshot), and appends to the
// ledger the corpus hash, the snapshot and the closing time, which is the operational cutoff of
// the next day's cutoff. Nothing ranks or labels here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { collectCorpus } from "./collect.ts";
import { DAY_MS, dayOf, dayStart } from "./days.ts";
import { appendLedger, captureEntries, readLedger } from "./editorial-eval.ts";
import { sha256 } from "./hash.ts";
import type { SourceAdapter } from "./sources/index.ts";

/** Wikipedia publishes a day's top list hours after it closes: retried once the next day. */
export const LATE_RETRY_SOURCES: ReadonlyArray<SourceId> = ["wikipedia"];

const SKIP = new Set([".collect.lock", "http-log"]);

/** Hard-links every file of `from` (except locks and HTTP logs) into the new directory `to`. */
export function linkSnapshot(from: string, to: string) {
  if (NodeFS.existsSync(to)) throw new Error(`snapshot ${to} already exists`);
  const walk = (rel: string) => {
    NodeFS.mkdirSync(NodePath.join(to, rel), { recursive: true });
    for (const entry of NodeFS.readdirSync(NodePath.join(from, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = NodePath.join(rel, entry.name);
      if (entry.isDirectory()) walk(path);
      else NodeFS.linkSync(NodePath.join(from, path), NodePath.join(to, path));
    }
  };
  walk("");
}

export interface CaptureOptions {
  readonly corpusDir: string;
  readonly ledgerPath: string;
  readonly snapshotsDir: string;
  readonly sources: ReadonlyArray<SourceId>;
  readonly adapters: (ids: ReadonlyArray<SourceId>) => Array<SourceAdapter>;
  /** The closed UTC day to capture; yesterday by default. */
  readonly day?: string;
  readonly firstDay?: string;
  readonly lastDay?: string;
  /** Copies this corpus to `corpusDir` when it does not exist yet. */
  readonly seedFrom?: string;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export async function captureDay(options: CaptureOptions) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const day = options.day ?? dayOf(dayStart(dayOf(now().getTime())) - DAY_MS);
  dayStart(day);
  if ((options.firstDay && day < options.firstDay) || (options.lastDay && day > options.lastDay)) {
    log(
      `capture: ${day} is outside ${options.firstDay ?? "…"}..${options.lastDay ?? "…"}, skipped`,
    );
    return { skipped: true as const, day };
  }
  if (now().getTime() < dayStart(day) + DAY_MS) throw new Error(`day ${day} has not closed yet`);
  const cutoffDay = dayOf(dayStart(day) + DAY_MS);
  if (captureEntries(readLedger(options.ledgerPath)).some((e) => e.cutoff_day === cutoffDay)) {
    log(`capture: ${day} is already in the ledger, skipped`);
    return { skipped: true as const, day };
  }
  let seed: { from: string; corpus_hash: string } | null = null;
  if (!NodeFS.existsSync(options.corpusDir)) {
    if (!options.seedFrom)
      throw new Error(`${options.corpusDir} does not exist and there is no --seed-from`);
    if (NodeFS.existsSync(NodePath.join(options.seedFrom, ".collect.lock"))) {
      throw new Error(`${options.seedFrom} is being written (collect lock present)`);
    }
    NodeFS.cpSync(options.seedFrom, options.corpusDir, {
      recursive: true,
      filter: (src) => !SKIP.has(NodePath.basename(src)),
    });
    seed = {
      from: NodePath.resolve(options.seedFrom),
      corpus_hash: (
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(options.corpusDir, "corpus-manifest.json"), "utf8"),
        ) as { corpus_hash: string }
      ).corpus_hash,
    };
    log(`capture: seeded ${options.corpusDir} from ${options.seedFrom}`);
  }
  const startedAt = now().toISOString();
  const nextDay = cutoffDay;
  const rows = await collectCorpus({
    dir: options.corpusDir,
    from: day,
    to: nextDay,
    adapters: options.adapters(options.sources),
  });
  // A late source's previous day, only when it was unavailable: append-only, never a refresh.
  const previous = dayOf(dayStart(day) - DAY_MS);
  const coverageText = NodeFS.readFileSync(
    NodePath.join(options.corpusDir, "coverage.jsonl"),
    "utf8",
  );
  const unavailable = new Set(
    coverageText
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { source: string; day: string; status: string })
      .filter((r) => r.day === previous && r.status === "unavailable")
      .map((r) => r.source),
  );
  const late = options.sources.filter((s) => LATE_RETRY_SOURCES.includes(s) && unavailable.has(s));
  const retried =
    late.length > 0
      ? await collectCorpus({
          dir: options.corpusDir,
          from: previous,
          to: day,
          adapters: options.adapters(late),
        })
      : [];
  const closedAt = now().toISOString();
  const snapshotDir = NodePath.resolve(options.snapshotsDir, cutoffDay);
  linkSnapshot(options.corpusDir, snapshotDir);
  const manifestBytes = NodeFS.readFileSync(NodePath.join(snapshotDir, "corpus-manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { corpus_hash: string };
  const entry = appendLedger(options.ledgerPath, {
    kind: "capture",
    day,
    cutoff_day: cutoffDay,
    nominal_cutoff_at: `${cutoffDay}T00:00:00.000Z`,
    started_at: startedAt,
    closed_at: closedAt,
    operational_cutoff_note: "the operational cutoff of cutoff_day is closed_at (P1.1 rule 7)",
    sources: options.sources,
    coverage: rows,
    late_retry: retried,
    corpus_dir: NodePath.resolve(options.corpusDir),
    corpus_hash: manifest.corpus_hash,
    manifest_sha256: sha256(manifestBytes),
    snapshot_dir: snapshotDir,
    ...(seed ? { seeded_from: seed } : {}),
  });
  log(`capture: ${day} closed at ${closedAt}, corpus ${manifest.corpus_hash}`);
  return { skipped: false as const, day, entry };
}
