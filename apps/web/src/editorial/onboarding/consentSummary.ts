import type { SourceId } from "@earlyscript/editorial-contracts/source";

/**
 * The one-line digest of each source's row in «Tus datos». It paraphrases STORED_FIELDS for a
 * glance and stays out of `policyHash`: the hashed wording is in the row once it unfolds.
 */
export const SOURCE_DIGEST: Readonly<Record<SourceId, { name: string; stored: string }>> = {
  hn: { name: "Hacker News", stored: "Título, enlace, autor y texto" },
  github: { name: "GitHub", stored: "Nombre, enlace, propietario y descripción" },
  arxiv: { name: "arXiv", stored: "Título, enlace, primer autor y resumen" },
  huggingface: { name: "Hugging Face", stored: "Modelo, enlace, autor y ficha" },
  npm: { name: "npm", stored: "Paquete, enlace, autor y descripción" },
  wikipedia: { name: "Wikipedia", stored: "Título del artículo, enlace y visitas; nunca el texto" },
  rss: { name: "Feeds RSS", stored: "Título, enlace, autor y extracto de 500 caracteres" },
  stackexchange: { name: "Stack Exchange", stored: "Título, enlace, autor y pregunta" },
  bluesky: { name: "Bluesky", stored: "Enlace, autor y publicación" },
  lobsters: { name: "Lobsters", stored: "Título, enlace, autor y etiquetas" },
};

/** «Stack Exchange, Bluesky y Lobsters» */
export function namesList(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
}
