import type {
  EditorialResultsAction,
  EditorialResultsStage,
  EditorialVideoState,
} from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import {
  ACTION_LABEL,
  STAGE_LABEL,
  claimsLabel,
  decisionBlockState,
  formatSavedAt,
  formatStageDuration,
  shortHash,
  stagesOf,
  type DecisionDraft,
} from "./videoThread.logic";

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

function StageTimes({
  mode,
  durations,
}: {
  readonly mode: EditorialVideoState["thread"]["mode"];
  readonly durations: Partial<Record<EditorialResultsStage, number | null>>;
}) {
  return (
    <dl className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2 py-1 text-xs">
      {stagesOf(mode).map((stage) => (
        <div key={stage} className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">{STAGE_LABEL[stage]}</dt>
          <dd className="text-foreground tabular-nums">
            {formatStageDuration(durations[stage] ?? null)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function VersionLine({ video }: { readonly video: EditorialVideoState }) {
  const head = video.script.head;
  if (head === null) {
    return <p className="text-muted-foreground text-xs">Sin versión guardada del guion.</p>;
  }
  const claims = claimsLabel(head.claims, head.cited);
  return (
    <p className="text-muted-foreground text-xs">
      Versión <code className="text-foreground">{shortHash(head.contentHash)}</code> ·{" "}
      {formatSavedAt(head.savedAt)}
      {claims ? ` · ${claims}` : ""}
    </p>
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
}: {
  readonly video: EditorialVideoState;
  readonly draft: DecisionDraft;
  readonly refusedHash: string | null | undefined;
  /** Why the last submission stopped before reaching the server, such as a failed write. */
  readonly notice: string | null;
  readonly controls: VideoDecisionControls;
}) {
  const block = decisionBlockState(video, draft, refusedHash);

  if (block._tag === "decided") {
    const { decision } = block;
    return (
      <div className="flex flex-col gap-2 px-2.5" data-testid="video-decision-read-only">
        <p className="text-foreground text-sm">
          <span className="font-medium">{ACTION_LABEL[decision.action]}</span> · utilidad{" "}
          {decision.utility} de 5 · {formatSavedAt(decision.decidedAt)}
        </p>
        {decision.reason ? (
          <p className="text-muted-foreground text-xs">Motivo: {decision.reason}</p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {decision.scriptVersionHash === null ? (
            "Sin versión del guion."
          ) : (
            <>
              Versión decidida{" "}
              <code className="text-foreground">{shortHash(decision.scriptVersionHash)}</code>
            </>
          )}
        </p>
        <StageTimes
          mode={video.thread.mode}
          durations={{
            explore: decision.durations.exploreMs,
            read: decision.durations.readMs,
            write: decision.durations.writeMs,
            decide: decision.durations.decideMs,
          }}
        />
        <p className="text-muted-foreground text-xs">
          {decision.clockDefinitive
            ? "Reloj definitivo."
            : "Un tramo quedó sin resolver al decidir: los tiempos son un mínimo."}
        </p>
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
            {block.from === null ? "" : ` (${shortHash(block.from)})`}. No se registró la decisión.
          </span>
        </p>
        <p className="text-muted-foreground text-xs">
          {block.to === null
            ? "Leyendo la versión nueva…"
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
    return (
      <div className="flex flex-col gap-2 px-2.5" role="alert">
        <p className="flex items-start gap-1.5 text-sm text-warning-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>Resuelve el tramo abierto antes de decidir.</span>
        </p>
        <p className="text-muted-foreground text-xs">
          La decisión guarda los tiempos por etapa tal como están; un tramo sin resolver no cuenta.
        </p>
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          onClick={() => controls.onGoToResolution(block.intervalId)}
        >
          Ir a la resolución
        </Button>
      </div>
    );
  }

  const durations = Object.fromEntries(
    video.clock.stages.map((entry) => [entry.stage, entry.activeMs]),
  ) as Partial<Record<EditorialResultsStage, number>>;
  return (
    <form
      className="flex flex-col gap-2.5 px-2.5"
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
      <StageTimes mode={video.thread.mode} durations={durations} />
      <VersionLine video={video} />
      <ToggleGroup
        aria-label="Acción"
        size="sm"
        value={draft.action === null ? [] : [draft.action]}
        onValueChange={(values) => {
          const action = ACTIONS.find((candidate) => candidate === values[0]) ?? null;
          controls.onDraftChange({ ...draft, action });
        }}
      >
        {ACTIONS.map((action) => (
          <Toggle key={action} value={action}>
            {ACTION_LABEL[action]}
          </Toggle>
        ))}
      </ToggleGroup>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs" id="video-decision-utility">
          Utilidad
        </span>
        <ToggleGroup
          aria-labelledby="video-decision-utility"
          size="sm"
          value={draft.utility === null ? [] : [String(draft.utility)]}
          onValueChange={(values) => {
            const utility = UTILITIES.find((value) => String(value) === values[0]) ?? null;
            controls.onDraftChange({ ...draft, utility });
          }}
        >
          {UTILITIES.map((utility) => (
            <Toggle key={utility} value={String(utility)} aria-label={`Utilidad ${utility}`}>
              {utility}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <Textarea
        size="sm"
        aria-label="Motivo"
        placeholder={
          draft.action === "accept"
            ? "Motivo (opcional)"
            : "Motivo (obligatorio para editar o rechazar)"
        }
        maxLength={2000}
        value={draft.reason}
        onChange={(event) =>
          controls.onDraftChange({ ...draft, reason: event.currentTarget.value })
        }
      />
      {block.problem ? <p className="text-muted-foreground text-xs">{block.problem}</p> : null}
      {notice ? (
        <p role="alert" className="text-warning-foreground text-xs">
          {notice}
        </p>
      ) : null}
      <Button
        type="submit"
        size="xs"
        className="self-start"
        disabled={block.problem !== null || controls.busy}
      >
        Registrar decisión
      </Button>
      <p className="text-muted-foreground text-xs">
        Queda grabado: acción, utilidad, motivo, tiempo por etapa y versión del guion. El agente no
        puede tocar este registro.
      </p>
    </form>
  );
}
