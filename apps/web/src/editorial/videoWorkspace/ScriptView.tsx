import { parseScript } from "@earlyscript/editorial-script";
import { ChevronLeftIcon, ChevronRightIcon, PenLineIcon, StickyNoteIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import {
  citationKey,
  inlineTokens,
  operatorNoteOf,
  type NumberedSource,
  type ScriptNotice,
} from "./videoWorkspace.logic";

/** Where a span sits in the script, so each citation number carries its marker's key. */
interface SpanPlace {
  readonly line: number;
  /** Offset of the span in its paragraph's text. */
  readonly base: number;
}

/** Prose with its source numbers as buttons and its blanks as amber marks. */
function Inline({
  text,
  place,
  numbers,
  activeKey,
  onOpenSource,
}: {
  readonly text: string;
  readonly place: SpanPlace;
  readonly numbers: ReadonlyMap<string, number>;
  readonly activeKey: string | null;
  readonly onOpenSource: (id: string, key: string) => void;
}) {
  const tokens = inlineTokens(text);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === "text") {
          const next = tokens[index + 1];
          // The number sits against its word, as in print.
          return next?.kind === "cite" && next.ids.every((id) => numbers.has(id))
            ? token.text.replace(/\s+$/, "")
            : token.text;
        }
        if (token.kind === "hole") {
          return (
            <mark
              key={token.offset}
              className="rounded bg-warning/16 px-1 font-mono text-warning-foreground text-xs"
            >
              {token.text}
            </mark>
          );
        }
        if (!token.ids.every((id) => numbers.has(id))) {
          return text.slice(token.offset, tokens[index + 1]?.offset ?? text.length);
        }
        return (
          <sup key={token.offset} className="ms-0.5 whitespace-nowrap leading-none">
            {"\u2060"}
            {token.ids.map((id) => {
              const key = citationKey(place.line, place.base + token.offset, id);
              return (
                <button
                  key={id}
                  type="button"
                  data-cite-key={key}
                  className={cn(
                    "rounded px-px font-semibold text-2xs text-primary leading-none hover:bg-primary/16 focus-visible:outline-2 focus-visible:outline-ring",
                    key === activeKey && "bg-primary text-primary-foreground hover:bg-primary",
                  )}
                  aria-label={`Fuente ${numbers.get(id)}`}
                  onClick={() => onOpenSource(id, key)}
                >
                  {numbers.get(id)}
                </button>
              );
            })}
          </sup>
        );
      })}
    </>
  );
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
  activeCitationKey,
  onOpenSource,
}: {
  readonly contents: string;
  readonly sources: ReadonlyArray<NumberedSource>;
  readonly notices: ReadonlyArray<ScriptNotice>;
  /** `line|sentence` of the sentences the verifier found without a source number. */
  readonly uncited: ReadonlySet<string>;
  readonly activeNoticeLine: number | null;
  readonly highlightSource: string | null;
  /** The marker the citation walk is on; its number and paragraph are marked. */
  readonly activeCitationKey: string | null;
  /** The source a number names, and that number's marker. */
  readonly onOpenSource: (id: string, key: string) => void;
}) {
  const sections = parseScript(contents).sections.filter((s) => s.kind !== "sources");
  const numbers = new Map(sources.map((source) => [source.id, source.number]));
  const occurrences = sources.find((source) => source.id === highlightSource)?.occurrences ?? [];
  const lit = new Set(occurrences.map((occurrence) => occurrence.line));
  const activeLine =
    occurrences.find((occurrence) => occurrence.key === activeCitationKey)?.line ?? null;
  const noticeLines = new Set(notices.map((notice) => notice.line));
  const inlineProps = { numbers, activeKey: activeCitationKey, onOpenSource };
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
                    <Inline
                      text={note}
                      place={{ line: paragraph.line, base: paragraph.text.indexOf(note) }}
                      {...inlineProps}
                    />
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
                  place={{ line: paragraph.line, base: cursor }}
                  {...inlineProps}
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
                      <Inline
                        text={claim.text}
                        place={{ line: paragraph.line, base: start }}
                        {...inlineProps}
                      />
                    </TooltipTrigger>
                    <TooltipPopup>
                      Sin número de fuente. Puede estar bien: no toda frase necesita una.
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  <Inline
                    key={`c${start}`}
                    text={claim.text}
                    place={{ line: paragraph.line, base: start }}
                    {...inlineProps}
                  />
                ),
              );
              cursor = start + claim.text.length;
            }
            pieces.push(
              <Inline
                key="rest"
                text={paragraph.text.slice(cursor)}
                place={{ line: paragraph.line, base: cursor }}
                {...inlineProps}
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
                  paragraph.line === activeLine && "bg-primary/14",
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
 * The citation verifier's count, quiet, beside the version: a count, not a verdict. Its
 * sentences are underlined with dots in the script.
 */
export function VerifierCount({
  claims,
  uncited,
}: {
  readonly claims: number;
  readonly uncited: number;
}) {
  if (claims === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="shrink-0 underline decoration-dotted underline-offset-4" tabIndex={0} />
        }
      >
        {uncited === 0
          ? `Las ${claims} frases llevan número de fuente`
          : `${uncited} de ${claims} frases sin fuente`}
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">
        Revisión de referencias: cuenta las frases sin número de fuente, subrayadas con puntos en el
        guion. No comprueba que la fuente diga lo mismo que la frase, y no toda frase necesita una.
      </TooltipPopup>
    </Tooltip>
  );
}

/** What needs attention before recording, with previous and next. */
export function NoticeBar({
  notices,
  activeIndex,
  onGo,
}: {
  readonly notices: ReadonlyArray<ScriptNotice>;
  readonly activeIndex: number | null;
  readonly onGo: (index: number) => void;
}) {
  if (notices.length === 0) return null;
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
    </div>
  );
}

/**
 * The shape every script takes, as the validator expects it: a Hook, as many numbered blocks as
 * the topic needs, a Close. No count of blocks is promised.
 */
const SCRIPT_SHAPE = [
  { heading: "Hook", hint: "La entrada: por qué ver este video" },
  { heading: "Block 1, 2…", hint: "Un bloque por idea, cada dato con su fuente" },
  { heading: "Close", hint: "El cierre y la pregunta a la audiencia" },
] as const;

function ScriptShape() {
  return (
    <ol className="flex flex-col gap-2" aria-label="Forma del guion">
      {SCRIPT_SHAPE.map((part) => (
        <li
          key={part.heading}
          className="flex items-center gap-4 rounded-md border border-dashed px-3 py-2.5"
        >
          <span className="w-28 shrink-0 font-medium text-sm" lang="en">
            {part.heading}
          </span>
          <span className="text-muted-foreground text-sm">{part.hint}</span>
        </li>
      ))}
    </ol>
  );
}

/** Instead of an empty page: what will appear here, how, and the way to start. */
export function ScriptEmpty({
  writing,
  onStart,
}: {
  readonly writing: boolean;
  /** Sends the first request; null when the operator cannot ask now. */
  readonly onStart: (() => void) | null;
}) {
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
            : "El asistente lo escribe en inglés, con el número de su fuente junto a cada dato. Después lo revisas aquí: tocas un número para abrir la fuente y pides los cambios que quieras."}
        </p>
        {onStart && !writing ? (
          <Button size="sm" className="mt-1 self-start" onClick={onStart}>
            Pedir el primer borrador
          </Button>
        ) : null}
      </div>
      <ScriptShape />
    </div>
  );
}
