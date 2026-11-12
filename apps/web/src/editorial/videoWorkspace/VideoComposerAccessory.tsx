import { ArrowRightIcon, CheckIcon } from "lucide-react";
import { createContext, use } from "react";

import { cn } from "../../lib/utils";

/**
 * What the composer of an assisted video thread offers above its box: a welcome before the
 * first message, then suggestions that fit the moment. Provided by the video workspace; any
 * other thread has no provider and the accessory renders nothing.
 */
export interface VideoComposerOffer {
  readonly phase: "welcome" | "no-draft" | "drafted";
  /** Evidence items in the dossier the agent reads; null until the dossier loads. */
  readonly evidenceTotal: number | null;
  readonly send: (text: string) => void;
}

export const VideoComposerContext = createContext<VideoComposerOffer | null>(null);

const WELCOME = [
  {
    title: "Escribe el primer borrador",
    hint: "Con el ángulo que propone la ficha del tema.",
    text: "Escribe el primer borrador del guion con el ángulo que propone la ficha del tema.",
  },
  {
    title: "Propón tres ganchos antes de escribir",
    hint: "Eliges uno y después escribe el resto.",
    text: "Antes de escribir el borrador, propón tres ganchos distintos para este video, cada uno con su fuente. No escribas aún el guion.",
  },
  {
    title: "¿Qué fuentes son las más sólidas?",
    hint: "Te responde sin escribir el guion todavía.",
    text: "¿Qué fuentes del expediente son las más sólidas para este video y qué no conviene afirmar con ellas? No escribas aún el guion.",
  },
] as const;

const NO_DRAFT = [
  { title: "Escribe ya el primer borrador", text: "Escribe ya el primer borrador del guion." },
] as const;

const DRAFTED = [
  {
    title: "Revisa los huecos y las notas",
    text: "Revisa los huecos {{…}} y las notas OPERATOR del guion y dime qué tengo que preparar antes de grabar.",
  },
  {
    title: "¿Qué falta antes de grabar?",
    text: "¿Qué falta comprobar antes de grabar este guion? No cambies el guion todavía.",
  },
  { title: "Acorta el Hook", text: "Acorta el Hook sin perder su fuente." },
] as const;

/** Mounted once in `ChatView.tsx`, above the composer; renders nothing outside a video thread. */
export function VideoComposerAccessory() {
  const offer = use(VideoComposerContext);
  if (offer === null) return null;
  if (offer.phase === "welcome") {
    return (
      <div
        className="flex flex-col gap-3 overflow-y-auto pb-3"
        // Room for the composer below and the tabs above, on a 800 px high window too.
        style={{ maxHeight: "calc(100dvh - 22rem)" }}
        data-thread-map-script
        data-video-welcome
      >
        <ul
          aria-label="El asistente ya tiene"
          className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg border bg-card/60 px-3 py-2 text-muted-foreground text-xs"
        >
          {[
            "La ficha del tema",
            offer.evidenceTotal === null
              ? "Sus fuentes, numeradas como aquí"
              : `Sus ${offer.evidenceTotal} fuentes, numeradas como aquí`,
            "El archivo del guion",
          ].map((line) => (
            <li key={line} className="flex items-center gap-1.5">
              <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
              {line}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-lg">¿Cómo quieres comenzar?</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            El asistente escribe el guion en inglés, con una cita por dato; tú lo revisas y lo
            decides. Tu primer mensaje empieza el paso 2. Una sugerencia se envía al tocarla.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          {WELCOME.map((option, index) => (
            <button
              key={option.title}
              type="button"
              onClick={() => offer.send(option.text)}
              className={cn(
                "group flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:border-primary/48 hover:bg-primary/6 focus-visible:outline-2 focus-visible:outline-ring",
                index === 0 && "border-primary/40 bg-primary/5",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-sm">{option.title}</span>
                <span className="block text-muted-foreground text-xs">{option.hint}</span>
              </span>
              <ArrowRightIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground group-hover:text-primary"
              />
            </button>
          ))}
        </div>
      </div>
    );
  }
  const chips = offer.phase === "drafted" ? DRAFTED : NO_DRAFT;
  return (
    <div className="flex flex-wrap gap-1.5 pb-2" data-thread-map-script aria-label="Sugerencias">
      {chips.map((chip) => (
        <button
          key={chip.title}
          type="button"
          onClick={() => offer.send(chip.text)}
          className="rounded-full border bg-background px-3 py-1 text-xs transition-colors hover:border-primary/48 hover:bg-primary/6 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {chip.title}
        </button>
      ))}
    </div>
  );
}
