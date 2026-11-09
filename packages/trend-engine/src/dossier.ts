// Labels, dossier ids and the logical hash, from Earlywindow's src/engine/dossier.ts.
import type { Dossier } from "@earlyscript/editorial-contracts/dossier";

import { canonicalJson, sha256 } from "./hash.ts";

const STOPWORDS = new Set(
  (
    "the and for with from that this your you are was were has have had not but all any can will into out over about after " +
    "its it's our their them they what when where which who why how new now use using used just more most than then there " +
    "here also via get got one two show ask tell does did make made like some only very been being would could should"
  ).split(" "),
);

const tokens = (text: string): Array<string> =>
  text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];

/** Terms used by at least two items, by how many items use them, then alphabetically. */
export function topTerms(texts: ReadonlyArray<string>, limit: number): Array<string> {
  const df = new Map<string, number>();
  for (const text of texts) {
    for (const token of new Set(tokens(text))) {
      if (!STOPWORDS.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return [...df]
    .filter(([, n]) => n >= 2)
    .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([term]) => term);
}

export const dossierId = (runId: string, signalId: string): string =>
  `dos_${sha256(`${runId}\n${signalId}`).slice(7, 19)}`;

/** Fields that differ between two runs of the same inputs. */
const VOLATILE = new Set(["run_id", "dossier_id", "created_at"]);

/**
 * SHA-256 of the dossiers in file order, without run ids or timestamps, numbers at six
 * decimals: what two runs of the same corpus, cutoff, configuration and profile reproduce.
 */
export function logicalHash(dossiers: ReadonlyArray<Dossier | object>): string {
  const stripped = JSON.parse(
    JSON.stringify(dossiers, (key, value: unknown) => {
      if (VOLATILE.has(key)) return undefined;
      if (typeof value === "number") return Number.isInteger(value) ? value : value.toFixed(6);
      return value;
    }),
  ) as unknown;
  return sha256(canonicalJson(stripped));
}
