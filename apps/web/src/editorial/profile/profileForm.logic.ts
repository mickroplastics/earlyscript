import {
  EDITORIAL_PROFILE_LIMITS,
  editorialProfileIssues,
  normalizeEditorialProfileDraft,
  sameEditorialProfile,
  type EditorialEngineScoring,
  type EditorialProfileDraft,
  type EditorialProfileField,
  type EditorialProfileIssue,
  type EditorialProfileVersion,
} from "@t3tools/contracts";

/** Shown when the session lacks `orchestration:operate`; the server would refuse the save. */
export const PROFILE_READ_ONLY_TEXT = "Solo lectura: tu sesión no puede cambiar el perfil.";

/** The form as typed: one entry per topic row, blank while it is being edited. */
export interface ProfileFormValues {
  readonly name: string;
  readonly audience: string;
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

export type ProfileTopicField = "include" | "exclude";

export function formFromProfile(profile: EditorialProfileDraft): ProfileFormValues {
  return {
    name: profile.name,
    audience: profile.audience,
    include: [...profile.include],
    exclude: [...profile.exclude],
  };
}

/** What would be saved: the server normalizes the same way. */
export function draftFromForm(values: ProfileFormValues): EditorialProfileDraft {
  return normalizeEditorialProfileDraft(values);
}

/** Topics typed or pasted into the add box: one per line, blank lines dropped. */
export function topicsFromText(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

export function profileFormIssues(values: ProfileFormValues): ReadonlyArray<EditorialProfileIssue> {
  return editorialProfileIssues(draftFromForm(values));
}

/** Whether saving would create a version: normalized fields differ from the active profile. */
export function profileFormChanged(
  values: ProfileFormValues,
  active: EditorialProfileDraft,
): boolean {
  return !sameEditorialProfile(draftFromForm(values), active);
}

export function topicCount(topics: ReadonlyArray<string>): number {
  return normalizeEditorialProfileDraft({ name: "", audience: "", include: topics, exclude: [] })
    .include.length;
}

const limits = EDITORIAL_PROFILE_LIMITS;

/** The operator's words for one issue. */
function profileIssueText(issue: EditorialProfileIssue): string {
  switch (issue.field) {
    case "name":
      return issue.code === "required"
        ? "Escribe el nombre del canal."
        : `El nombre admite hasta ${limits.nameMax} caracteres.`;
    case "audience":
      return issue.code === "required"
        ? "Describe la audiencia en una frase."
        : `La audiencia admite hasta ${limits.audienceMax} caracteres.`;
    case "include":
    case "exclude": {
      if (issue.code === "required") return "Escribe al menos un tema que cubre el canal.";
      if (issue.code === "too-many") return `Caben hasta ${limits.topicsMax} temas.`;
      if (issue.code === "overlap") {
        return "Un tema no puede estar a la vez entre los que cubre y los que deja fuera.";
      }
      return `Cada tema admite hasta ${limits.topicMax} caracteres.`;
    }
  }
}

/** The first message for each field, for the error under it. */
export function issuesByField(
  issues: ReadonlyArray<EditorialProfileIssue>,
): Partial<Record<EditorialProfileField, string>> {
  const out: Partial<Record<EditorialProfileField, string>> = {};
  for (const issue of issues) out[issue.field] ??= profileIssueText(issue);
  return out;
}

const savedFormat = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** «Versión 1, de Earlywindow» or «Versión 3, guardada el 2 nov 2026, 18:20». */
export function profileVersionLabel(version: EditorialProfileVersion): string {
  if (version.origin === "earlywindow") return `Versión ${version.version}, de Earlywindow`;
  return `Versión ${version.version}, guardada el ${savedFormat.format(new Date(version.createdAt))}`;
}

interface ParameterText {
  readonly label: string;
  readonly description: string;
}

/** What each named engine parameter does, in the operator's words. */
const PARAMETER_TEXT: Readonly<Record<string, ParameterText>> = {
  "profile.include_min": {
    label: "Afinidad mínima con los temas",
    description:
      "Una tendencia entra a la bandeja solo si se parece al menos esto a alguno de los temas que cubre el canal (similitud de 0 a 1).",
  },
  "profile.exclude_max": {
    label: "Límite con los temas excluidos",
    description:
      "Una tendencia se descarta si se parece esto o más a alguno de los temas que el canal deja fuera.",
  },
  "cluster.threshold": {
    label: "Umbral de agrupación",
    description:
      "Similitud mínima para que dos publicaciones cuenten como la misma señal. Más alto, señales más estrechas.",
  },
  "stage.growth_min": {
    label: "Crecimiento mínimo",
    description:
      "Crecimiento de la última semana frente a la anterior, en logaritmo, desde el que una señal está creciendo (0,69 es el doble).",
  },
  "stage.fading_max": {
    label: "Caída para declive",
    description: "Por debajo de este crecimiento la señal se marca en declive (−0,69 es la mitad).",
  },
  "stage.growing_min_items_7d": {
    label: "Publicaciones mínimas en 7 días",
    description:
      "Una señal necesita al menos estas publicaciones en la semana para contar como creciente.",
  },
  "rank.weighted.weights.growth": {
    label: "Peso del crecimiento",
    description: "Cuánto pesa el crecimiento semanal en la puntuación que ordena la bandeja.",
  },
  "rank.weighted.weights.log_authors_7d": {
    label: "Peso de los autores",
    description:
      "Cuánto pesa el número de autores distintos de la semana (en logaritmo): muchas voces pesan más que una que repite.",
  },
  "rank.weighted.weights.include_score": {
    label: "Peso de la afinidad",
    description: "Cuánto pesa el parecido con los temas del canal en la puntuación.",
  },
  "emit.max_dossiers": {
    label: "Tendencias por corrida",
    description: "Máximo de expedientes que cada corrida entrega a la bandeja.",
  },
};

const numberFormat = new Intl.NumberFormat("es", { maximumFractionDigits: 3 });

export interface ScoringRow {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
}

export function scoringRows(scoring: EditorialEngineScoring): ReadonlyArray<ScoringRow> {
  return scoring.parameters.map((parameter) => {
    const text = Object.hasOwn(PARAMETER_TEXT, parameter.key)
      ? PARAMETER_TEXT[parameter.key]
      : undefined;
    return {
      key: parameter.key,
      label: text?.label ?? parameter.key,
      description: text?.description ?? "",
      value: numberFormat.format(parameter.value),
    };
  });
}

export interface ProfileSaveFailure {
  /** The server's validation, shown under the fields. */
  readonly issues: ReadonlyArray<EditorialProfileIssue>;
  /** Anything else, shown above the buttons; null when the issues say it all. */
  readonly message: string | null;
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  storage: "La base editorial no respondió; el perfil no se guardó.",
  unavailable: "Los servicios editoriales no están montados en este servidor.",
  EnvironmentAuthorizationError: "Esta conexión no tiene permiso para cambiar el perfil.",
};

/** What a failed save tells the operator. */
export function profileSaveFailure(error: unknown): ProfileSaveFailure {
  if (typeof error !== "object" || error === null) {
    return { issues: [], message: "El perfil no se guardó." };
  }
  const record = error as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly issues?: unknown;
  };
  if (
    record.reason === "invalid-profile" &&
    Array.isArray(record.issues) &&
    record.issues.length > 0
  ) {
    return { issues: record.issues as ReadonlyArray<EditorialProfileIssue>, message: null };
  }
  const key = typeof record.reason === "string" ? record.reason : String(record._tag);
  return {
    issues: [],
    message: Object.hasOwn(FAILURE_TEXT, key) ? FAILURE_TEXT[key]! : "El perfil no se guardó.",
  };
}
