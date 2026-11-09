// Table 5d of contract v4.2 (selection, promotion and stop) as data and as one pure function.
// decide() never reads files: its input is what dev-results computed and the coordinator's
// facts about the judge, the freeze, the deployment and the pairs; its output names every row
// it applied, in the order of the table.
import { canonicalJson, sha256 } from "./hash.ts";
import { V3_VARIANTS, type V3Variant } from "./v3-metrics.ts";

export const TABLE_5D = [
  {
    id: "J1",
    situacion: "Diagnóstico del juez fallido o κ < 0,60 o acuerdo < 0,917",
    regla: "Juez «no calibrado»: U@10 se reporta, no decide; rige la vía estructural",
  },
  {
    id: "J2",
    situacion: "Juez calibrado pero con menos de 15 cortes válidos comunes a los brazos comparados",
    regla: "Se trata como no calibrado (incluye «juez caído»)",
  },
  {
    id: "U1",
    situacion: "Comparaciones de U@10",
    regla: "Solo sobre cortes válidos comunes (soporte pareado); se reporta el n",
  },
  {
    id: "R1",
    situacion:
      "Recall de despegues con < 15 despegues, o denominador cero en el subconjunto que use",
    regla: "No evaluable; se retira de selección y parada; se declara",
  },
  {
    id: "E1",
    situacion: "Elegibilidad estructural de una variante",
    regla:
      "Mediana sobre los 21 cortes (corte excluido = 0 emitidas): ≥ 7 temas emitidos; ≥ 20 % de la lista con include_score ≥ 0,40; descartes solo por exclusión",
  },
  {
    id: "S1",
    situacion: "Selección con juez calibrado",
    regla:
      "Entre las elegibles, mayor U@10 medio sobre el soporte común; empate (< 0,05): menos parámetros, luego V1 > V2 > V3 > V4",
  },
  {
    id: "S2",
    situacion: "Selección con juez no calibrado y recall evaluable",
    regla:
      "Entre las elegibles, mayor recall de despegues con include_score ≥ 0,40; empate: V1 > V2 > V3 > V4",
  },
  {
    id: "S3",
    situacion: "Selección con juez no calibrado y recall no evaluable",
    regla: "La primera elegible en V1 > V2 > V3 > V4",
  },
  {
    id: "P0",
    situacion: "Ninguna variante elegible",
    regla: "Parada: pares con engine.v1; v3 a prospectivo",
  },
  {
    id: "P1",
    situacion: "Elegida frente a R4 en U@10 (solo con juez calibrado)",
    regla:
      "Parada si diferencia puntual ≤ −0,05 y intervalo por familias entero bajo 0; si no, se reporta y se sigue",
  },
  {
    id: "P2",
    situacion: "Intervalo frente a R4 no estimable (menos de 5 familias o réplicas degeneradas)",
    regla:
      "Si la diferencia puntual es ≤ −0,05: no se promueve; pares con engine.v1. Si es > −0,05: se reporta «no estimable» y se sigue",
  },
  {
    id: "P3",
    situacion:
      "Elegida frente a R2 en recall y anticipación; frente a R5, engine.v1 y engine.v2 en todas las métricas",
    regla: "Se reportan; no deciden",
  },
  {
    id: "T1",
    situacion:
      "v3_premanifest asentado después de la primera llamada al juez o de la primera etiqueta p4",
    regla:
      "Incumplimiento asentado como adenda; el desarrollo se declara exploratorio: el juez cuenta como no calibrado y la selección sigue la vía estructural",
  },
  {
    id: "F1",
    situacion:
      "v3_freeze no asentado (y desplegado) cuando Miguel ordena empezar los pares (decisión 1, sustituye a T_freeze)",
    regla: "Pares con engine.v1 sobre la hoja de semilla 20261106; v3 a prospectivo",
  },
  {
    id: "H1",
    situacion: "Despliegue en Gertrudis falla la verificación del hash lógico",
    regla: "Un reintento desde el mismo commit; si falla, pares con engine.v1",
  },
  {
    id: "C1",
    situacion: "Pares con v3 no terminados (decisión 1: sin T_pares_fin)",
    regla: "La tesis reporta los completados y declara los faltantes; no se sustituyen ni repiten",
  },
  { id: "M1", situacion: "Miguel rechaza maqueta o promoción", regla: "Parada" },
  {
    id: "Z1",
    situacion: "Tras los pares con v3: tiempo asistido > 60 % del manual o utilidad media < 4",
    regla:
      "La tesis reporta v3 como el motor evaluado con su resultado negativo; el producto vuelve a engine.v1; no se repiten los pares",
  },
] as const;
export type Row5d = (typeof TABLE_5D)[number]["id"];
export const TABLE_5D_HASH = sha256(canonicalJson(TABLE_5D));
/**
 * Version of decide(): the table text is the pre-manifest's; 5d.2 applies J2's minimum of 15
 * common valid cutoffs to the chosen variant against R4 too (Sol, verification 1a, D1).
 */
export const DECIDE_VERSION = "5d.2";

export const JUDGE_CALIBRATION = {
  kappa_min: 0.6,
  acuerdo_min: 0.917,
  soporte_min: 15,
  validas_min: 60,
} as const;
export const R4_STOP_DIFF = -0.05;
export const SELECTION_TIE = 0.05;

/** Parameters of each variant (the "fewer parameters" tie-break of S1). */
export const VARIANT_PARAMETERS: Readonly<Record<V3Variant, number>> = {
  V1: 5,
  V2: 5,
  V3: 4,
  V4: 5,
};

export interface VariantFacts {
  readonly eligible: boolean;
  /** Mean U@10 on the common support of the eligible variants (null without it). */
  readonly u10: number | null;
  readonly recall_inc040: number | null;
}

export interface DecideInput {
  readonly premanifest_late: boolean;
  readonly judge: {
    readonly failed: boolean;
    readonly kappa: number | null;
    readonly agreement: number | null;
    /** Common valid cutoffs of the eligible variants (selection support). */
    readonly selection_support: number;
  };
  readonly recall: { readonly takeoffs: number; readonly inc040_denominator: number };
  readonly variants: Readonly<Record<V3Variant, VariantFacts>>;
  /** U@10 contrast of each variant against R4: diff, family interval and support. */
  readonly r4: Readonly<
    Record<
      V3Variant,
      {
        readonly diff: number | null;
        readonly low: number | null;
        readonly high: number | null;
        readonly estimable: boolean;
        readonly support: number;
      } | null
    >
  >;
  readonly miguel_rejects?: boolean;
  /** Text function and judge of the diagnosis and of the development scoring (file hashes). */
  readonly versions?: {
    readonly diagnostico: {
      readonly card_text_file_sha256: string | null;
      readonly judge_util_sha256: string | null;
    } | null;
    readonly puntuacion: {
      readonly card_text_file_sha256: string;
      readonly judge_util_sha256: string;
    };
    readonly cambia_respecto_al_diagnostico: boolean;
  };
  /** Later phases (pairs); absent means "not reached yet". */
  readonly pairs_phase?: {
    readonly freeze_deployed_at_order: boolean;
    readonly hash_ok: boolean;
    readonly hash_retry_ok?: boolean;
    readonly completed: number;
    readonly planned: number;
    readonly assisted_time_ratio?: number | null;
    readonly mean_utility?: number | null;
  };
}

export interface Decision {
  readonly rows: ReadonlyArray<Row5d>;
  readonly judge_calibrated: boolean;
  readonly recall_evaluable: boolean;
  readonly eligible: ReadonlyArray<V3Variant>;
  readonly chosen: V3Variant | null;
  readonly selection_path: "S1" | "S2" | "S3" | null;
  readonly stop: boolean;
  readonly promote: boolean;
  readonly pairs_engine: "v3" | "engine.v1" | null;
  readonly exploratory: boolean;
  readonly notes: ReadonlyArray<string>;
  readonly table_hash: string;
  readonly decide_version: string;
}

const ORDER = V3_VARIANTS;
const byOrder = (a: V3Variant, b: V3Variant) => ORDER.indexOf(a) - ORDER.indexOf(b);

export function decide(input: DecideInput): Decision {
  const rows: Array<Row5d> = [];
  const notes: Array<string> = [];
  const v = input.versions;
  if (v) {
    const short = (h: string | null | undefined) =>
      h ? h.replace(/^sha256:/, "").slice(0, 8) : "?";
    notes.push(
      `Puntuación de desarrollo con texto ${short(v.puntuacion.card_text_file_sha256)} y juez ${short(v.puntuacion.judge_util_sha256)}; diagnóstico con texto ${short(v.diagnostico?.card_text_file_sha256)} y juez ${short(v.diagnostico?.judge_util_sha256)}${v.cambia_respecto_al_diagnostico ? " (versiones distintas, declaradas en las adendas)" : ""}.`,
    );
  }
  const j = input.judge;
  let calibrated =
    !j.failed &&
    j.kappa !== null &&
    j.agreement !== null &&
    j.kappa >= JUDGE_CALIBRATION.kappa_min &&
    j.agreement >= JUDGE_CALIBRATION.acuerdo_min;
  if (!calibrated) rows.push("J1");
  if (input.premanifest_late) {
    rows.push("T1");
    if (calibrated) notes.push("Pre-manifiesto tardío: el juez cuenta como no calibrado.");
    calibrated = false;
  }
  if (calibrated && j.selection_support < JUDGE_CALIBRATION.soporte_min) {
    rows.push("J2");
    notes.push(`Soporte pareado de selección ${j.selection_support} < 15.`);
    calibrated = false;
  }
  const recallEvaluable = input.recall.takeoffs >= 15 && input.recall.inc040_denominator > 0;
  if (!recallEvaluable) rows.push("R1");
  rows.push("E1");
  notes.push(
    "E1, descartes solo por exclusión (DISCARD_POLICY, coordinador 9 nov): permitidos exclude, generic y en other estable_without_perennial, en_caida_without_pending_decision, folded_by_topic_identity y admitted_below_list; incomplete debe ser 0; cualquier otra clave > 0 o lista sin discards: no elegible; candidates es un recuento.",
  );
  const eligible = ORDER.filter((v) => input.variants[v].eligible);
  const base = {
    judge_calibrated: calibrated,
    recall_evaluable: recallEvaluable,
    eligible,
    exploratory: input.premanifest_late,
    table_hash: TABLE_5D_HASH,
    decide_version: DECIDE_VERSION,
  };
  if (input.miguel_rejects) {
    rows.push("M1");
    return {
      ...base,
      rows,
      chosen: null,
      selection_path: null,
      stop: true,
      promote: false,
      pairs_engine: "engine.v1",
      notes,
    };
  }
  if (eligible.length === 0) {
    rows.push("P0");
    return {
      ...base,
      rows,
      chosen: null,
      selection_path: null,
      stop: true,
      promote: false,
      pairs_engine: "engine.v1",
      notes,
    };
  }
  const structural = (): { chosen: V3Variant; path: "S2" | "S3" } => {
    if (!recallEvaluable) return { chosen: eligible.toSorted(byOrder)[0]!, path: "S3" };
    const value = (v: V3Variant) => input.variants[v].recall_inc040 ?? -1;
    const best = Math.max(...eligible.map(value));
    return { chosen: eligible.filter((v) => value(v) === best).toSorted(byOrder)[0]!, path: "S2" };
  };
  let selected: { chosen: V3Variant; path: "S1" | "S2" | "S3" };
  if (calibrated && eligible.every((v) => input.variants[v].u10 !== null)) {
    const best = Math.max(...eligible.map((v) => input.variants[v].u10!));
    const tied = eligible.filter((v) => best - input.variants[v].u10! < SELECTION_TIE);
    const fewest = Math.min(...tied.map((v) => VARIANT_PARAMETERS[v]));
    selected = {
      chosen: tied.filter((v) => VARIANT_PARAMETERS[v] === fewest).toSorted(byOrder)[0]!,
      path: "S1",
    };
    // J2 also covers the contrast that decides: the chosen variant against R4 (Sol, D1).
    const r4Support = input.r4[selected.chosen]?.support ?? 0;
    if (r4Support < JUDGE_CALIBRATION.soporte_min) {
      rows.push("J2");
      notes.push(
        `Soporte pareado de ${selected.chosen} frente a R4 ${r4Support} < 15: juez no calibrado, vía estructural.`,
      );
      calibrated = false;
      selected = structural();
    }
  } else {
    if (calibrated) notes.push("Juez calibrado sin U@10 en alguna elegible: vía estructural.");
    calibrated = false;
    selected = structural();
  }
  if (calibrated) rows.splice(rows.indexOf("E1"), 0, "U1");
  const { chosen, path } = selected;
  rows.push(path);
  let stop = false;
  let promote = true;
  let pairs: "v3" | "engine.v1" = "v3";
  const r4 = input.r4[chosen];
  if (calibrated && r4 && r4.diff !== null && r4.support >= JUDGE_CALIBRATION.soporte_min) {
    if (r4.estimable) {
      rows.push("P1");
      if (r4.diff <= R4_STOP_DIFF && r4.high !== null && r4.high < 0) {
        stop = true;
        promote = false;
        pairs = "engine.v1";
      }
    } else {
      rows.push("P2");
      if (r4.diff <= R4_STOP_DIFF) {
        promote = false;
        pairs = "engine.v1";
      } else notes.push("Intervalo frente a R4 no estimable: se reporta y se sigue.");
    }
  }
  rows.push("P3");
  const phase = input.pairs_phase;
  if (phase && !stop && promote) {
    if (!phase.freeze_deployed_at_order) {
      rows.push("F1");
      pairs = "engine.v1";
    } else if (!phase.hash_ok) {
      rows.push("H1");
      if (!phase.hash_retry_ok) pairs = "engine.v1";
    }
    if (pairs === "v3") {
      if (phase.completed < phase.planned) {
        rows.push("C1");
        notes.push(
          `Pares completados ${phase.completed} de ${phase.planned}; faltantes declarados.`,
        );
      }
      const ratio = phase.assisted_time_ratio;
      const utility = phase.mean_utility;
      if ((ratio != null && ratio > 0.6) || (utility != null && utility < 4)) {
        rows.push("Z1");
        notes.push("Resultado negativo de v3 en los pares; el producto vuelve a engine.v1.");
      }
    }
  }
  return {
    ...base,
    judge_calibrated: calibrated,
    rows,
    chosen,
    selection_path: path,
    stop,
    promote,
    pairs_engine: pairs,
    notes,
  };
}
