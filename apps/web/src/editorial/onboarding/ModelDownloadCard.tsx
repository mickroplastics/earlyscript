import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EditorialModelState, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { CheckCircle2Icon, CircleAlertIcon, DownloadIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  MODEL_NAME,
  editorialEngineEnvironment,
  formatMiB,
  modelCardPhase,
  remainingText,
  speedText,
} from "../engineState";

/** What the model is, in one line; the name never breaks at its hyphen. */
function ModelExplanation() {
  return (
    <p className="text-muted-foreground text-xs">
      Modelo local de embeddings <span className="whitespace-nowrap">{MODEL_NAME}</span>; las
      tendencias se agrupan en esta máquina, sin enviar textos a nadie.
    </p>
  );
}

const PROGRESS_CLASS =
  "block h-1.5 w-full appearance-none overflow-hidden rounded-full bg-foreground/12 forced-colors:border [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary forced-colors:[&::-moz-progress-bar]:bg-[Highlight] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-foreground/12 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary forced-colors:[&::-webkit-progress-value]:bg-[Highlight]";

export interface ModelDownloadCardViewProps {
  /** Null until the server's first state arrives. */
  readonly state: EditorialModelState | null;
  /** The request to start was sent and not answered yet. */
  readonly starting: boolean;
  /** Why the request itself failed (not the download), in Spanish. */
  readonly requestError: string | null;
  readonly onDownload: () => void;
  /** Without a frame, for a settings row. */
  readonly bare?: boolean;
}

function StatusLine({
  icon,
  children,
  tone = "default",
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly tone?: "default" | "error";
}) {
  return (
    <p
      role="status"
      className={`flex min-w-0 items-start gap-2 font-medium tabular-nums ${tone === "error" ? "text-destructive-foreground" : "text-foreground"}`}
    >
      <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

export function ModelDownloadCardView({
  state,
  starting,
  requestError,
  onDownload,
  bare = false,
}: ModelDownloadCardViewProps) {
  const phase = modelCardPhase(state);
  // In a settings row the buttons match the row controls around it.
  const buttonSize = bare ? "xs" : "sm";
  const failed = requestError !== null ? { text: requestError, hint: null } : null;
  const body = (() => {
    if (failed !== null || phase._tag === "failed") {
      const { text, hint } = failed ?? (phase as Extract<typeof phase, { _tag: "failed" }>);
      return (
        <>
          <StatusLine tone="error" icon={<CircleAlertIcon className="size-4" />}>
            Error: {text}
          </StatusLine>
          {hint === null ? null : (
            <p className="-mt-1.5 pl-6 text-muted-foreground text-xs">{hint}</p>
          )}
          <div>
            <Button size={buttonSize} variant="outline" disabled={starting} onClick={onDownload}>
              {starting ? <Spinner size="sm" /> : null}
              Reintentar
            </Button>
          </div>
        </>
      );
    }
    switch (phase._tag) {
      case "checking":
        return <StatusLine icon={<Spinner size="sm" />}>Comprobando el modelo…</StatusLine>;
      case "verifying":
        return (
          <>
            <StatusLine icon={<Spinner size="sm" />}>
              Comprobando los archivos descargados…
            </StatusLine>
            <progress
              aria-label="Descarga del modelo"
              className={PROGRESS_CLASS}
              value={1}
              max={1}
            />
          </>
        );
      case "missing": {
        const resumed = phase.bytesPresent > 0;
        return (
          <>
            <StatusLine icon={<DownloadIcon className="size-4 text-muted-foreground" />}>
              {resumed
                ? `Descarga a medias: ${formatMiB(phase.bytesPresent)} de ${formatMiB(phase.bytesExpected)} MiB`
                : `Falta el modelo (${formatMiB(phase.bytesExpected)} MiB)`}
            </StatusLine>
            <div>
              <Button size={buttonSize} disabled={starting} onClick={onDownload}>
                {starting ? <Spinner size="sm" /> : null}
                {resumed ? "Continuar descarga" : "Descargar"}
              </Button>
            </div>
          </>
        );
      }
      case "downloading": {
        const speed = phase.bytesPerSecond;
        const detail = [
          speed === null ? "midiendo velocidad" : speedText(speed),
          remainingText(phase.bytesTotal - phase.bytesDone, speed),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <>
            <StatusLine icon={<Spinner size="sm" />}>
              Descargando… {formatMiB(phase.bytesDone)} de {formatMiB(phase.bytesTotal)} MiB
            </StatusLine>
            <progress
              aria-label="Descarga del modelo"
              className={PROGRESS_CLASS}
              value={phase.bytesDone}
              max={Math.max(phase.bytesTotal, 1)}
            />
            <p className="min-h-4 text-muted-foreground text-xs tabular-nums">{detail}</p>
          </>
        );
      }
      case "ready":
        return (
          <StatusLine icon={<CheckCircle2Icon className="size-4 text-success-foreground" />}>
            Listo (revisión {phase.revision},{" "}
            <span className="whitespace-nowrap">{formatMiB(phase.bytes)} MiB</span> en{" "}
            <span className="inline-block max-w-full font-mono [overflow-wrap:anywhere]">
              {phase.location}
            </span>
            )
          </StatusLine>
        );
    }
  })();
  return (
    <div
      className={`flex min-w-0 flex-col gap-2.5 text-sm ${bare ? "mt-2 pb-2.5" : "rounded-lg border bg-card p-4"}`}
    >
      {body}
      <ModelExplanation />
    </div>
  );
}

function requestErrorText(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag === "Success") return "";
  if (isAtomCommandInterrupted(result)) return "se canceló la solicitud.";
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "reason" in error) {
    if (error.reason === "unavailable") {
      return "los servicios editoriales no están montados en este servidor.";
    }
  }
  return "el servidor no respondió.";
}

/**
 * The local embedding model: missing (with «Descargar»), downloading with progress, failed
 * (with «Reintentar») or ready. `onReady` follows whether the model is on disk.
 */
export function ModelDownloadCard({
  environmentId,
  onReady,
  bare,
}: {
  readonly environmentId: EnvironmentId;
  readonly onReady: (ready: boolean) => void;
  readonly bare?: boolean;
}) {
  const result = useAtomValue(editorialEngineEnvironment.model({ environmentId, input: {} }));
  const prepare = useAtomCommand(editorialEngineEnvironment.prepareModel, {
    reportFailure: false,
  });
  const [starting, setStarting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const state = AsyncResult.getOrElse(result, () => null);
  const subscriptionError =
    state === null && AsyncResult.isFailure(result)
      ? "no se pudo leer el estado del modelo en el servidor."
      : null;
  const ready = state?.status === "ready" && state.download === null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the wizard learns from the pushed model state whether it may continue.
  useEffect(() => {
    onReady(ready);
  }, [onReady, ready]);
  const onDownload = () => {
    setStarting(true);
    setRequestError(null);
    void prepare({ environmentId, input: {} }).then((answer) => {
      setStarting(false);
      if (answer._tag === "Failure") setRequestError(requestErrorText(answer));
    });
  };
  return (
    <ModelDownloadCardView
      state={state}
      starting={starting}
      requestError={requestError ?? subscriptionError}
      onDownload={onDownload}
      {...(bare === undefined ? {} : { bare })}
    />
  );
}
