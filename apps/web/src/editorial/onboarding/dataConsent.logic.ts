import type { SourceId } from "@earlyscript/editorial-contracts/source";
import {
  isCatalogSourceId,
  SOURCE_CATALOG,
  SOURCE_IDS,
  type SourceGovernance,
  type SourceRetention,
  type SourceReviewStatus,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import type { EditorialSourceEntry, EditorialSourcesCorpus } from "@t3tools/contracts";

// The "Datos y permisos" step: what Earlyscript collects, from where, under which terms, how
// long it keeps it, how it is deleted and what leaves the machine. Every sentence was checked
// against the code it describes (docs/upstream-divergence.md, section of es/onboarding-data);
// change the code and the sentence together, since the operator accepts this text.

const longDayFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const shortDayFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const formatLongDay = (day: string) => longDayFormat.format(toDate(day));
const formatShortDay = (day: string) => shortDayFormat.format(toDate(day));

/**
 * Review date of the frozen corpus's retention: Miguel's decision of 31 October 2026
 * (docs/upstream-divergence.md §18 and §21, and the `rss` record of the source catalog).
 */
const RETENTION_REVIEW_DAY = "2026-11-27";

/**
 * The texts the operator accepts. `policyHash` covers exactly these, so the recorded decision
 * proves which wording was on screen. Machine-specific values (the corpus directory) are shown
 * apart and stay out of the hash; `<directorio>` in the command is where the step puts it.
 */
export const DATA_CONSENT_POLICY = {
  intro:
    "Earlyscript reúne publicaciones públicas de las fuentes que actives para encontrar tendencias que puedan convertirse en videos. Lo capturado se guarda en el equipo donde corre Earlyscript. Nada se publica solo: cada presentación, guion y decisión pasa por ti.",
  outbound: [
    "Nada sale de esta máquina salvo dos cosas:",
    "Las peticiones a cada fuente activada para capturar. Earlyscript deja una pausa mínima entre peticiones (de 0,25 s en Hacker News a 6,5 s en GitHub), se detiene ante sus límites de cuota y comprueba el robots.txt del sitio antes de cada petición, salvo en las API de Hacker News y GitHub; arXiv tiene una excepción documentada por los términos de su API.",
    "Los textos de las tendencias que pidas redactar. Al proveedor de modelos que elijas (Claude o Codex, con tu cuenta y bajo sus condiciones) van el perfil editorial del canal, las cifras del motor para esa tendencia y hasta 12 ítems de evidencia con su fuente, fecha, enlace, título y extracto de hasta 500 caracteres. En un hilo de video, ese proveedor recibe además lo que escribas y lo que su agente lea del espacio de trabajo.",
    "Sin telemetría: las trazas, la analítica de producto y la búsqueda de actualizaciones heredadas de T3 Code están apagadas. La descarga del modelo local de embeddings pide el archivo, sin enviar tus datos.",
    "Esto describe cómo funciona el sistema; no es una política legal.",
  ],
  retention: [
    `Lo capturado se guarda como corpus congelado, con la huella SHA-256 de cada archivo en su manifiesto, hasta la revisión del ${formatLongDay(RETENTION_REVIEW_DAY)}, cuando se decide cuánto conservarlo.`,
    "De los feeds RSS solo se guarda título, enlace, autor y un extracto de hasta 500 caracteres.",
  ],
  deletion: [
    "Puedes borrar por fuente, por enlace o por autor con la orden purge del motor, desde la línea de comandos; este asistente no la lanza:",
    "La orden quita esos ítems de todos los días del corpus, anota en el manifiesto solo la huella SHA-256 de lo borrado y las capturas siguientes no los vuelven a guardar. --feed vale solo para RSS. También puedes borrar el directorio entero o los archivos de un día.",
  ],
  deletionCommand:
    "engine purge --corpus <directorio> --source <fuente> (--author <autor> | --url <enlace> | --feed <url del feed>)",
  accept:
    "He leído los términos de las fuentes activadas y usaré los datos para análisis privado, sin republicar",
} as const;

/** The deletion command with this machine's corpus directory in place. */
export const deletionCommand = (directory: string) =>
  DATA_CONSENT_POLICY.deletionCommand.replace("<directorio>", directory);

/**
 * What a captured item keeps, in the operator's words, read from each adapter in
 * packages/trend-engine/src/sources. Every item also keeps its permalink and its publication
 * and retrieval times. Keyed by SourceId, so a new catalog source fails to compile until it
 * says what it stores.
 */
export const STORED_FIELDS: Readonly<Record<SourceId, string>> = {
  hn: "Título, enlace, usuario que la envió y texto de la publicación, hasta 4.000 caracteres.",
  github: "Nombre del repositorio, enlace, propietario y descripción, hasta 4.000 caracteres.",
  arxiv: "Título, enlace, primer autor y resumen, hasta 4.000 caracteres; nunca el PDF.",
  wikipedia: "Título de la página, enlace, visitas del día y posición; nunca el artículo.",
  npm: "Nombre y versión del paquete, enlace, mantenedor, descripción y descargas semanales.",
  stackexchange: "Título, enlace, autor, etiquetas y texto de la pregunta, hasta 4.000 caracteres.",
  bluesky: "Texto de la publicación, enlace, identificador del autor y enlaces que cita.",
  huggingface: "Nombre del modelo o artículo, autor y tarjeta o resumen, hasta 4.000 caracteres.",
  lobsters: "Título, enlace, usuario que la envió y descripción, hasta 4.000 caracteres.",
  rss: "Título, enlace, autor y extracto de hasta 500 caracteres; nunca el artículo entero.",
};

const RETENTION_TEXT: Readonly<Record<SourceRetention, string>> = {
  "frozen-corpus": `Hasta la revisión del ${formatShortDay(RETENTION_REVIEW_DAY)}.`,
  "30-days": "Como máximo 30 días.",
  ephemeral: "Efímera, fuera del corpus congelado.",
};

/** First sentence of a catalog note, without the "Bloqueada:" the line already says. */
function firstSentence(text: string): string {
  const end = text.search(/\.\s/);
  const sentence = (end === -1 ? text : text.slice(0, end + 1)).trim();
  const stripped = sentence.replace(/^Bloquead[ao]:\s*/u, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** «Términos leídos el 26 de octubre de 2026», «Pendiente de leer sus términos», «Bloqueada: …». */
export function termsLine(governance: SourceGovernance): string {
  switch (governance.status) {
    case "ready":
      return governance.termsReviewedAt === null
        ? "Pendiente de leer sus términos"
        : `Términos leídos el ${formatLongDay(governance.termsReviewedAt)}`;
    case "pending-review":
      return "Pendiente de leer sus términos";
    case "blocked":
      return `Bloqueada: ${firstSentence(governance.notes)}`;
  }
}

const STATUS_ORDER: Readonly<Record<SourceReviewStatus, number>> = {
  ready: 0,
  "pending-review": 1,
  blocked: 2,
};

export interface ConsentSourceRow {
  readonly id: SourceId;
  readonly name: string;
  readonly status: SourceReviewStatus;
  readonly termsLine: string;
  readonly termsUrl: string | null;
  readonly licenseText: string;
  readonly licenseUrl: string | null;
  readonly storedText: string;
  readonly retentionText: string;
  /**
   * The switch may be turned on: terms read (`ready`) and the server does not block it. The
   * server's own `collectBlocked` wins when the two disagree (a client older than the server).
   */
  readonly capturable: boolean;
  /** What the server holds now (effective value). */
  readonly collect: boolean;
}

/**
 * The catalog sources the server lists: capturable ones first, then pending, then blocked;
 * catalog order within each group. Ids the catalog does not know are dropped.
 */
export function consentSourceRows(
  entries: ReadonlyArray<EditorialSourceEntry>,
): ReadonlyArray<ConsentSourceRow> {
  const rows: Array<ConsentSourceRow & { readonly order: number }> = [];
  for (const entry of entries) {
    if (!isCatalogSourceId(entry.source)) continue;
    const governance = SOURCE_CATALOG[entry.source];
    const capturable = governance.status === "ready" && entry.collectBlocked === null;
    rows.push({
      id: governance.id,
      name: governance.name,
      status: governance.status,
      termsLine: termsLine(governance),
      termsUrl: governance.termsUrl,
      licenseText: governance.license.text,
      licenseUrl: governance.license.url,
      storedText: STORED_FIELDS[governance.id],
      retentionText: RETENTION_TEXT[governance.retention],
      capturable,
      collect: entry.collect,
      order:
        (capturable ? 0 : 1 + STATUS_ORDER[governance.status]) * 100 +
        SOURCE_IDS.indexOf(governance.id),
    });
  }
  return rows.toSorted((a, b) => a.order - b.order).map(({ order: _order, ...row }) => row);
}

/** The operator's switches not yet written; absent ids show the server's value. */
export type CaptureDraft = Readonly<Partial<Record<SourceId, boolean>>>;

/** The switch the step shows. A source that may not be captured always shows off. */
export function shownCollect(row: ConsentSourceRow, draft: CaptureDraft): boolean {
  if (!row.capturable) return false;
  return draft[row.id] ?? row.collect;
}

/** Ids switched on, in catalog order: what the acceptance records. */
export function selectedSources(
  rows: ReadonlyArray<ConsentSourceRow>,
  draft: CaptureDraft,
): ReadonlyArray<SourceId> {
  const on = new Set(rows.filter((row) => shownCollect(row, draft)).map((row) => row.id));
  return SOURCE_IDS.filter((id) => on.has(id));
}

/**
 * The `editorial.sources.update` calls to make before continuing: only switches whose shown
 * value differs from the server's. A source the server holds on but may no longer capture is
 * written off, so the accepted list and the stored one agree.
 */
export function pendingWrites(
  rows: ReadonlyArray<ConsentSourceRow>,
  draft: CaptureDraft,
): ReadonlyArray<{ readonly source: SourceId; readonly collect: boolean }> {
  return rows.flatMap((row) => {
    const shown = shownCollect(row, draft);
    return shown === row.collect ? [] : [{ source: row.id, collect: shown }];
  });
}

/** One line about the corpus; a missing corpus is the normal state before the first capture. */
export function corpusText(corpus: EditorialSourcesCorpus): string {
  switch (corpus.status) {
    case "missing":
      return `Aún no hay capturas. El corpus se creará en ${corpus.directory} con la primera.`;
    case "unreadable":
      return `No se pudo leer el corpus en ${corpus.directory}${corpus.message ? `: ${corpus.message}` : ""}. Puedes continuar y revisarlo en Ajustes › Editorial › Fuentes.`;
    case "ready": {
      if (corpus.fromDay === null || corpus.toDay === null) return `Corpus en ${corpus.directory}.`;
      // corpus/1's to_day is exclusive.
      const last = new Date(toDate(corpus.toDay).getTime() - 86_400_000).toISOString().slice(0, 10);
      return `Corpus en ${corpus.directory}, con días del ${formatShortDay(corpus.fromDay)} al ${formatShortDay(last)}.`;
    }
  }
}

/** JSON with object keys sorted, so equal values always hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}

/** Hash of every governance record, in catalog order: the version of the records on screen. */
export const catalogHash = (
  catalog: Readonly<Record<SourceId, SourceGovernance>> = SOURCE_CATALOG,
) => sha256(canonicalJson(SOURCE_IDS.map((id) => catalog[id])));

export const policyHash = (policy: unknown = DATA_CONSENT_POLICY) => sha256(canonicalJson(policy));

/** What the shell stores as the dated decision of this step: ids, days and hashes only. */
export interface DataConsentAcceptance {
  /** Sources the captures collect, in catalog order. */
  readonly sources: ReadonlyArray<SourceId>;
  readonly acknowledgedTerms: true;
  readonly catalogHash: string;
  readonly policyHash: string;
  /** Day the terms of each collected source were read. */
  readonly acceptedTermsDates: Readonly<Partial<Record<SourceId, string>>>;
}

export async function buildAcceptance(
  sources: ReadonlyArray<SourceId>,
): Promise<DataConsentAcceptance> {
  const acceptedTermsDates: Partial<Record<SourceId, string>> = {};
  for (const id of sources) {
    const day = SOURCE_CATALOG[id].termsReviewedAt;
    if (day !== null) acceptedTermsDates[id] = day;
  }
  return {
    sources,
    acknowledgedTerms: true,
    catalogHash: await catalogHash(),
    policyHash: await policyHash(),
    acceptedTermsDates,
  };
}
