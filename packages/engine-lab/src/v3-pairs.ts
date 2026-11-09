// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - hashes a frozen run on disk.
// The six pairs on a frozen v3 run (contract v4.2 §5b): a seeded draw with the structure of the
// 6 Nov sheet (planificacion/2026-11-06-ejercicios-seis-pares/asignacion.json), the seeded pick
// of 3 citations per card for the semantic check, the hash of a run directory, and the blind
// export without judge, arm or provenance fields.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { canonicalJson, sha256 } from "./hash.ts";
import { seededRandom } from "./v3-metrics.ts";

/** The seed of the 6 Nov sheet: v3's draw needs a new one. */
export const SEED_6_NOV = 20261106;

export interface PairCandidate {
  readonly tema: string;
  readonly dossier_id: string;
  readonly items_7d: number;
}
export interface PairsInput {
  readonly protocolo: string;
  readonly corrida: string;
  readonly config: string;
  readonly sesiones: ReadonlyArray<{
    readonly dominio: string;
    readonly candidatos: ReadonlyArray<PairCandidate>;
  }>;
}

function shuffle<T>(values: ReadonlyArray<T>, random: () => number): Array<T> {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Per session: two candidates by a seeded shuffle, and which of them goes first and manual. */
export function drawPairs(input: PairsInput, seed: number) {
  if (seed === SEED_6_NOV) throw new Error("The v3 draw needs a new seed, not 20261106.");
  if (input.sesiones.length !== 6) throw new Error(`Six sessions, not ${input.sesiones.length}.`);
  const random = seededRandom(seed);
  const ids = input.sesiones.flatMap((s) => s.candidatos.map((c) => c.dossier_id));
  if (new Set(ids).size !== ids.length) throw new Error("A dossier appears in two places.");
  return {
    protocolo: input.protocolo,
    semilla: seed,
    corrida: input.corrida,
    config: input.config,
    sesiones: input.sesiones.map((s, k) => {
      if (s.candidatos.length < 2) throw new Error(`Session ${k + 1} needs two candidates.`);
      const [a, b] = shuffle(s.candidatos, random) as [PairCandidate, PairCandidate];
      const manualFirst = random() < 0.5;
      return {
        sesion: k + 1,
        dominio: s.dominio,
        ejercicios: [
          {
            orden: 1,
            modo: manualFirst ? "manual" : "asistido",
            tema: a.tema,
            dossier_id: a.dossier_id,
            items_7d: a.items_7d,
          },
          {
            orden: 2,
            modo: manualFirst ? "asistido" : "manual",
            tema: b.tema,
            dossier_id: b.dossier_id,
            items_7d: b.items_7d,
          },
        ],
      };
    }),
  };
}

/** §5b: 3 citations of a card, by a seed fixed before the pairs and the card id. */
export function pickCitations<T>(
  cardId: string,
  citations: ReadonlyArray<T>,
  seed: number,
  count = 3,
): Array<T> {
  const mix = Number.parseInt(sha256(`${seed}\n${cardId}`).slice(7, 15), 16);
  return shuffle(citations, seededRandom(mix)).slice(0, count);
}

/** sha256 of a run directory: sorted relative paths and the sha256 of each file. */
export function directoryHash(dir: string): string {
  const files: Array<string> = [];
  const walk = (rel: string) => {
    for (const e of NodeFS.readdirSync(NodePath.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk("");
  return sha256(
    canonicalJson(
      files.toSorted().map((f) => [f, sha256(NodeFS.readFileSync(NodePath.join(dir, f)))]),
    ),
  );
}

/** A leaf of the blind schema takes a primitive or an array of primitives, never an object. */
type BlindSpec = true | { readonly [key: string]: BlindSpec } | readonly [BlindSpec];

const SOURCE_FIRST = { source: true, at: true } as const;
/**
 * The allowed schema of a blind card (§5b, Sol D2): only these fields of A's card (dossier/2,
 * `card` of a list entry) pass; everything else is dropped, at every depth. Nothing of the
 * judges (B), the arm, the order, the profile scores, the engine or the run is in it.
 */
export const BLIND_CARD_SCHEMA = {
  cutoff_at: true,
  trend: {
    label: true,
    top_terms: true,
    items_7d: true,
    items_prev_7d: true,
    items_total: true,
    sources: true,
  },
  movement: {
    movement: true,
    movement_since: true,
    first_at: true,
    perennial: true,
    weeks: true,
    items_life: true,
    authors_w0: true,
    sources_w0: true,
    by_source: [{ source: true, status: true, weeks: true, total: true, authors_w0: true }],
    first_source: SOURCE_FIRST,
    second_source: SOURCE_FIRST,
    fit: {
      nearest_include: true,
      matched_terms: true,
      headlines: [{ item_id: true, source: true, title: true, permalink: true }],
    },
    saturation: { items_life: true, heavy_weeks: true, perennial: true, decided_at: true },
  },
  evidence: [
    {
      item_id: true,
      source: true,
      title: true,
      author: true,
      excerpt: true,
      permalink: true,
      external_url: true,
      published_at: true,
      week: true,
      also_in: [{ source: true, item_id: true, permalink: true, published_at: true }],
    },
  ],
  evidence_status: true,
} as const satisfies { readonly [key: string]: BlindSpec };

const isPrimitive = (v: unknown) =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

function project(value: unknown, spec: BlindSpec): unknown {
  if (spec === true) {
    if (isPrimitive(value)) return value;
    if (Array.isArray(value) && value.every(isPrimitive)) return [...value];
    return undefined;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) return undefined;
    return value.map((v) => project(v, spec[0]!)).filter((v) => v !== undefined);
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(spec as Record<string, BlindSpec>)) {
    if (!Object.hasOwn(value, key)) continue;
    const v = project((value as Record<string, unknown>)[key], inner);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** One blind card: a list entry's `card`, or a card itself, projected on BLIND_CARD_SCHEMA. */
export function blindCard(entry: unknown): Record<string, unknown> {
  const card =
    entry !== null && typeof entry === "object" && "card" in entry
      ? (entry as { card: unknown }).card
      : entry;
  return (project(card, BLIND_CARD_SCHEMA) as Record<string, unknown> | undefined) ?? {};
}

/**
 * The blind export: an array of entries, or an object whose `moving` or `cards` holds them,
 * becomes an array of blind cards; nothing outside the allowed schema is carried.
 */
export function blindExport(value: unknown): Array<Record<string, unknown>> {
  const entries = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object"
      ? (((value as Record<string, unknown>)["moving"] ??
          (value as Record<string, unknown>)["cards"] ?? [value]) as Array<unknown>)
      : [];
  return (Array.isArray(entries) ? entries : []).map(blindCard);
}

/** Every key path of the allowed schema ("a.b", arrays without index). */
export function blindSchemaPaths(spec: BlindSpec = BLIND_CARD_SCHEMA, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (spec === true) return out;
  const inner = Array.isArray(spec) ? spec[0]! : spec;
  if (inner === true) return out;
  for (const [k, v] of Object.entries(inner as Record<string, BlindSpec>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    for (const p of blindSchemaPaths(v, path)) out.add(p);
  }
  return out;
}

/** Key paths of a value ("a.b", arrays without index). */
export function keyPaths(value: unknown, prefix = "", out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keyPaths(v, prefix, out);
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      keyPaths(v, path, out);
    }
  return out;
}
