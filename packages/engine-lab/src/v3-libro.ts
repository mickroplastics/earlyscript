// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the v3 ledger and its freeze order.
// Engine v3 (contract v4.2 §5e): the ledger root/v3/libro/ledger-v3.jsonl, chained to the last
// entry of P3's ledger; appendV3 is its single writer and enforces the order without going back:
// v3_open, v3_premanifest (before any judge call and any p4 label), v3_oracle, v3_judge_diag,
// v3_dev_results, v3_freeze, v3_pairs, v3_prospective; exposicion and stop at any point after
// v3_open. The pre-manifest is computed from the files and refused while a judge cache entry or
// a p4 label exists under root/v3.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { canonicalJson, sha256 } from "./hash.ts";
import { isSealedPath, LabPolicyError } from "./policy.ts";
import { V3_HISTORY_START, V3_LAST_DATA_DAY } from "./v3-data.ts";
import {
  decide,
  type DecideInput,
  JUDGE_CALIBRATION,
  TABLE_5D,
  TABLE_5D_HASH,
  VARIANT_PARAMETERS,
} from "./v3-decide.ts";
import {
  appendLedger,
  fileSha256,
  type LedgerEntry,
  ledgerLineShas,
  readLedger,
} from "./v3-ledger.ts";
import {
  DISCARD_POLICY,
  DISCARD_POLICY_HASH,
  V3_CAPTURE,
  V3_ELIGIBILITY,
  V3_RESAMPLING,
  V3_RESAMPLING_HASH,
} from "./v3-metrics.ts";
import {
  P4_DEFINITION,
  P4_IDENTITY_ANCHORS,
  p4DefinitionHash,
  V3_BAG_DAYS,
  V3_CUTOFFS,
  V3_LIST_DAYS,
} from "./v3-oracle.ts";
import { SEED_6_NOV } from "./v3-pairs.ts";

export const V3_LEDGER_KINDS = [
  "v3_open",
  "v3_premanifest",
  "v3_premanifest_2",
  "v3_oracle",
  "v3_judge_diag",
  "v3_dev_results",
  "v3_freeze",
  "v3_pairs",
  "v3_prospective",
  "exposicion",
  "stop",
] as const;
export type V3LedgerKind = (typeof V3_LEDGER_KINDS)[number];

/** The main chain, in order: each needs the one before it and happens once (§5e). */
const CHAIN: ReadonlyArray<V3LedgerKind> = [
  "v3_open",
  "v3_premanifest",
  "v3_oracle",
  "v3_judge_diag",
  "v3_dev_results",
  "v3_freeze",
];

const fail = (code: "invalid-change" | "sealed-partition", message: string): never => {
  throw new LabPolicyError(code, message);
};

export const v3Dir = (root: string) => NodePath.join(NodePath.resolve(root), "v3");
export const v3LedgerPath = (root: string) => {
  if (isSealedPath(NodePath.resolve(root)))
    fail("sealed-partition", `${root} is a sealed P1 path.`);
  return NodePath.join(v3Dir(root), "libro", "ledger-v3.jsonl");
};
export const p3LedgerPath = (root: string) =>
  NodePath.join(NodePath.resolve(root), "p3", "libro", "ledger-p3.jsonl");

/** The closing entry of P3's ledger, read through its own chain check (read only). */
export function p3Closing(root: string): { readonly entries: number; readonly sha256: string } {
  const path = p3LedgerPath(root);
  readLedger(path);
  const shas = ledgerLineShas(path);
  if (shas.length === 0) fail("invalid-change", "P3's ledger is empty.");
  return { entries: shas.length, sha256: shas.at(-1)! };
}

const has = (ledger: ReadonlyArray<LedgerEntry>, kind: V3LedgerKind) =>
  ledger.some((e) => e.kind === kind);

/** The exposure Miguel's profile v2 needs before the pre-manifest (coordinator, 9 Nov). */
export const PROFILE_V2_EXPOSURE_PREFIX = "Perfil v2";
const profileExposure = (ledger: ReadonlyArray<LedgerEntry>) =>
  ledger.some(
    (e) =>
      e.kind === "exposicion" && String(e["texto"] ?? "").startsWith(PROFILE_V2_EXPOSURE_PREFIX),
  );

/** Contract §5e as code: whether an entry of `kind` with `payload` may follow `ledger`. */
export function assertV3Order(
  ledger: ReadonlyArray<LedgerEntry>,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  if (!(V3_LEDGER_KINDS as ReadonlyArray<string>).includes(kind))
    fail("invalid-change", `${kind} is not a v3 ledger entry.`);
  const k = kind as V3LedgerKind;
  if (ledger.length === 0 && k !== "v3_open")
    fail("invalid-change", "The v3 ledger opens with v3_open.");
  if (k === "v3_open") {
    if (ledger.length > 0) fail("invalid-change", "The v3 ledger is already open.");
    if (typeof payload["p3_last_sha256"] !== "string")
      fail("invalid-change", "v3_open records the sha256 of P3's last entry.");
    return;
  }
  const once = () => {
    if (has(ledger, k)) fail("invalid-change", `The v3 ledger already has its ${k}.`);
  };
  const requires = (what: V3LedgerKind) => {
    if (!has(ledger, what)) fail("invalid-change", `${k} before ${what}.`);
  };
  const stopped = has(ledger, "stop");
  if (stopped && !["exposicion", "v3_prospective", "v3_pairs"].includes(k))
    fail("invalid-change", `v3 is stopped; no ${k} after stop.`);
  switch (k) {
    case "exposicion":
      if (typeof payload["texto"] !== "string" || payload["texto"].trim() === "")
        fail("invalid-change", "exposicion needs texto.");
      return;
    case "stop":
      once();
      if (typeof payload["motivo"] !== "string" || payload["motivo"].trim() === "")
        fail("invalid-change", "stop needs motivo.");
      return;
    case "v3_premanifest_2":
      once();
      requires("v3_premanifest");
      if (has(ledger, "v3_judge_diag"))
        fail("invalid-change", "v3_premanifest_2 comes before v3_judge_diag.");
      return;
    case "v3_pairs": {
      requires("v3_premanifest");
      const engine = payload["motor"];
      if (engine === "v3") {
        requires("v3_freeze");
        if (stopped) fail("invalid-change", "Pairs with v3 after stop.");
      } else if (engine !== "engine.v1")
        fail("invalid-change", "v3_pairs records motor v3 or engine.v1.");
      if (ledger.some((e) => e.kind === "v3_pairs" && e["motor"] === engine))
        fail(
          "invalid-change",
          `The pairs with ${String(engine)} are entered once; they are not repeated.`,
        );
      return;
    }
    case "v3_prospective": {
      requires("v3_premanifest");
      const day = payload["fecha"];
      if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))
        fail("invalid-change", "v3_prospective needs fecha YYYY-MM-DD.");
      const pre = ledger.find((e) => e.kind === "v3_premanifest")!;
      if (String(day) <= pre.at.slice(0, 10))
        fail("invalid-change", "The prospective starts the day after the pre-manifest.");
      if (ledger.some((e) => e.kind === "v3_prospective" && e["fecha"] === day))
        fail("invalid-change", `v3_prospective ${String(day)} exists.`);
      return;
    }
    default: {
      once();
      const at = CHAIN.indexOf(k);
      requires(CHAIN[at - 1]!);
      if (k === "v3_premanifest" && !profileExposure(ledger))
        fail(
          "invalid-change",
          `v3_premanifest needs the exposicion "${PROFILE_V2_EXPOSURE_PREFIX} ..." before it.`,
        );
      if (k === "v3_freeze") {
        const dev = ledger.find((e) => e.kind === "v3_dev_results")!;
        const d = dev["decision"] as { promote?: boolean; stop?: boolean } | undefined;
        if (!d?.promote || d.stop)
          fail("invalid-change", "v3_freeze needs dev results that promote (table 5d).");
        if (
          typeof payload["aprobacion_miguel"] !== "string" ||
          payload["aprobacion_miguel"].trim() === ""
        )
          fail("invalid-change", "v3_freeze needs Miguel's approval (decision 2).");
      }
    }
  }
}

/** The single writer: P3's named entry must still be there, then the order, then the append. */
export function appendV3(
  root: string,
  kind: V3LedgerKind,
  payload: Record<string, unknown>,
  now?: () => Date,
): LedgerEntry {
  const path = v3LedgerPath(root);
  const ledger = readLedger(path);
  const p3 = p3Closing(root);
  if (kind === "v3_open") {
    if (payload["p3_last_sha256"] !== p3.sha256 || payload["p3_entries"] !== p3.entries)
      fail("invalid-change", "v3_open must name the last entry of P3's ledger.");
  } else if (ledger.length > 0) {
    const open = ledger[0]!;
    const shas = ledgerLineShas(p3LedgerPath(root));
    if (shas[Number(open["p3_entries"]) - 1] !== open["p3_last_sha256"])
      fail("invalid-change", "P3's ledger no longer holds the entry v3_open names.");
  }
  assertV3Order(ledger, kind, payload);
  return appendLedger(path, { kind, protocol: "v3", ...payload }, now);
}

export const readV3Ledger = (root: string) => readLedger(v3LedgerPath(root));

/** sha256 of the ledger line of the first entry of `kind`. */
export function entrySha(root: string, kind: V3LedgerKind): string | null {
  const ledger = readV3Ledger(root);
  const k = ledger.findIndex((e) => e.kind === kind);
  return k < 0 ? null : ledgerLineShas(v3LedgerPath(root))[k]!;
}

function walk(dir: string, rel = ""): Array<string> {
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(NodePath.join(dir, e.name), r) : e.isFile() ? [r] : [];
  });
}

const JUDGE_SEGMENT = /(judge|juez|jueces)/i;
const P4_SEGMENT = /^(p4|etiquetas[-_]?p4|labels[-_]?p4|etiquetas|labels)$/i;
const P4_FILE = /(^|[-_.])p4([-_.]|$)/i;
const DOC = /\.(md|txt)$/i;

/**
 * Judge cache entries under root/v3 (any non-empty file, not a document, under a path segment
 * naming a judge, plus every non-empty file of the extra cache directories), and the rubric
 * files of the repository are not under root/v3, so they never count.
 */
/** B's judge cache, watched by default. */
export const V3_JUDGE_CACHE_DIR = (root: string) => NodePath.join(v3Dir(root), "b", "cache");

export function judgeCacheEntries(
  root: string,
  extraDirs: ReadonlyArray<string> = [],
): Array<string> {
  const base = v3Dir(root);
  const inV3 = walk(base)
    .filter((rel) => !rel.startsWith("libro/"))
    .filter(
      (rel) =>
        rel
          .split("/")
          .slice(0, -1)
          .some((s) => JUDGE_SEGMENT.test(s)) ||
        (JUDGE_SEGMENT.test(NodePath.basename(rel)) && /cache|cach/i.test(rel)),
    )
    .filter((rel) => !DOC.test(rel))
    .map((rel) => NodePath.join(base, rel));
  // B's standard cache (v3/b/cache/<judge>/answers/...) is always watched (Sol, should).
  const dirs = [
    ...new Set([V3_JUDGE_CACHE_DIR(root), ...extraDirs.map((d) => NodePath.resolve(d))]),
  ];
  const extra = dirs.flatMap((dir) => walk(dir).map((rel) => NodePath.join(dir, rel)));
  return [...new Set([...inV3, ...extra])].filter((p) => NodeFS.statSync(p).size > 0);
}

/** p4 label files under root/v3: files under a labels/p4 segment, or named with p4. */
export function p4LabelFiles(root: string): Array<string> {
  const base = v3Dir(root);
  return walk(base)
    .filter((rel) => !rel.startsWith("libro/") && !DOC.test(rel))
    .filter(
      (rel) =>
        rel
          .split("/")
          .slice(0, -1)
          .some((s) => P4_SEGMENT.test(s)) || P4_FILE.test(NodePath.basename(rel)),
    )
    .map((rel) => NodePath.join(base, rel));
}

/** §2.7 movements and antecedent, frozen as the contract writes them. */
export const V3_MOVEMENTS = {
  orden: "gana el primero",
  antecedente_perenne:
    "marca: >= 3 semanas con n >= 5 en W0..W4, o n(vida) >= 30 con alguna semana anterior a W1 con n >= 5",
  movimientos: [
    { id: "en_caida", regla: "n(W0) < 0,5·n(W1) y n(W1) >= 3" },
    {
      id: "rebote",
      regla: "n(W1) < n(W2), n(W0) >= n(W1), n(W0) >= 3, alguna semana anterior con n >= 5",
    },
    { id: "nueva", regla: "first_at >= t − 7 y n(W0) >= 3" },
    { id: "senal_fuerte", regla: "pop >= p90, n(W0) >= 8, n(W0) >= n(W1)" },
    { id: "senal_debil", regla: "pop >= p50, 3 <= n(W0) < 8, (n(W0) >= 1,5·n(W1) o n(W1) = 0)" },
    { id: "estable", regla: "el resto" },
  ],
  popularidad:
    "pop(t) = Σ 2^(−(t − t_i)/τ), τ = 7 días; p50 y p90 entre los temas con n(W0) >= 3 del corte",
  en_movimiento:
    "nueva, débil, fuerte y rebote sin antecedente perenne; 10 temas; dos plazas por pop y fuentes con include >= 0,40",
  de_fondo:
    "antecedente perenne y n(W0) >= 3, incluidos fuertes y rebotes con antecedente, por relevancia, hasta 5",
  descarte: "exclude_score >= 0,60 y exclude_score > include_score",
  genericos: "> 2 % al final",
  dedup: "sameTopic 0,80",
} as const;

export const V3_VARIANT_DEFINITIONS = {
  V1: {
    nombre: "base",
    tau_dias: 7,
    pesos: { relevance: 1, growth: 0.25, log_items_7d: 0.15, sources_7d: 0.1 },
    plazas_trayectoria: 2,
    parametros: VARIANT_PARAMETERS.V1,
  },
  V2: {
    nombre: "τ 14",
    tau_dias: 14,
    pesos: { relevance: 1, growth: 0.25, log_items_7d: 0.15, sources_7d: 0.1 },
    plazas_trayectoria: 2,
    parametros: VARIANT_PARAMETERS.V2,
  },
  V3: {
    nombre: "sin término de fuentes",
    tau_dias: 7,
    pesos: { relevance: 1, growth: 0.25, log_items_7d: 0.15 },
    plazas_trayectoria: 2,
    parametros: VARIANT_PARAMETERS.V3,
  },
  V4: {
    nombre: "relevancia 0,5",
    tau_dias: 7,
    pesos: { relevance: 0.5, growth: 0.25, log_items_7d: 0.15, sources_7d: 0.1 },
    plazas_trayectoria: 2,
    parametros: VARIANT_PARAMETERS.V4,
  },
  empate: "V1 > V2 > V3 > V4",
  empate_menos_parametros:
    "declarado (coordinador, 9 nov): con juez calibrado, en empate de U@10 (< 0,05) gana la de menos parámetros, así que V3 (4) gana antes que V1, V2 y V4 (5); entre iguales, V1 > V2 > V3 > V4",
} as const;

export const V3_REFERENCE_DEFINITIONS = {
  R4: "lista por palabras clave del perfil: config/editorial-eval/keywords.v1.json (como en P1.3); no usa el perfil v2",
  R2: "volumen n(W0) con include >= 0,60 y exclude < 0,60",
  R5: "regresión a la media: n(W0) = 3, n(W1) >= 5, las más grandes en la vida",
  "engine.v1": "la lista de engine.v1.json proyectada sobre los temas v3 por sameTopic",
  "engine.v2": "la lista de engine.v2.json proyectada sobre los temas v3 por sameTopic",
  paridad:
    "misma tarjeta v3, mismos movimientos sobre el mismo agrupamiento, misma función de texto",
} as const;

export const V3_COHORT = {
  agrupan: ["hn", "github", "huggingface", "npm", "rss"],
  comparables_en_desarrollo: ["hn", "github", "huggingface", "npm"],
  parcial: ["rss"],
  no_usada: ["wikipedia"],
  regla_comparable:
    "en coverage.jsonl los 35 días de [t−35, t), cualquier estado, <= 3 días unavailable",
  historia: V3_HISTORY_START,
  ultimo_dia_de_datos: V3_LAST_DATA_DAY,
} as const;

export const V3_JUDGES = {
  jueces: [
    {
      nombre: "Opus",
      modelo: "claude-opus-5-5",
      via: "CLI de Claude sin herramientas (suscripción Claude Max)",
    },
    {
      nombre: "Sol",
      modelo: "gpt-6.1-sol",
      via: "CLI de Codex sin herramientas (suscripción ChatGPT Pro)",
    },
  ],
  utility: "media de las dos",
  fit: "acuerdo; si discrepan, 'discrepan' y cuenta como 'no' en el diagnóstico de encaje",
  calibrado: JUDGE_CALIBRATION,
  presupuesto: "sin dólares; se registra el número de llamadas",
  oculto_en_pares: true,
  fuera_del_orden: true,
} as const;

export const V3_DEADLINES = {
  T_freeze: null,
  T_pares_fin: null,
  regla:
    "decisión 1 de Miguel: los seis pares se hacen con el motor congelado (v3_freeze asentado y desplegado) cuando Miguel ordene empezar; sin v3_freeze, con engine.v1 sobre la hoja de semilla 20261106; los pares que no terminen se reportan como faltantes",
  semilla_hoja_anterior: SEED_6_NOV,
} as const;

export interface PremanifestFiles {
  readonly contract: string;
  readonly rubric: string;
  readonly cardText: string;
  readonly profileV2: string;
  readonly profileV1: string;
  readonly keywords: string;
  readonly measurementA: string;
}

/** The source of `export function cardTextV3` (from its declaration to its matching brace). */
export function functionSource(text: string, name: string): string {
  const at = text.search(
    new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`),
  );
  if (at < 0) throw new Error(`no export ${name}`);
  const open = text.indexOf("{", text.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  throw new Error(`unclosed ${name}`);
}

const need = (path: string, what: string) => {
  if (!NodeFS.existsSync(path)) fail("invalid-change", `${what} does not exist yet: ${path}`);
  return path;
};

/** Every hash and definition of v3_premanifest, computed from the files (read only). */
export function computePremanifest(files: PremanifestFiles) {
  const contract = NodeFS.readFileSync(need(files.contract, "The contract"), "utf8");
  if (!/^# .*versión 4\.2\b/m.test(contract))
    fail("invalid-change", "The contract's title is not versión 4.2.");
  const cardText = NodeFS.readFileSync(need(files.cardText, "cardTextV3's file"), "utf8");
  let cardSource: string;
  try {
    cardSource = functionSource(cardText, "cardTextV3");
  } catch {
    return fail("invalid-change", `${files.cardText} exports no cardTextV3.`);
  }
  need(files.rubric, "judge/judge.util.v1.json");
  const measurement = JSON.parse(
    NodeFS.readFileSync(need(files.measurementA, "The measurement A"), "utf8"),
  ) as Record<string, unknown>;
  const def = <T>(definicion: T) => ({ definicion, sha256: sha256(canonicalJson(definicion)) });
  return {
    contrato: {
      path: NodePath.resolve(files.contract),
      sha256: fileSha256(files.contract),
      version: "4.2",
    },
    rubrica: { path: NodePath.resolve(files.rubric), sha256: fileSha256(files.rubric) },
    // Identity: the whole file (helpers such as cleanText included); the function hash is
    // informative only (Sol B1 changed cleanText and left cardTextV3's body as it was).
    card_text_v3: {
      path: NodePath.resolve(files.cardText),
      file_sha256: fileSha256(files.cardText),
      function_sha256: sha256(cardSource),
    },
    perfiles: {
      v2: {
        path: NodePath.resolve(files.profileV2),
        sha256: fileSha256(need(files.profileV2, "Profile v2")),
        uso: "perfil del motor v3 y de R2",
      },
      v1: {
        path: NodePath.resolve(files.profileV1),
        sha256: fileSha256(need(files.profileV1, "Profile v1")),
        uso: "referencia",
      },
      r4_keywords: {
        path: NodePath.resolve(files.keywords),
        sha256: fileSha256(need(files.keywords, "keywords.v1.json")),
        nota: "R4 usa keywords.v1.json",
      },
    },
    movimientos: def(V3_MOVEMENTS),
    variantes: def(V3_VARIANT_DEFINITIONS),
    referencias: def(V3_REFERENCE_DEFINITIONS),
    cortes: def({ desarrollo: V3_CUTOFFS, listas: V3_LIST_DAYS, bolsas: V3_BAG_DAYS }),
    captura: def(V3_CAPTURE),
    elegibilidad: def(V3_ELIGIBILITY),
    remuestreo: { definicion: V3_RESAMPLING, sha256: V3_RESAMPLING_HASH },
    cohorte: def(V3_COHORT),
    tabla_5d: { definicion: TABLE_5D, sha256: TABLE_5D_HASH },
    jueces: def(V3_JUDGES),
    plazos: def(V3_DEADLINES),
    oraculo_p4_borrador_sha256: p4DefinitionHash(),
    medicion_a_sin_wikipedia: {
      path: NodePath.resolve(files.measurementA),
      sha256: fileSha256(files.measurementA),
      despegues_42_cortes: measurement["takeoffs"] ?? null,
      despegues_include_060: measurement["takeoffs_with_include_060"] ?? null,
      octubre_4_24:
        (measurement["october_4_to_24"] as Record<string, unknown> | undefined)?.["takeoffs"] ??
        null,
      cohorte: measurement["cohort"] ?? null,
    },
  };
}

const withoutPaths = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutPaths)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== "path")
            .map(([k, v]) => [k, withoutPaths(v)]),
        )
      : value;

/**
 * Fields of computePremanifest that differ from the entered pre-manifest. Hashes and
 * definitions are compared, not the paths: a frozen copy of the same file shows no drift.
 */
export function premanifestDrift(
  entry: Readonly<Record<string, unknown>>,
  computed: ReturnType<typeof computePremanifest>,
): Array<string> {
  return Object.entries(computed)
    .filter(([k, v]) => canonicalJson(withoutPaths(entry[k])) !== canonicalJson(withoutPaths(v)))
    .map(([k]) => k);
}

/**
 * The v3_premanifest payload. Refused while any judge cache entry or any p4 label exists under
 * root/v3, unless `late` is set: then it is entered with the files found and §5d T1 applies.
 */
export function premanifestPayload(options: {
  readonly root: string;
  readonly files: PremanifestFiles;
  readonly judgeCaches?: ReadonlyArray<string>;
  readonly late?: boolean;
}) {
  const caches = judgeCacheEntries(options.root, options.judgeCaches ?? []);
  const labels = p4LabelFiles(options.root);
  const found = [...caches, ...labels];
  if (found.length > 0 && !options.late) {
    fail(
      "sealed-partition",
      `Judge cache entries or p4 labels exist before the pre-manifest: ${found.slice(0, 5).join(", ")}${found.length > 5 ? ` (+${found.length - 5})` : ""}. Enter it with --tardio (§5d T1) or remove nothing and report.`,
    );
  }
  return {
    ...computePremanifest(options.files),
    tardio: found.length > 0,
    encontrados_al_asentar: { cache_jueces: caches, etiquetas_p4: labels },
    cache_jueces_vigiladas: options.judgeCaches ?? [],
  };
}

/** Coordinator, 9 Nov: P1's sealed cutoffs inside v3's period and what v3 does with them. */
export const V3_SEALED_CUTOFFS_NOTE = {
  cortes: ["2026-10-27", "2026-10-30"],
  uso: "solo producen listas para la ventana de captación [max(T−14, 4 oct), min(T+6, 30 oct)]; no son cortes de despegue del oráculo p4 ni de U@10, y no tienen etiquetas p4",
} as const;

/** v3_oracle: the p4 definition and the identity anchors; refused once a p4 label exists. */
export function oraclePayload(root: string) {
  const labels = p4LabelFiles(root);
  if (labels.length > 0)
    fail("sealed-partition", `p4 labels exist before v3_oracle: ${labels.slice(0, 5).join(", ")}`);
  const pre = readV3Ledger(root).find((e) => e.kind === "v3_premanifest");
  if (pre && pre["oraculo_p4_borrador_sha256"] !== p4DefinitionHash())
    fail("invalid-change", "The p4 definition changed since the pre-manifest.");
  return {
    definicion: P4_DEFINITION,
    sha256: p4DefinitionHash(),
    anclas_identidad: P4_IDENTITY_ANCHORS,
    anclas_sha256: sha256(canonicalJson(P4_IDENTITY_ANCHORS)),
    cortes_sellados_p1: V3_SEALED_CUTOFFS_NOTE,
  };
}

/** Labels may be produced on real data only after v3_oracle, with the same definition. */
export function assertCanLabel(ledger: ReadonlyArray<LedgerEntry>) {
  const oracle = ledger.find((e) => e.kind === "v3_oracle");
  if (!oracle) fail("sealed-partition", "No p4 label before the v3_oracle entry.");
  if (oracle!["sha256"] !== p4DefinitionHash())
    fail("invalid-change", "The p4 definition differs from the v3_oracle entry.");
}

export function judgeDiagPayload(options: {
  readonly diagPath?: string | undefined;
  readonly failed: boolean;
  readonly kappa: number | null;
  readonly agreement: number | null;
  readonly validOpus: number | null;
  readonly validSol: number | null;
}) {
  const valid = (n: number | null) => n !== null && n >= JUDGE_CALIBRATION.validas_min;
  const failed = options.failed || !valid(options.validOpus) || !valid(options.validSol);
  const calibrated =
    !failed &&
    options.kappa !== null &&
    options.agreement !== null &&
    options.kappa >= JUDGE_CALIBRATION.kappa_min &&
    options.agreement >= JUDGE_CALIBRATION.acuerdo_min;
  return {
    diag: options.diagPath
      ? { path: NodePath.resolve(options.diagPath), sha256: fileSha256(options.diagPath) }
      : null,
    fallido: failed,
    kappa: options.kappa,
    acuerdo: options.agreement,
    validas: { opus: options.validOpus, sol: options.validSol },
    calibrado: calibrated,
    criterio: JUDGE_CALIBRATION,
  };
}

/** v3_dev_results: the metrics file, decide() recomputed on its input, and the row applied. */
/** The text function and judge rubric in force after a ledger entry (file hashes). */
export interface TextJudgeVersion {
  readonly card_text_file_sha256: string | null;
  readonly judge_util_sha256: string | null;
  readonly desde: string;
  readonly asiento: string;
}

const CARD_KEY = /^card_text_v3_archivo_sha256_v(\d+)$/;
const JUDGE_KEY = /^judge_util_v1_sha256_v(\d+)$/;

/**
 * The fields of an addendum to the pre-manifest: v3_premanifest_2's `campos`, or an
 * `exposicion --tipo adenda_premanifest` (its `campos`, or the JSON object in its texto).
 */
export function addendumFields(entry: LedgerEntry): Record<string, unknown> | null {
  if (entry.kind === "v3_premanifest_2") return (entry["campos"] as Record<string, unknown>) ?? {};
  if (entry.kind !== "exposicion" || entry["tipo"] !== "adenda_premanifest") return null;
  if (entry["campos"] && typeof entry["campos"] === "object")
    return entry["campos"] as Record<string, unknown>;
  const text = String(entry["texto"] ?? "");
  const at = text.indexOf("{");
  if (at < 0) return {};
  try {
    return JSON.parse(text.slice(at)) as Record<string, unknown>;
  } catch {
    return fail("invalid-change", `The addendum of ${entry.at} carries no readable JSON.`);
  }
}

const latestVersioned = (fields: Record<string, unknown>, key: RegExp): string | null => {
  let best: { n: number; value: string } | null = null;
  for (const [k, v] of Object.entries(fields)) {
    const m = key.exec(k);
    if (m && typeof v === "string" && (best === null || Number(m[1]) > best.n))
      best = { n: Number(m[1]), value: v };
  }
  return best?.value ?? null;
};

/** Every state of (text function, judge rubric) declared in the ledger, with its position. */
function indexedVersions(
  ledger: ReadonlyArray<LedgerEntry>,
): Array<{ readonly version: TextJudgeVersion; readonly index: number }> {
  const preIndex = ledger.findIndex((e) => e.kind === "v3_premanifest");
  if (preIndex < 0) return [];
  const pre = ledger[preIndex]!;
  let state: TextJudgeVersion = {
    card_text_file_sha256:
      ((pre["card_text_v3"] as { file_sha256?: string }) ?? {}).file_sha256 ?? null,
    judge_util_sha256: ((pre["rubrica"] as { sha256?: string }) ?? {}).sha256 ?? null,
    desde: pre.at,
    asiento: "v3_premanifest",
  };
  const out = [{ version: state, index: preIndex }];
  for (const [index, e] of ledger.entries()) {
    const fields = addendumFields(e);
    if (!fields) continue;
    const card = latestVersioned(fields, CARD_KEY);
    const judge = latestVersioned(fields, JUDGE_KEY);
    if (card === null && judge === null) continue;
    state = {
      card_text_file_sha256: card ?? state.card_text_file_sha256,
      judge_util_sha256: judge ?? state.judge_util_sha256,
      desde: e.at,
      asiento: e.kind === "exposicion" ? "exposicion adenda_premanifest" : e.kind,
    };
    out.push({ version: state, index });
  }
  return out;
}

/** Every state of (text function, judge rubric) declared in the ledger, in order. */
export const declaredVersions = (ledger: ReadonlyArray<LedgerEntry>): Array<TextJudgeVersion> =>
  indexedVersions(ledger).map((v) => v.version);

/**
 * The version in force when `entry` was written: the last declared before it. Two entries
 * can share a millisecond; on a tie the position in the ledger decides.
 */
export function versionBefore(
  ledger: ReadonlyArray<LedgerEntry>,
  entry: LedgerEntry,
): TextJudgeVersion | null {
  const at = ledger.indexOf(entry);
  if (at < 0) return fail("invalid-change", `The entry of ${entry.at} is not in the ledger.`);
  return (
    indexedVersions(ledger).findLast(
      (v) => v.version.desde < entry.at || (v.version.desde === entry.at && v.index < at),
    )?.version ?? null
  );
}

export function devResultsPayload(
  root: string,
  metricsPath: string,
  scoring: { readonly cardText: string; readonly rubric: string },
) {
  const ledger = readV3Ledger(root);
  const oracle = ledger.find((e) => e.kind === "v3_oracle");
  const diag = ledger.find((e) => e.kind === "v3_judge_diag");
  const pre = ledger.find((e) => e.kind === "v3_premanifest");
  if (!oracle || !diag || !pre)
    return fail("invalid-change", "v3_dev_results needs v3_oracle and v3_judge_diag.");
  const metrics = JSON.parse(NodeFS.readFileSync(metricsPath, "utf8")) as {
    p4_sha256: string;
    decide_input: DecideInput;
  };
  if (metrics.p4_sha256 !== oracle["sha256"])
    fail("invalid-change", "The metrics used another p4 definition.");
  const late =
    pre["tardio"] === true ||
    ledger.some((e) => e.kind === "exposicion" && e["tipo"] === "premanifest_tardio");
  const input: DecideInput = {
    ...metrics.decide_input,
    premanifest_late: late,
    judge: {
      ...metrics.decide_input.judge,
      failed: diag["fallido"] === true,
      kappa: (diag["kappa"] as number | null) ?? null,
      agreement: (diag["acuerdo"] as number | null) ?? null,
    },
  };
  const versions = declaredVersions(ledger);
  const diagVersion = versionBefore(ledger, diag);
  const used = {
    card_text_file_sha256: fileSha256(scoring.cardText),
    judge_util_sha256: fileSha256(scoring.rubric),
  };
  const declared = versions.at(-1)!;
  if (
    used.card_text_file_sha256 !== declared.card_text_file_sha256 ||
    used.judge_util_sha256 !== declared.judge_util_sha256
  ) {
    fail(
      "invalid-change",
      `The scoring used text ${used.card_text_file_sha256} and judge ${used.judge_util_sha256}; the ledger declares ${declared.card_text_file_sha256} and ${declared.judge_util_sha256} (enter an adenda_premanifest first).`,
    );
  }
  const versionsUsed = {
    diagnostico: diagVersion,
    puntuacion: { ...used, declarada_en: declared.asiento, desde: declared.desde },
    cambia_respecto_al_diagnostico:
      diagVersion === null ||
      diagVersion.card_text_file_sha256 !== used.card_text_file_sha256 ||
      diagVersion.judge_util_sha256 !== used.judge_util_sha256,
    declaradas: versions,
  };
  const decision = decide({ ...input, versions: versionsUsed });
  return {
    versiones_texto_y_juez: versionsUsed,
    politica_descartes: { definicion: DISCARD_POLICY, sha256: DISCARD_POLICY_HASH },
    metricas: { path: NodePath.resolve(metricsPath), sha256: fileSha256(metricsPath) },
    decide_input: input,
    decision,
    fila_aplicada: decision.rows,
    variante_elegida: decision.chosen,
  };
}

export function freezePayload(options: {
  readonly configPath: string;
  readonly commit: string;
  readonly tree: string;
  readonly runDir: string;
  readonly runHash: string;
  readonly logicalHash: string | null;
  readonly pairsSeed: number;
  readonly citationsSeed: number;
  readonly approval: string;
}) {
  if (options.pairsSeed === SEED_6_NOV) fail("invalid-change", "The v3 pairs need a new seed.");
  return {
    config: { path: NodePath.resolve(options.configPath), sha256: fileSha256(options.configPath) },
    codigo: { commit: options.commit, tree: options.tree },
    corrida: {
      dir: NodePath.resolve(options.runDir),
      sha256: options.runHash,
      hash_logico: options.logicalHash,
    },
    semilla_pares: options.pairsSeed,
    semilla_citas: options.citationsSeed,
    aprobacion_miguel: options.approval,
  };
}
