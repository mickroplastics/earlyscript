// Oracle p4 of engine v3 (contract v4.2 §4) as pure functions over A's topics and the corpus:
// P4_DEFINITION is the rule v3_oracle hashes; a list topic matches a takeoff when the bag of
// t + 7 gives it that destination with ceil(|c| / 2) shared items. Nothing here writes a label:
// the CLI writes labels only after the v3_oracle entry.
import { canonicalJson, sha256 } from "./hash.ts";
import {
  type CoverageIndex,
  type CorpusItem,
  DAY_MS,
  dayOf,
  dayStart,
  inclusiveDays,
  plusDays,
  V3_HISTORY_START,
  type V3Bag,
  type V3Topic,
} from "./v3-data.ts";

/** §4 and §5a: the 21 development cutoffs; lists up to 30 Oct, bags up to 31 Oct. */
export const V3_CUTOFFS = inclusiveDays("2026-10-04", "2026-10-24");
export const V3_LIST_DAYS = inclusiveDays("2026-10-04", "2026-10-30");
export const V3_BAG_DAYS = inclusiveDays("2026-10-04", "2026-10-31");

/** §4 as code; its canonical JSON hash is what v3_oracle records. */
export const P4_DEFINITION = {
  regla: "p4",
  contrato: "diseno-v3-v4.md, versión 4.2, §4",
  unidad: "URL única: misma external_url canónica en dos ítems o fuentes cuenta una vez",
  url_canonica:
    "minúsculas; sin esquema, sin 'www.', sin fragmento, sin parámetros utm_*, sin barra final; sin URL, el id del ítem",
  fuentes_que_cuentan:
    "comparables en t (§2.2): en coverage.jsonl los 35 días de [t−35, t), cualquier estado, ≤ 3 días unavailable; candidatas hn, github, huggingface, npm, rss; wikipedia nunca",
  ventana_futura: "[t, t+7)",
  semanas: "Wk = [t−7(k+1), t−7k), k = 0..4; vida = [2026-08-30, t)",
  min_items_futuros: 5,
  razon_min: 1.5,
  razon: "(n[t,t+7) + 1) / (n(W0) + 1)",
  no_cae: "n(W0) >= n(W1)",
  existe_antes_de_t: "n(vida) >= 1 (como la maqueta de la medición A)",
  antecedente_perenne:
    "§2.7: >= 3 semanas con n >= 5 en W0..W4, o n(vida) >= 30 con alguna semana alineada anterior a W1 (k >= 2, desde 2026-08-30) con n >= 5",
  generico:
    "n[t,t+7) > 2 % de las URL únicas de las fuentes que cuentan en [t, t+7) dentro de la bolsa de t+7",
  generico_share: 0.02,
  corroboracion: {
    fuentes: ">= 2 fuentes que cuentan entre los ítems de s en [t, t+7)",
    autores:
      ">= 3 autores distintos (sin mayúsculas, no vacíos) entre los ítems de s en [t, t+7) con entidad enlazada",
    entidad_enlazada:
      "entities con prefijo github:, arxiv: o hf:, o external_url distinta del permalink del ítem",
    min_fuentes: 2,
    min_autores: 3,
  },
  huecos: {
    futuro:
      "fuente comparable con >= 2 días unavailable en [t, t+7): no cuenta en ese corte; desconocido si >= 30 % de los ítems futuros de s (todas las comparables) están en ella",
    semanas:
      "§2.5: fuente con >= 2 días unavailable en Wk: esa fila es '?' y sus ítems no entran en n(Wk); desconocido si las filas '?' de W0..W2 tienen >= 30 % de los ítems conocidos de s en esas semanas",
    umbral_desconocido: 0.3,
  },
  emparejamiento: {
    bolsa: "la bolsa de A de t+7 (todos los temas, también los de un ítem)",
    regla:
      "destino de c = el tema de la bolsa con más ítems compartidos con c (empate: menor topic_id); acierto si comparten >= ceil(|c|/2), |c| = ítems de c publicados antes de su corte, |c| > 0",
    un_acierto_por_destino: true,
  },
  identidad_del_despegue:
    "un despegue por tema: el primer corte de los 21 en que despega; un tema con el mismo topic_id, o que comparte >= la mitad de los ítems del menor con un destino ya contado, es el mismo",
  cortes: { desde: "2026-10-04", hasta: "2026-10-24", n: 21 },
} as const;

export const p4DefinitionHash = () => sha256(canonicalJson(P4_DEFINITION));

/** The anchors of topic identity v3_oracle records with the definition. */
export const P4_IDENTITY_ANCHORS = {
  emparejamiento: P4_DEFINITION.emparejamiento.regla,
  identidad: P4_DEFINITION.identidad_del_despegue,
  url_canonica: P4_DEFINITION.url_canonica,
  autor: "author del ítem sin mayúsculas; vacío no cuenta",
  bolsas: "v3/a/bolsas/<día>.json, 4–31 oct",
  listas: "v3/a/listas/<brazo>/<día>.json, 4–30 oct",
  dedup_lista: "sameTopic 0,80 lo aplica A al emitir; D no vuelve a deduplicar",
} as const;

export function canonicalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = url.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  s = s.replace(/#.*$/, "");
  const q = s.indexOf("?");
  if (q >= 0) {
    const params = s
      .slice(q + 1)
      .split("&")
      .filter((p) => p && !p.startsWith("utm_"));
    s = s.slice(0, q) + (params.length > 0 ? `?${params.join("&")}` : "");
  }
  return s.replace(/\/+$/, "");
}

export interface IndexedItem {
  readonly id: string;
  readonly source: string;
  readonly ms: number;
  readonly unit: string;
  readonly author: string;
  readonly linked: boolean;
}

const ENTITY = /^(github|arxiv|hf):/;

export function indexItem(item: CorpusItem): IndexedItem {
  const url = canonicalUrl(item.external_url);
  const permalink = canonicalUrl(item.permalink);
  const ms = Date.parse(item.published_at);
  if (Number.isNaN(ms)) throw new Error(`${item.id}: no published_at`);
  return {
    id: item.id,
    source: item.source,
    ms,
    unit: url ?? `id:${item.id}`,
    author: (item.author ?? "").trim().toLowerCase(),
    linked:
      (item.entities ?? []).some((e) => ENTITY.test(e)) || (url !== null && url !== permalink),
  };
}

export type ItemIndex = ReadonlyMap<string, IndexedItem>;
export const itemIndex = (items: ReadonlyArray<CorpusItem>): ItemIndex =>
  new Map(items.map((item) => [item.id, indexItem(item)]));

const unavailableDays = (coverage: CoverageIndex, source: string, from: number, to: number) => {
  let n = 0;
  const bySource = coverage.get(source);
  for (let ms = from; ms < to; ms += DAY_MS) if (bySource?.get(dayOf(ms)) === "unavailable") n++;
  return n;
};

/** §2.2: the comparable sources at t among the candidates (Wikipedia never). */
export function comparableSources(
  coverage: CoverageIndex,
  cutoff: string,
  candidates: ReadonlyArray<string> = ["hn", "github", "huggingface", "npm", "rss"],
  windowDays = 35,
  maxUnavailable = 3,
): Array<string> {
  const t = dayStart(cutoff);
  return candidates.filter((source) => {
    if (source === "wikipedia") return false;
    const bySource = coverage.get(source);
    if (!bySource) return false;
    let unavailable = 0;
    for (let k = 1; k <= windowDays; k++) {
      const status = bySource.get(dayOf(t - k * DAY_MS));
      if (status === undefined) return false;
      if (status === "unavailable") unavailable++;
    }
    return unavailable <= maxUnavailable;
  });
}

/** The cut context of p4 at t: which sources count, which drop out of the future, which rows are "?". */
export interface P4Context {
  readonly cutoff: string;
  readonly comparable: ReadonlySet<string>;
  /** Comparable sources with >= 2 unavailable days in [t, t+7). */
  readonly futureDropped: ReadonlySet<string>;
  /** "source\nk" for the rows "?" of W0..W4. */
  readonly unknownRows: ReadonlySet<string>;
  /** Unique URLs of the counted sources in [t, t+7) over the bag of t+7. */
  readonly windowUnits: number;
}

export function p4Context(
  cutoff: string,
  coverage: CoverageIndex,
  bagNext: V3Bag,
  items: ItemIndex,
): P4Context {
  const t = dayStart(cutoff);
  const comparable = new Set(comparableSources(coverage, cutoff));
  const futureDropped = new Set(
    [...comparable].filter((s) => unavailableDays(coverage, s, t, t + 7 * DAY_MS) >= 2),
  );
  const unknownRows = new Set<string>();
  for (const s of comparable)
    for (let k = 0; k <= 4; k++)
      if (unavailableDays(coverage, s, t - 7 * (k + 1) * DAY_MS, t - 7 * k * DAY_MS) >= 2)
        unknownRows.add(`${s}\n${k}`);
  const units = new Set<string>();
  for (const topic of bagNext.topics)
    for (const id of topic.item_ids) {
      const it = items.get(id);
      if (!it || it.ms < t || it.ms >= t + 7 * DAY_MS) continue;
      if (comparable.has(it.source) && !futureDropped.has(it.source)) units.add(it.unit);
    }
  return { cutoff, comparable, futureDropped, unknownRows, windowUnits: units.size };
}

export type P4Value = "despegue" | "no" | "desconocido";

export interface P4Label {
  readonly cutoff: string;
  readonly topic_id: string;
  readonly label: P4Value;
  readonly reasons: ReadonlyArray<string>;
  readonly n_future: number;
  /** n(W0)..n(W4), unique URLs, rows "?" left out. */
  readonly n_weeks: ReadonlyArray<number>;
  readonly n_life: number;
  readonly perennial: boolean;
  readonly generic: boolean;
  readonly corroboration: "fuentes" | "autores" | null;
  readonly future_sources: ReadonlyArray<string>;
  readonly linked_authors: number;
}

const units = (members: ReadonlyArray<IndexedItem>) => {
  const first = new Map<string, number>();
  for (const it of members) {
    const prev = first.get(it.unit);
    if (prev === undefined || it.ms < prev) first.set(it.unit, it.ms);
  }
  return first;
};

/** Rule p4 for one topic of the bag of t + 7. */
export function p4Label(topic: V3Topic, context: P4Context, items: ItemIndex): P4Label {
  const t = dayStart(context.cutoff);
  const week = (ms: number) => Math.floor((t - ms - 1) / (7 * DAY_MS));
  const members = topic.item_ids.map((id) => {
    const it = items.get(id);
    if (!it) throw new Error(`p4: no corpus item ${id} (topic ${topic.topic_id})`);
    return it;
  });
  const counted = members.filter((it) => context.comparable.has(it.source));
  const past = counted.filter((it) => it.ms < t && it.ms >= dayStart(V3_HISTORY_START));
  const reasons: Array<string> = [];
  // §2.5: rows "?" of W0..W2 and the incomplete topic.
  const recent = past.filter((it) => week(it.ms) <= 2);
  const inUnknown = recent.filter((it) => context.unknownRows.has(`${it.source}\n${week(it.ms)}`));
  if (
    recent.length > 0 &&
    inUnknown.length / recent.length >= P4_DEFINITION.huecos.umbral_desconocido
  )
    reasons.push("incompleto");
  const known = past.filter(
    (it) => week(it.ms) > 4 || !context.unknownRows.has(`${it.source}\n${week(it.ms)}`),
  );
  const pastUnits = units(known);
  const weekCounts = new Map<number, number>();
  for (const ms of pastUnits.values())
    weekCounts.set(week(ms), (weekCounts.get(week(ms)) ?? 0) + 1);
  const nWeeks = [0, 1, 2, 3, 4].map((k) => weekCounts.get(k) ?? 0);
  const nLife = pastUnits.size;
  const start = dayStart(V3_HISTORY_START);
  let earlyHeavy = false;
  for (let k = 2; t - 7 * k * DAY_MS > start; k++)
    if ((weekCounts.get(k) ?? 0) >= 5) earlyHeavy = true;
  const perennial = nWeeks.filter((n) => n >= 5).length >= 3 || (nLife >= 30 && earlyHeavy);
  // The future window.
  const futureAll = counted.filter((it) => it.ms >= t && it.ms < t + 7 * DAY_MS);
  const futureItems = futureAll.filter((it) => !context.futureDropped.has(it.source));
  if (
    futureAll.length > 0 &&
    (futureAll.length - futureItems.length) / futureAll.length >=
      P4_DEFINITION.huecos.umbral_desconocido
  )
    reasons.push("fuente_caida");
  const nFuture = units(futureItems).size;
  const [n0, n1] = nWeeks as [number, number];
  if (nLife < 1) reasons.push("no_existe");
  if (nFuture < P4_DEFINITION.min_items_futuros) reasons.push("pocos");
  if ((nFuture + 1) / (n0 + 1) < P4_DEFINITION.razon_min) reasons.push("razon");
  if (n0 < n1) reasons.push("cae");
  if (perennial) reasons.push("perenne");
  const generic = nFuture > P4_DEFINITION.generico_share * context.windowUnits;
  if (generic) reasons.push("generico");
  const futureSources = [...new Set(futureItems.map((it) => it.source))].toSorted();
  const linkedAuthors = new Set(
    futureItems.filter((it) => it.linked && it.author !== "").map((it) => it.author),
  ).size;
  const corroboration =
    futureSources.length >= P4_DEFINITION.corroboracion.min_fuentes
      ? "fuentes"
      : linkedAuthors >= P4_DEFINITION.corroboracion.min_autores
        ? "autores"
        : null;
  if (corroboration === null) reasons.push("sin_corroboracion");
  const unknown = reasons.includes("incompleto") || reasons.includes("fuente_caida");
  return {
    cutoff: context.cutoff,
    topic_id: topic.topic_id,
    label: unknown ? "desconocido" : reasons.length === 0 ? "despegue" : "no",
    reasons,
    n_future: nFuture,
    n_weeks: nWeeks,
    n_life: nLife,
    perennial,
    generic,
    corroboration,
    future_sources: futureSources,
    linked_authors: linkedAuthors,
  };
}

/** Index of a bag for matching: item -> topic position. */
export interface BagIndex {
  readonly cutoff: string;
  readonly topics: ReadonlyArray<V3Topic>;
  readonly topicOfItem: ReadonlyMap<string, number>;
}
export function bagIndex(bag: V3Bag): BagIndex {
  const topicOfItem = new Map<string, number>();
  bag.topics.forEach((topic, k) => {
    for (const id of topic.item_ids) topicOfItem.set(id, k);
  });
  return { cutoff: bag.cutoff, topics: bag.topics, topicOfItem };
}

/**
 * Destination of a list topic c of cutoff `cut` in a bag: the topic sharing most of c's items
 * published before `cut` (ties to the smaller topic_id); null unless they share ceil(|c| / 2).
 */
export function destinationOf(
  c: V3Topic,
  cut: string,
  bag: BagIndex,
  items: ItemIndex,
): { topic_id: string; shared: number; own: number } | null {
  const before = dayStart(cut);
  const own = [...new Set(c.item_ids)].filter((id) => {
    const it = items.get(id);
    return it !== undefined && it.ms < before;
  });
  if (own.length === 0) return null;
  const shared = new Map<number, number>();
  for (const id of own) {
    const k = bag.topicOfItem.get(id);
    if (k !== undefined) shared.set(k, (shared.get(k) ?? 0) + 1);
  }
  let best: { k: number; n: number } | null = null;
  for (const [k, n] of shared) {
    if (
      best === null ||
      n > best.n ||
      (n === best.n && bag.topics[k]!.topic_id < bag.topics[best.k]!.topic_id)
    )
      best = { k, n };
  }
  if (best === null || best.n < Math.ceil(own.length / 2)) return null;
  return { topic_id: bag.topics[best.k]!.topic_id, shared: best.n, own: own.length };
}

export interface Takeoff {
  readonly T: string;
  readonly topic_id: string;
  readonly item_ids: ReadonlyArray<string>;
  readonly include_score: number | null;
  readonly label: P4Label;
}

const sameAsCounted = (topic: V3Topic, prior: ReadonlyArray<Takeoff>) =>
  prior.some((p) => {
    if (p.topic_id === topic.topic_id) return true;
    const [small, large] =
      p.item_ids.length <= topic.item_ids.length
        ? [p.item_ids, topic.item_ids]
        : [topic.item_ids, p.item_ids];
    if (small.length === 0) return false;
    const big = new Set(large);
    return small.filter((id) => big.has(id)).length >= small.length / 2;
  });

/**
 * The takeoffs of the 21 cutoffs: one per topic, at its first cutoff, with the unknowns of each
 * cutoff reported apart. `bagOf(day)` gives A's bag of that day. The include score of a takeoff
 * is the one of the bag-of-T topic that maps to it (null when none does).
 */
export function findTakeoffs(options: {
  readonly cutoffs: ReadonlyArray<string>;
  readonly bagOf: (day: string) => V3Bag;
  readonly coverage: CoverageIndex;
  readonly items: ItemIndex;
}): { takeoffs: Array<Takeoff>; unknown: Array<P4Label>; labels: Map<string, Array<P4Label>> } {
  const takeoffs: Array<Takeoff> = [];
  const unknown: Array<P4Label> = [];
  const labels = new Map<string, Array<P4Label>>();
  for (const t of options.cutoffs) {
    const next = options.bagOf(plusDays(t, 7));
    const context = p4Context(t, options.coverage, next, options.items);
    const nextIndex = bagIndex(next);
    const at = options.bagOf(t);
    const cut: Array<P4Label> = [];
    for (const topic of next.topics) {
      const label = p4Label(topic, context, options.items);
      cut.push(label);
      if (label.label === "desconocido") unknown.push(label);
      if (label.label !== "despegue" || sameAsCounted(topic, takeoffs)) continue;
      let include: number | null = null;
      let bestShared = 0;
      for (const prior of at.topics) {
        const d = destinationOf(prior, t, nextIndex, options.items);
        if (d?.topic_id === topic.topic_id && d.shared > bestShared) {
          bestShared = d.shared;
          include = prior.include_score ?? null;
        }
      }
      takeoffs.push({
        T: t,
        topic_id: topic.topic_id,
        item_ids: topic.item_ids,
        include_score: include,
        label,
      });
    }
    labels.set(t, cut);
  }
  return { takeoffs, unknown, labels };
}
