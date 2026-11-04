import type { EditorialEvidenceItem } from "@t3tools/contracts";
import { mapScript } from "./threadMap.logic";

export function ThreadMapScript({
  contents,
  evidence,
}: {
  readonly contents: string;
  readonly evidence: readonly EditorialEvidenceItem[];
}) {
  const script = mapScript(contents, evidence);
  function inline(text: string, line: number) {
    const markers = script.citations.filter(
      (c) => c.line >= line && c.line < line + text.split("\n").length,
    );
    const pattern = /\[[^\]\n]+\]/g;
    let offset = 0;
    const parts = [];
    for (const match of text.matchAll(pattern)) {
      const found = markers.filter((c) => c.raw === match[0]);
      if (found.length === 0) continue;
      parts.push(text.slice(offset, match.index));
      parts.push(
        <sup key={match.index}>
          {[...new Set(found.map((c) => c.id))].map((id) => {
            const source = script.sources.find((s) => s.id === id);
            return source ? (
              <a
                className="px-0.5 text-primary underline"
                key={id}
                href={`#map-source-${source.number}`}
                aria-label={`Fuente ${source.number}`}
              >
                {source.number}
              </a>
            ) : null;
          })}
        </sup>,
      );
      offset = match.index + match[0].length;
    }
    parts.push(text.slice(offset));
    return parts;
  }
  return (
    <article
      data-thread-map-script
      className="space-y-6 text-sm leading-7"
      aria-label="Guion renderizado"
    >
      {script.sections.map((section) => (
        <section key={section.line}>
          <h2 className="mb-2 font-semibold text-lg">{section.heading}</h2>
          {section.paragraphs.map((p) => (
            <p className="mb-3 whitespace-pre-wrap" key={p.line}>
              {p.claims.length === 0
                ? inline(p.text, p.line)
                : (() => {
                    let cursor = 0;
                    const parts = [];
                    for (const claim of p.claims) {
                      const start = p.text.indexOf(claim.text, cursor);
                      if (start < 0) continue;
                      parts.push(inline(p.text.slice(cursor, start), p.line));
                      parts.push(
                        <span
                          key={start}
                          className={
                            claim.citations.length === 0
                              ? "underline decoration-dotted decoration-muted-foreground/50 underline-offset-4"
                              : undefined
                          }
                          // oxlint-disable-next-line t3code/no-native-title-tooltip -- the requested dotted claim annotation uses a native title on prose, not an interactive control
                          title={claim.citations.length === 0 ? "Sin fuente marcada" : undefined}
                        >
                          {inline(claim.text, claim.line)}
                        </span>,
                      );
                      cursor = start + claim.text.length;
                    }
                    parts.push(inline(p.text.slice(cursor), p.line));
                    return parts;
                  })()}
            </p>
          ))}
        </section>
      ))}
      <section aria-label="Fuentes">
        <h2 className="font-semibold text-lg">Fuentes</h2>
        <ol className="space-y-3">
          {script.sources.map((s) => (
            <li key={s.id} id={`map-source-${s.number}`}>
              <span>{s.number}. </span>
              {s.evidence ? (
                <>
                  <a
                    href={s.evidence.permalink ?? s.evidence.externalUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {s.evidence.title}
                  </a>
                  <p className="text-muted-foreground">
                    {s.evidence.source === "hn"
                      ? "Hacker News"
                      : s.evidence.source === "github"
                        ? "GitHub"
                        : s.evidence.source}{" "}
                    · {s.evidence.publishedAt.slice(0, 10)}
                  </p>
                </>
              ) : (
                "Fuente no encontrada en el expediente"
              )}
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
