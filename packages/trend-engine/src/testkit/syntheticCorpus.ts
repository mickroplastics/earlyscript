// @effect-diagnostics nodeBuiltinImport:off - test fixture writer.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Item } from "@earlyscript/editorial-contracts/item";
import type { ChannelProfile } from "@earlyscript/editorial-contracts/profile";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { CoverageRecord, SourceId } from "@earlyscript/editorial-contracts/source";

import { hashCorpus } from "../corpus.ts";
import { daysBetween } from "../days.ts";
import { sha256 } from "../hash.ts";
import { loadConfig, DEFAULT_CONFIG_PATH } from "../run.ts";

export const FROM_DAY = "2026-09-20";
export const TO_DAY = "2026-10-12";
export const CUTOFF = "2026-10-10T00:00:00.000Z";
export const FUTURE_WORD = "futuretoken";

const RETRIEVED = "2026-10-12T01:00:00.000Z";

export function item(
  source: SourceId,
  day: string,
  n: number,
  title: string,
  author: string,
  entities: Array<string> = [],
): Item {
  const id = `itm_${source}_${day.replaceAll("-", "")}${String(n).padStart(3, "0")}`;
  return {
    id,
    source,
    permalink: `https://example.test/${id}`,
    external_url: `https://example.test/out/${id}`,
    published_at: `${day}T${String(n % 24).padStart(2, "0")}:00:00.000Z`,
    author,
    title,
    body: "",
    body_length: 0,
    truncated: false,
    retrieved_at: RETRIEVED,
    entities,
  };
}

/**
 * HN: one topic grows in the 7 days before the cutoff, two stay steady. GitHub: a repo of
 * the growing topic on some days. Items after the cutoff carry FUTURE_WORD.
 */
export function syntheticItems(): Array<Item> {
  const items: Array<Item> = [];
  daysBetween(FROM_DAY, TO_DAY).forEach((day, d) => {
    const late = day >= "2026-10-03";
    const future = day >= CUTOFF.slice(0, 10);
    const growingCount = future ? 2 : late ? 3 : d % 3 === 0 ? 1 : 0;
    for (let k = 0; k < growingCount; k++) {
      const word = future ? ` ${FUTURE_WORD}` : "";
      items.push(
        item(
          "hn",
          day,
          1 + k,
          `Rust compiler agents ship incremental builds${word}`,
          `dev${d}_${k}`,
        ),
      );
    }
    items.push(item("hn", day, 10, "Tomato garden soil watering tips", `gardener${d % 4}`));
    items.push(item("hn", day, 11, "Football league scores weekend results", `fan${d % 3}`));
    if (late && d % 2 === 0) {
      items.push(
        item("github", day, 5, "rust compiler agents incremental", "rustorg", [
          `github:rustorg/agents${d}`,
        ]),
      );
    }
  });
  return items.toSorted(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
  );
}

export interface CorpusOptions {
  readonly items?: ReadonlyArray<Item>;
  readonly coverage?: (row: CoverageRecord) => CoverageRecord | null;
  /** Sources written besides github and hn; their days are `complete`. */
  readonly extraSources?: ReadonlyArray<SourceId>;
  /** The corpus span, FROM_DAY to TO_DAY (exclusive) by default. */
  readonly fromDay?: string;
  readonly toDay?: string;
}

export async function writeSyntheticCorpus(
  root: string,
  options: CorpusOptions = {},
): Promise<void> {
  const items = options.items ?? syntheticItems();
  const fromDay = options.fromDay ?? FROM_DAY;
  const toDay = options.toDay ?? TO_DAY;
  const rows: Array<CoverageRecord> = [];
  for (const source of ["github", "hn", ...(options.extraSources ?? [])] as const) {
    NodeFS.mkdirSync(NodePath.join(root, source), { recursive: true });
    for (const day of daysBetween(fromDay, toDay)) {
      const dayItems = items.filter((i) => i.source === source && i.published_at.startsWith(day));
      const defaults: CoverageRecord = {
        source,
        day,
        status: source === "github" ? "partial" : "complete",
        items: dayItems.length,
        retrieved_at: RETRIEVED,
        note: source === "github" ? "first 100 by stars" : null,
      };
      // A null row is a day never collected: no coverage line and no file.
      const row = options.coverage ? options.coverage(defaults) : defaults;
      if (!row) continue;
      rows.push(row);
      const lines = row.items === 0 ? [] : dayItems;
      NodeFS.writeFileSync(
        NodePath.join(root, source, `${day}.jsonl`),
        lines.map((i) => `${JSON.stringify(i)}\n`).join(""),
      );
    }
  }
  NodeFS.writeFileSync(
    NodePath.join(root, "coverage.jsonl"),
    rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
  );
  const fields = {
    schema_version: "corpus/1" as const,
    from_day: fromDay,
    to_day: toDay,
    selection_bias: "present_stars" as const,
    selection: { hn: "all stories", github: "first 100 by stars", to_day: "exclusive" },
  };
  const files = listFiles(root).map((path) => {
    const bytes = NodeFS.readFileSync(NodePath.join(root, path));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
  const manifest = {
    ...fields,
    files,
    corpus_hash: hashCorpus({ ...fields, files }),
    written_at: RETRIEVED,
  };
  NodeFS.writeFileSync(
    NodePath.join(root, "corpus-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function listFiles(root: string, prefix = ""): Array<string> {
  return NodeFS.readdirSync(NodePath.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(root, relative) : [relative];
    })
    .toSorted();
}

export const tempDir = (prefix: string) =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `${prefix}-`));

export const PROFILE: ChannelProfile = {
  schema_version: "profile/1",
  name: "Test channel",
  version: 1,
  audience: "developers",
  include: ["rust compiler agents incremental builds", "developer tooling"],
  exclude: ["football league scores"],
};

export function writeProfile(dir: string): string {
  const path = NodePath.join(dir, "profile.json");
  NodeFS.writeFileSync(path, JSON.stringify(PROFILE));
  return path;
}

/** The shipped configuration with thresholds the fingerprint embedder can reach. */
export function testConfig(overrides: Partial<EngineConfig["stage"]> = {}): EngineConfig {
  const { config } = loadConfig(DEFAULT_CONFIG_PATH);
  return {
    ...config,
    profile: { include_min: 0.3, exclude_max: 0.6 },
    stage: { ...config.stage, ...overrides },
  };
}
