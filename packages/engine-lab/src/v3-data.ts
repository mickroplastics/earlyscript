// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - offline reader of the October corpus and of A's outputs.
// Every file v3's evaluation reads goes through `readGuarded`: development uses data up to 31
// October 2026 only, so a path naming a November day is refused before it is opened. The corpus
// reader lists each source folder and opens only the day files up to 31 October.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Last day of development data (contract v4.2): nothing of November is read. */
export const V3_LAST_DATA_DAY = "2026-10-31";
/** First day of the corpus (history start of every topic). */
export const V3_HISTORY_START = "2026-08-30";

export const DAY_MS = 86_400_000;
export const dayStart = (day: string) => Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`);
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const plusDays = (day: string, n: number) => dayOf(dayStart(day) + n * DAY_MS);
export const inclusiveDays = (from: string, to: string) => {
  const out: Array<string> = [];
  for (let d = from; d <= to; d = plusDays(d, 1)) out.push(d);
  return out;
};

export class NovemberReadError extends Error {
  readonly code = "november-read";
}

const DATED = /(\d{4})-(\d{2})-(\d{2})/g;

/** Whether a path names a day after 31 October 2026 (any `YYYY-MM-DD` in it). */
export function namesLateDay(path: string): boolean {
  for (const m of path.matchAll(DATED)) {
    if (`${m[1]}-${m[2]}-${m[3]}` > V3_LAST_DATA_DAY) return true;
  }
  return /2026-11-/.test(path);
}

/** The reads v3 made in this process (tests check that none names November). */
export const readLog: Array<string> = [];

export function readGuarded(path: string): string {
  if (namesLateDay(path)) {
    throw new NovemberReadError(`${path}: development reads nothing after ${V3_LAST_DATA_DAY}.`);
  }
  readLog.push(path);
  return NodeFS.readFileSync(path, "utf8");
}

export const readJsonGuarded = <T>(path: string): T => JSON.parse(readGuarded(path)) as T;

/** The sources v3 reads from the corpus: those that cluster (contract §2.4); Wikipedia never. */
export const V3_CLUSTER_SOURCES = ["hn", "github", "huggingface", "npm", "rss"] as const;

export interface CorpusItem {
  readonly id: string;
  readonly source: string;
  readonly published_at: string;
  readonly external_url?: string | null;
  readonly permalink?: string | null;
  readonly author?: string | null;
  readonly entities?: ReadonlyArray<string> | null;
}

/** Day files of a source folder up to 31 October, sorted; later names are never opened. */
export function dayFiles(dir: string): Array<string> {
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .filter((name) => name.slice(0, 10) <= V3_LAST_DATA_DAY)
    .toSorted()
    .map((name) => NodePath.join(dir, name));
}

/** The corpus items of the clustering sources, published before 1 November. */
export function readCorpusItems(
  corpusDir: string,
  sources: ReadonlyArray<string> = V3_CLUSTER_SOURCES,
): Array<CorpusItem> {
  const limit = dayStart(V3_LAST_DATA_DAY) + DAY_MS;
  const out: Array<CorpusItem> = [];
  for (const source of sources) {
    if (source === "wikipedia") continue;
    for (const file of dayFiles(NodePath.join(corpusDir, source))) {
      for (const line of readGuarded(file).split("\n")) {
        if (!line) continue;
        const item = JSON.parse(line) as CorpusItem;
        if (Date.parse(item.published_at) < limit) out.push(item);
      }
    }
  }
  return out;
}

export type CoverageStatus = "complete" | "partial" | "unavailable" | string;
export type CoverageIndex = Map<string, Map<string, CoverageStatus>>;

/** coverage.jsonl rows up to 31 October (later rows are dropped as they are read). */
export function readCoverage(path: string): CoverageIndex {
  const index: CoverageIndex = new Map();
  for (const line of readGuarded(path).split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { source: string; day: string; status: string };
    if (row.day > V3_LAST_DATA_DAY) continue;
    let bySource = index.get(row.source);
    if (!bySource) index.set(row.source, (bySource = new Map()));
    bySource.set(row.day, row.status);
  }
  return index;
}

/** A topic of A's clustering at a cutoff: its members published before the cutoff. */
export interface V3Topic {
  readonly topic_id: string;
  readonly item_ids: ReadonlyArray<string>;
  readonly include_score?: number | null;
}

/** Every topic of the v3 clustering at a cutoff, singletons included (A: v3/a/bolsas/<day>.json). */
export interface V3Bag {
  readonly cutoff: string;
  readonly topics: ReadonlyArray<V3Topic>;
}

/** One arm's list at a cutoff (A: v3/a/listas/<arm>/<day>.json). */
export interface V3List {
  readonly cutoff: string;
  readonly arm: string;
  /** "En movimiento" for v3 arms; the arm's list of 10 for the references. */
  readonly moving: ReadonlyArray<V3Topic>;
  readonly background?: ReadonlyArray<V3Topic>;
  /** Topics left out and why: reason -> count (structural eligibility, §5d). */
  readonly discards?: Readonly<Record<string, number>> | null;
}

/** A's list file, read with the field names A may use (moving / en_movimiento / topics). */
export function readListFile(path: string): V3List {
  const raw = readJsonGuarded<Record<string, unknown>>(path);
  const pick = (...keys: Array<string>) => {
    for (const k of keys) if (Array.isArray(raw[k])) return raw[k] as Array<V3Topic>;
    return undefined;
  };
  const moving = pick("moving", "en_movimiento", "topics");
  if (!moving) throw new Error(`${path}: no moving list (moving, en_movimiento or topics)`);
  const discards = (raw["discards"] ?? raw["descartes"] ?? null) as Record<string, number> | null;
  return {
    cutoff: String(raw["cutoff"] ?? NodePath.basename(path, ".json")).slice(0, 10),
    arm: String(raw["arm"] ?? NodePath.basename(NodePath.dirname(path))),
    moving,
    background: pick("background", "de_fondo") ?? [],
    discards,
  };
}

export function readBagFile(path: string): V3Bag {
  const raw = readJsonGuarded<Record<string, unknown>>(path);
  const topics = (raw["topics"] ?? raw["temas"]) as Array<V3Topic> | undefined;
  if (!Array.isArray(topics)) throw new Error(`${path}: no topics`);
  return { cutoff: String(raw["cutoff"] ?? NodePath.basename(path, ".json")).slice(0, 10), topics };
}
