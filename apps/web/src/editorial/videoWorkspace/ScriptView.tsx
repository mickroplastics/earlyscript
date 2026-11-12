import { parseScript } from "@earlyscript/editorial-script";
import { ChevronLeftIcon, ChevronRightIcon, PenLineIcon, StickyNoteIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { operatorNoteOf, type NumberedSource, type ScriptNotice } from "./videoWorkspace.logic";

const TOKEN = /\[[^\]\n]+\]|\{\{[^{}]*\}\}/g;

/** Prose with its source numbers as buttons and its blanks as amber marks. */
function Inline({
  text,
  numbers,
  onOpenSource,
}: {
  readonly text: string;
  readonly numbers: ReadonlyMap<string, number>;
  readonly onOpenSource: (id: string) => void;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    if (raw.startsWith("{{")) {
      parts.push(text.slice(cursor, match.index));
      parts.push(
        <mark
          key={match.index}
          className="rounded bg-warning/16 px-1 font-mono text-xs text-warning-foreground"
        >
          {raw}
        </mark>,
      );
      cursor = match.index + raw.length;
      continue;
    }
    const ids = raw
      .slice(1, -1)
      .split(",")
      .map((token) => token.trim());
    if (!ids.every((id) => numbers.has(id))) continue;
    // The number sits against its word, as in print.
    parts.push(text.slice(cursor, match.index).replace(/\s+$/, ""));
    parts.push(
      <sup key={match.index} className="ms-0.5 leading-none">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            className="rounded px-px font-semibold text-2xs text-primary leading-none hover:bg-primary/16 focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Fuente ${numbers.get(id)}`}
            onClick={() => onOpenSource(id)}
          >
            {numbers.get(id)}
          </button>
        ))}
      </sup>,
    );
    cursor = match.index + raw.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * The script as it will be read: sections, sentences with their source numbers, blanks and
 * notes to self marked in amber, and the paragraphs that cite the open source lit up.
 */
export function ScriptView({
  contents,
  sources,
  notices,
  uncited,
  activeNoticeLine,
  highlightSource,
  activeOccurrenceLine,
  onOpenSource,
}: {
  readonly contents: string;
  readonly sources: ReadonlyArray<NumberedSource>;
  readonly notices: ReadonlyArray<ScriptNotice>;
  /** `line|sentence` of the sentences the verifier found without a source number. */
  readonly uncited: ReadonlySet<string>;
  readonly activeNoticeLine: number | null;
  readonly highlightSource: string | null;
  readonly activeOccurrenceLine: number | null;
  readonly onOpenSource: (id: string) => void;
}) {
  const sections = parseScript(contents).sections.filter((s) => s.kind !== "sources");
  const numbers = new Map(sources.map((source) => [source.id, source.number]));
  const lit = new Set(sources.find((source) => source.id === highlightSource)?.occurrences ?? []);
  const noticeLines = new Set(notices.map((notice) => notice.line));
  return (
    <article
      data-thread-map-script
      aria-label="Guion"
      lang="en"
      className="flex flex-col gap-7 text-base leading-7"
    >
      {sections.map((section) => (
        <section key={section.line} className="flex flex-col gap-2.5">
          <h2 className="font-semibold text-lg tracking-tight">{section.heading}</h2>
          {section.paragraphs.map((paragraph) => {
            const note = operatorNoteOf(paragraph.text);
            const active = paragraph.line === activeNoticeLine;
            if (note !== null) {
              return (
                <aside
                  key={paragraph.line}
                  data-line={paragraph.line}
                  lang="en"
                  className={cn(
                    "flex scroll-mt-24 gap-2.5 rounded-md border border-warning/32 bg-warning-surface px-3 py-2 text-sm leading-6",
                    active && "ring-2 ring-warning/60",
                  )}
                >
                  <StickyNoteIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-warning" />
                  <span>
                    <span lang="es" className="me-1.5 font-medium text-warning-foreground text-xs">
                      Nota para ti
                    </span>
                    <Inline text={note} numbers={numbers} onOpenSource={onOpenSource} />
                  </span>
                </aside>
              );
            }
            let cursor = 0;
            const pieces: ReactNode[] = [];
            for (const claim of paragraph.claims) {
              const start = paragraph.text.indexOf(claim.text, cursor);
              if (start < 0) continue;
              pieces.push(
                <Inline
                  key={`t${cursor}`}
                  text={paragraph.text.slice(cursor, start)}
                  numbers={numbers}
                  onOpenSource={onOpenSource}
                />,
              );
              const missing = uncited.has(`${claim.line}|${claim.text}`);
              pieces.push(
                missing ? (
                  <Tooltip key={`c${start}`}>
                    <TooltipTrigger
                      render={
                        <span className="underline decoration-muted-foreground/50 decoration-dotted underline-offset-4" />
                      }
                    >
                      <Inline text={claim.text} numbers={numbers} onOpenSource={onOpenSource} />
                    </TooltipTrigger>
                    <TooltipPopup>
                      Sin número de fuente. Puede estar bien: no toda frase necesita una.
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  <Inline
                    key={`c${start}`}
                    text={claim.text}
                    numbers={numbers}
                    onOpenSource={onOpenSource}
                  />
                ),
              );
              cursor = start + claim.text.length;
            }
            pieces.push(
              <Inline
                key="rest"
                text={paragraph.text.slice(cursor)}
                numbers={numbers}
                onOpenSource={onOpenSource}
              />,
            );
            const highlighted = lit.has(paragraph.line);
            return (
              <p
                key={paragraph.line}
                data-line={paragraph.line}
                className={cn(
                  "-mx-3 scroll-mt-24 whitespace-pre-wrap rounded-md border-s-2 border-transparent px-3 py-0.5",
                  noticeLines.has(paragraph.line) && "border-warning/70",
                  highlighted && "border-primary bg-primary/8",
                  active && "bg-warning/10 ring-1 ring-warning/50",
                  highlighted &&
                    paragraph.line === activeOccurrenceLine &&
                    "ring-1 ring-primary/60",
                )}
              >
                {pieces}
              </p>
            );
          })}
        </section>
      ))}
    </article>
  );
}

const NOTICE_KIND: Readonly<Record<ScriptNotice["kind"], string>> = {
  hole: "Hueco por rellenar",
  operator: "Nota para ti",
};

/**
 * What needs attention before recording, with previous and next. The verifier's sentences
 * without a source number follow in a quiet line: a count, not a verdict.
 */
export function NoticeBar({
  notices,
  activeIndex,
  onGo,
  verifier,
}: {
  readonly notices: ReadonlyArray<ScriptNotice>;
  readonly activeIndex: number | null;
  readonly onGo: (index: number) => void;
  readonly verifier: { readonly claims: number; readonly uncited: number } | null;
}) {
  const count = notices.length;
  const index = activeIndex ?? -1;
  const current = index >= 0 ? notices[index] : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {count > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/32 bg-warning-surface px-3 py-2">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-warning-foreground">
              {count === 1 ? "1 aviso" : `${count} avisos`}
            </span>{" "}
            <span className="text-muted-foreground">
              {current
                ? `· ${NOTICE_KIND[current.kind]}${current.kind === "hole" ? ` «${current.text}»` : ""}`
                : "· huecos y notas para rellenar antes de grabar"}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Aviso anterior"
              onClick={() => onGo(index <= 0 ? count - 1 : index - 1)}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            {index >= 0 ? (
              <span className="min-w-12 text-center text-warning-foreground text-xs tabular-nums">
                {index + 1} de {count}
              </span>
            ) : (
              <Button size="xs" variant="ghost-muted" onClick={() => onGo(0)}>
                Recorrer
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Aviso siguiente"
              onClick={() => onGo(index >= count - 1 ? 0 : index + 1)}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
      {verifier && verifier.claims > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={<p className="self-start text-muted-foreground text-xs" tabIndex={0} />}
          >
            Revisión de referencias: {verifier.uncited} de {verifier.claims} frases sin número de
            fuente{verifier.uncited > 0 ? ", subrayadas con puntos" : ""}.
          </TooltipTrigger>
          <TooltipPopup className="max-w-72">
            Cuenta las frases sin número de fuente. No comprueba que la fuente diga lo mismo que la
            frase, y no toda frase necesita una fuente.
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** The parts the script will have, as quiet lines; one is marked while the agent writes. */
function PartsSkeleton({ headings }: { readonly headings: ReadonlyArray<string> }) {
  return (
    <ol className="flex flex-col gap-2" aria-label="Partes del guion">
      {headings.map((heading) => (
        <li
          key={heading}
          className="flex items-center gap-4 rounded-md border border-dashed px-3 py-2.5"
        >
          <span className="w-16 shrink-0 font-medium text-sm">{heading}</span>
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-1.5 w-11/12 rounded-full bg-muted" />
            <span className="h-1.5 w-7/12 rounded-full bg-muted/70" />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Instead of an empty page: what will appear here, how, and the way to start. */
export function ScriptEmpty({
  contents,
  writing,
  onStart,
}: {
  readonly contents: string;
  readonly writing: boolean;
  /** Sends the first request; null when the operator cannot ask now. */
  readonly onStart: (() => void) | null;
}) {
  const parsed = parseScript(contents).sections.filter((s) => s.kind !== "sources");
  const headings =
    parsed.length > 0 ? parsed.map((section) => section.heading) : ["Hook", "Block 1", "Close"];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 rounded-lg border bg-card/40 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-base">
          <PenLineIcon aria-hidden className="size-4 text-primary" />
          {writing ? "El asistente está escribiendo el guion" : "Aquí se escribirá tu guion"}
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {writing
            ? "Aparecerá aquí en cuanto lo guarde. Mientras tanto puedes leer el tema y sus fuentes."
            : "El asistente lo escribe en inglés, parte por parte, con el número de su fuente junto a cada dato. Después lo revisas aquí: tocas un número para abrir la fuente y pides los cambios que quieras."}
        </p>
        {onStart && !writing ? (
          <Button size="sm" className="mt-1 self-start" onClick={onStart}>
            Pedir el primer borrador
          </Button>
        ) : null}
      </div>
      <PartsSkeleton headings={headings} />
    </div>
  );
}
