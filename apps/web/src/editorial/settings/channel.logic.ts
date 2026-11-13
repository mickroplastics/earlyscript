import type { EditorialProfileVersion } from "@t3tools/contracts";

// «Mi canal» › Historial: one line per profile version saying what it changed.

const MAX_TOPIC_CHARS = 36;

const quote = (topic: string) =>
  `«${topic.length > MAX_TOPIC_CHARS ? `${topic.slice(0, MAX_TOPIC_CHARS - 1).trimEnd()}…` : topic}»`;

const topicsText = (count: number) => (count === 1 ? "1 tema" : `${count} temas`);

function listChange(
  added: ReadonlyArray<string>,
  removed: ReadonlyArray<string>,
  words: { readonly add: string; readonly remove: string },
): ReadonlyArray<string> {
  const changes: Array<string> = [];
  if (added.length === 1) changes.push(`${words.add} el tema ${quote(added[0]!)}`);
  else if (added.length > 1) changes.push(`${words.add} ${topicsText(added.length)}`);
  if (removed.length === 1) changes.push(`${words.remove} el tema ${quote(removed[0]!)}`);
  else if (removed.length > 1) changes.push(`${words.remove} ${topicsText(removed.length)}`);
  return changes;
}

const difference = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.filter((item) => !b.includes(item));

/** What `version` changed from `previous`, in a few words; the first version says what it holds. */
export function versionChange(
  version: EditorialProfileVersion,
  previous: EditorialProfileVersion | undefined,
): string {
  if (previous === undefined) {
    const lead = version.origin === "earlywindow" ? "Importada de Earlywindow" : "Versión inicial";
    return `${lead} · ${topicsText(version.include.length)} que cubre, ${version.exclude.length} que deja fuera`;
  }
  const changes = [
    ...(version.name === previous.name ? [] : ["cambia el nombre"]),
    ...(version.language === previous.language ? [] : ["cambia el idioma"]),
    ...(version.audience === previous.audience ? [] : ["cambia la audiencia"]),
    ...listChange(
      difference(version.include, previous.include),
      difference(previous.include, version.include),
      { add: "añade", remove: "quita" },
    ),
    ...listChange(
      difference(version.exclude, previous.exclude),
      difference(previous.exclude, version.exclude),
      { add: "deja fuera", remove: "vuelve a admitir" },
    ),
  ];
  if (changes.length === 0) return "reordena los temas";
  if (changes.length <= 2) return changes.join(" y ");
  return `${changes.slice(0, 2).join(", ")} y ${changes.length - 2} cambios más`;
}

/** The short form of a profile hash, as the dossiers record it. */
export const shortHash = (hash: string) => hash.replace(/^sha256:/, "").slice(0, 12);
