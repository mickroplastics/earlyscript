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

/** Keys the blind export never carries, at any depth (judge, arm, provenance). */
export const BLIND_FORBIDDEN =
  /^(judge|juez|jueces|opinion|opinión|utility_model|model_utility|fit|angle|reason_model|arm|brazo|variant|variante|engine|motor|config|config_hash|run|run_id|corrida|provenance|procedencia|source_run|origin|origen|rank|ranking|position|posicion|posición|score|scores|weights|pesos|eligibility|novelty|manifest)$/i;

export function blindExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blindExport);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !BLIND_FORBIDDEN.test(k) && !/judge|juez/i.test(k))
        .map(([k, v]) => [k, blindExport(v)]),
    );
  }
  return value;
}

/** Keys of a value at any depth (the blind test reads them). */
export function allKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  return out;
}
