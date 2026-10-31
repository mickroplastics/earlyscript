// @effect-diagnostics nodeBuiltinImport:off -- the fallback key hashes the terms.
import * as NodeCrypto from "node:crypto";

import { EditorialTrendKey } from "@t3tools/contracts";

/**
 * How a dossier's trend identity was derived. Stored with each indexed dossier, so a later
 * rule can be applied next to the old one and the inbox rows migrated explicitly.
 */
export type TrendKeyRule = "signal-id" | "top-terms";

export interface TrendKey {
  readonly key: EditorialTrendKey;
  readonly rule: TrendKeyRule;
}

export interface TrendKeySource {
  readonly signal: { readonly id?: string | undefined; readonly top_terms?: ReadonlyArray<string> };
  readonly dossier_id: string;
}

const TERMS_HASH_CHARS = 12;

/**
 * Trend identity across runs: `signal.id` when the dossier has one (the engine derives it
 * from the signal's first item), else `terms_` + sha256 of the sorted top terms. Rules are
 * documented in docs/upstream-divergence.md §12; add new ones here, never rewrite old keys.
 */
export function trendKeyOf(source: TrendKeySource): TrendKey {
  const id = source.signal.id?.trim();
  if (id !== undefined && id.length > 0) {
    return { key: EditorialTrendKey.make(id), rule: "signal-id" };
  }
  const terms = (source.signal.top_terms ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0)
    .toSorted();
  const material = terms.length > 0 ? terms.join("\n") : `dossier:${source.dossier_id}`;
  const hash = NodeCrypto.createHash("sha256").update(material, "utf8").digest("hex");
  return {
    key: EditorialTrendKey.make(`terms_${hash.slice(0, TERMS_HASH_CHARS)}`),
    rule: "top-terms",
  };
}
