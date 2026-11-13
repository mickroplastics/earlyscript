import type {
  EditorialResultsAction,
  EditorialResultsStage,
  EditorialVideoState,
} from "@t3tools/contracts";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import {
  ACTION_LABEL,
  STAGE_LABEL,
  decisionBlockState,
  formatStageDuration,
  shortHash,
  stagesOf,
  type DecisionDraft,
} from "./videoThread.logic";
import {
  STEP_TITLE,
  UTILITY_ANCHOR,
  dateAndTime,
  stageSumNote,
  timeOfDay,
} from "./videoWorkspace/videoWorkspace.logic";

const ACTIONS: ReadonlyArray<EditorialResultsAction> = ["accept", "edit", "reject"];
const UTILITIES = [1, 2, 3, 4, 5] as const;

export interface VideoDecisionControls {
  readonly busy: boolean;
  readonly onDraftChange: (draft: DecisionDraft) => void;
  /** Records the draft against `versionHash`, the version shown to the operator. */
  readonly onSubmit: (versionHash: string | null) => void;
  /** Back to the form after a refusal, now on the version the server holds. */
  readonly onReviewNewVersion: () => void;
  /** The operator turned to the block: the clock moves to Decidir if another stage runs. */
  readonly onEngage: () => void;
  /** Takes the operator to the form that resolves a recovered segment. */
  readonly onGoToResolution: (intervalId: string) => void;
}

const ACTION_HINT: Readonly<Record<EditorialResultsAction, string>> = {
  accept: "Lo uso tal como está.",
  edit: "Lo uso con cambios míos.",
  reject: "No lo uso.",
};

const DECIDED_TITLE: Readonly<Record<EditorialResultsAction, string>> = {
  accept: "Aceptaste este guion",
  edit: "Editaste este guion",
  reject: "Rechazaste este guion",
};

/** The time each stage took, with the total and what the figures mean. */
function StageTimes({
  mode,
  durations,
  totalMs,
  definitive,
}: {
  readonly mode: EditorialVideoState["thread"]["mode"];
  readonly durations: Partial<Record<EditorialResultsStage, number | null>>;
  readonly totalMs: number | null;
  readonly definitive: boolean;
}) {
  const stages = stagesOf(mode);
  const sumNote = stageSumNote(
    stages.map((stage) => durations[stage] ?? null),
    totalMs,
  );
  return (
    <section
      aria-label="Tiempo por paso"
      className="flex flex-col gap-2 rounded-lg border bg-card/40 p-3"
    >
      <h4 className="font-medium text-2xs text-muted-foreground uppercase tracking-wider">
        Tu tiempo por paso
      </h4>
      <dl className="flex flex-col text-sm">
        {stages.map((stage, index) => (
          <div key={stage} className="flex items-baseline justify-between gap-2 py-0.5">
            <dt className="text-muted-foreground">
              {index + 1} · {stepLabel(mode, stage)}
            </dt>
            <dd className="text-foreground tabular-nums">
              {formatStageDuration(durations[stage] ?? null)}
            </dd>
          </div>
        ))}
        <div className="mt-1 flex items-baseline justify-between gap-2 border-t pt-1.5 font-medium">
          <dt>Total</dt>
          <dd className="tabular-nums">{formatStageDuration(totalMs)}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {definitive
          ? "Tiempo activo, sin pausas. Medición completa: cuenta en Resultados."
          : "Un tramo quedó sin resolver al decidir: los tiempos son un mínimo."}
        {sumNote ? ` ${sumNote}` : ""}
      </p>
    </section>
  );
}

function stepLabel(mode: EditorialVideoState["thread"]["mode"], stage: EditorialResultsStage) {
  return mode === "assisted" ? STEP_TITLE[stage] : STAGE_LABEL[stage];
}

function versionText(video: EditorialVideoState, plainVersion: boolean): string {
  const head = video.script.head;
  if (head === null) return "sin versión guardada";
  return `versión ${plainVersion ? video.script.versionCount : shortHash(head.contentHash)}`;
}

function DecisionChoice({
  label,
  hint,
  pressed,
  onPress,
}: {
  readonly label: string;
  readonly hint: string;
  readonly pressed: boolean;
  readonly onPress: () => void;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={hintId}
      aria-pressed={pressed}
      onClick={onPress}
      className={cn(
        "flex min-w-0 flex-col items-start gap-0.5 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        pressed
          ? "border-primary bg-primary/8 text-foreground"
          : "border-border hover:border-foreground/24 hover:bg-accent/40",
      )}
    >
      <span className={cn("font-medium text-sm", pressed && "text-primary")}>{label}</span>
      <span id={hintId} className="text-muted-foreground text-xs leading-snug">
        {hint}
      </span>
    </button>
  );
}

/**
 * The decision block of a video thread: action, utility 1 to 5 and reason, recorded against
 * the script version on screen. The server refuses when the script moved on; the block then
 * names both versions and asks the operator to look at the new one. Read-only once decided.
 */
export function VideoDecisionPanel({
  video,
  draft,
  refusedHash,
  notice,
  controls,
  plainVersion = false,
  pending = [],
}: {
  readonly plainVersion?: boolean;
  /** What still needs attention before recording, such as blanks left in the script. */
  readonly pending?: ReadonlyArray<string>;
  readonly video: EditorialVideoState;
  readonly draft: DecisionDraft;
  readonly refusedHash: string | null | undefined;
  /** Why the last submission stopped before reaching the server, such as a failed write. */
  readonly notice: string | null;
  readonly controls: VideoDecisionControls;
}) {
  const block = decisionBlockState(video, draft, refusedHash);
  const utilityId = useId();
  const reasonId = useId();

  if (block._tag === "decided") {
    const { decision } = block;
    const anchor = UTILITY_ANCHOR[decision.utility];
    return (
      <div className="flex flex-col gap-3" data-testid="video-decision-read-only">
        <section className="flex flex-col gap-2 rounded-lg border border-success/32 bg-success/6 p-3.5">
          <h3 className="flex items-center gap-1.5 font-semibold text-base">
            <CheckIcon aria-hidden className="size-4 text-success" />
            {DECIDED_TITLE[decision.action]}
          </h3>
          <p className="text-sm">
            Lo calificaste {decision.utility} de 5{anchor ? `: «${anchor}»` : ""}.
          </p>
          {decision.reason ? (
            <blockquote className="border-success/40 border-s-2 bg-background/40 px-3 py-2 text-sm text-muted-foreground">
              {decision.reason}
            </blockquote>
          ) : (
            <p className="text-muted-foreground text-xs">Sin motivo escrito.</p>
          )}
          <p className="text-muted-foreground text-xs">
            Registrado el {dateAndTime(decision.decidedAt)}
            {decision.scriptVersionHash === null
              ? ", sin versión del guion."
              : plainVersion
                ? ", con la versión guardada del guion."
                : `, con la versión ${shortHash(decision.scriptVersionHash)} del guion.`}
          </p>
        </section>
        <StageTimes
          mode={video.thread.mode}
          durations={{
            explore: decision.durations.exploreMs,
            read: decision.durations.readMs,
            write: decision.durations.writeMs,
            decide: decision.durations.decideMs,
          }}
          totalMs={decision.durations.totalMs}
          definitive={decision.clockDefinitive}
        />
      </div>
    );
  }

  if (block._tag === "version-changed") {
    return (
      <div className="flex flex-col gap-2 px-2.5" role="alert">
        <p className="flex items-start gap-1.5 text-sm text-warning-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            El guion cambió después de la versión que leíste
            {block.from === null || plainVersion ? "" : ` (${shortHash(block.from)})`}. No se
            registró la decisión.
          </span>
        </p>
        <p className="text-muted-foreground text-xs">
          {block.to === null
            ? "Leyendo la versión nueva…"
            : plainVersion
              ? "El guion cambió. Revísalo antes de decidir."
              : `Versión actual: ${shortHash(block.to)}. Revísala en el guion antes de decidir.`}
        </p>
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          disabled={block.to === null || controls.busy}
          onClick={controls.onReviewNewVersion}
        >
          Decidir sobre la versión nueva
        </Button>
      </div>
    );
  }

  if (block._tag === "unresolved") {
    const interval = video.clock.unresolved.find((entry) => entry.intervalId === block.intervalId);
    return (
      <section
        role="alert"
        className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-surface p-3.5"
      >
        <h3 className="font-semibold text-base">Resuelve el tramo abierto antes de decidir.</h3>
        <p className="text-sm">
          La app se cerró con el reloj en marcha
          {interval ? ` en «${stepLabel(video.thread.mode, interval.stage)}»` : ""}. No se sabe
          cuánto de ese tramo fue trabajo.
        </p>
        {interval ? (
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Empezó</dt>
            <dd className="tabular-nums">{timeOfDay(interval.startedAt)}</dd>
            {interval.recoveredAt ? (
              <>
                <dt className="text-muted-foreground">Detectado</dt>
                <dd className="tabular-nums">
                  {timeOfDay(interval.recoveredAt)}, al volver a abrirse la app
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <p className="text-muted-foreground text-xs leading-relaxed">
          Hasta que indiques la hora en que dejaste de trabajar, no se puede registrar la decisión.
          Lo ya medido no se pierde.
        </p>
        <Button
          size="sm"
          variant="warning-outline"
          className="self-start"
          onClick={() => controls.onGoToResolution(block.intervalId)}
        >
          Ir a la resolución
        </Button>
      </section>
    );
  }

  const reasonRequired = draft.action !== null && draft.action !== "accept";
  return (
    <form
      className="flex flex-col gap-4"
      aria-label="Decisión"
      onFocusCapture={controls.onEngage}
      onPointerDownCapture={controls.onEngage}
      onClickCapture={controls.onEngage}
      onKeyDownCapture={controls.onEngage}
      onSubmit={(event) => {
        event.preventDefault();
        if (block.problem === null) controls.onSubmit(block.versionHash);
      }}
    >
      <h3 className="font-semibold text-base">¿Qué haces con este guion?</h3>
      {pending.length > 0 ? (
        <section
          aria-label="Antes de decidir"
          className="flex flex-col gap-1 rounded-lg border border-warning/32 bg-warning-surface px-3 py-2.5 text-sm"
        >
          <h4 className="font-medium text-warning-foreground">Antes de decidir, ten en cuenta</h4>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {pending.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-warning" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div role="group" aria-label="Acción" className="grid grid-cols-3 gap-2">
        {ACTIONS.map((action) => (
          <DecisionChoice
            key={action}
            label={ACTION_LABEL[action]}
            hint={ACTION_HINT[action]}
            pressed={draft.action === action}
            onPress={() => controls.onDraftChange({ ...draft, action })}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h4 className="font-medium text-sm" id={utilityId}>
            ¿Qué tan útil es este guion?
          </h4>
          <span className="text-muted-foreground text-xs">Califica el guion, no la idea.</span>
        </div>
        <div role="group" aria-labelledby={utilityId} className="grid grid-cols-5 gap-1.5">
          {UTILITIES.map((utility) => {
            const pressed = draft.utility === utility;
            return (
              <button
                key={utility}
                type="button"
                aria-label={`Utilidad ${utility}`}
                aria-pressed={pressed}
                onClick={() => controls.onDraftChange({ ...draft, utility })}
                className={cn(
                  "flex min-w-0 flex-col items-center gap-0.5 rounded-lg border px-1 py-2 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  pressed
                    ? "border-primary bg-primary/8 text-primary"
                    : "border-border hover:border-foreground/24 hover:bg-accent/40",
                )}
              >
                <span className="font-semibold text-base tabular-nums">{utility}</span>
                <span
                  className={cn(
                    "text-2xs leading-tight",
                    pressed ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {UTILITY_ANCHOR[utility]}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-baseline gap-2" htmlFor={reasonId}>
          <span className="font-medium text-sm">¿Por qué?</span>
          <span
            className={cn(
              "text-xs",
              reasonRequired ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {draft.action === null
              ? "Opcional al aceptar; obligatorio para editar o rechazar"
              : reasonRequired
                ? "Obligatorio"
                : "Opcional"}
          </span>
        </label>
        <Textarea
          id={reasonId}
          aria-label="Motivo"
          placeholder="Lo que te hizo decidir, en tus palabras."
          maxLength={2000}
          value={draft.reason}
          onChange={(event) =>
            controls.onDraftChange({ ...draft, reason: event.currentTarget.value })
          }
        />
      </div>
      {notice ? (
        <p role="alert" className="text-warning-foreground text-xs">
          {notice}
        </p>
      ) : null}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 bg-background/95 px-1 py-3 backdrop-blur-sm">
        <Button type="submit" disabled={block.problem !== null || controls.busy}>
          Registrar decisión
        </Button>
        <span className="min-w-0 flex-1 text-muted-foreground text-xs leading-snug">
          {block.problem ??
            `Se guarda con el guion (${versionText(video, plainVersion)}) y tu tiempo por paso. No se modifica después.`}
        </span>
      </div>
    </form>
  );
}
