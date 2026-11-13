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
  modelIsReady,
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
            {/* Middle dots instead of a parenthesis: no closing mark can end up alone on a line. */}
            Listo · <span className="whitespace-nowrap">revisión {phase.revision}</span> ·{" "}
            <span className="whitespace-nowrap">{formatMiB(phase.bytes)} MiB</span> ·{" "}
            <span className="inline-block max-w-full font-mono [overflow-wrap:anywhere]">
              {phase.location}
            </span>
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

/** The model's pushed state and the request that downloads it, for a card or a row. */
export function useModelDownload(environmentId: EnvironmentId) {
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
  const onDownload = () => {
    setStarting(true);
    setRequestError(null);
    void prepare({ environmentId, input: {} }).then((answer) => {
      setStarting(false);
      if (answer._tag === "Failure") setRequestError(requestErrorText(answer));
    });
  };
  return {
    state,
    ready: modelIsReady(state),
    starting,
    requestError: requestError ?? subscriptionError,
    onDownload,
  };
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
  const model = useModelDownload(environmentId);
  const ready = model.ready;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the wizard learns from the pushed model state whether it may continue.
  useEffect(() => {
    onReady(ready);
  }, [onReady, ready]);
  return (
    <ModelDownloadCardView
      state={model.state}
      starting={model.starting}
      requestError={model.requestError}
      onDownload={model.onDownload}
      {...(bare === undefined ? {} : { bare })}
    />
  );
}

/**
 * The model as one row: «Modelo local», what it is doing, and its action or «Listo»; the
 * progress bar under it while it downloads. The wizard's last step and the empty inbox use it.
 */
export function ModelRowView({
  state,
  starting,
  requestError,
  onDownload,
}: ModelDownloadCardViewProps) {
  const phase = modelCardPhase(state);
  const failed =
    requestError !== null
      ? { text: requestError, hint: null }
      : phase._tag === "failed"
        ? { text: phase.text, hint: phase.hint }
        : null;
  const status = (() => {
    if (failed !== null) return `Error: ${failed.text}`;
    switch (phase._tag) {
      case "checking":
        return "Comprobando…";
      case "verifying":
        return "Comprobando los archivos descargados…";
      case "missing":
        return phase.bytesPresent > 0
          ? `Descarga a medias: ${formatMiB(phase.bytesPresent)} de ${formatMiB(phase.bytesExpected)} MiB`
          : `Falta descargarlo: ${formatMiB(phase.bytesExpected)} MiB`;
      case "downloading":
        return [
          `Descargando… ${formatMiB(phase.bytesDone)} de ${formatMiB(phase.bytesTotal)} MiB`,
          remainingText(phase.bytesTotal - phase.bytesDone, phase.bytesPerSecond),
        ]
          .filter(Boolean)
          .join(" · ");
      case "ready":
        return `${formatMiB(phase.bytes)} MiB, descargado`;
      case "failed":
        return "";
    }
  })();
  const action =
    failed !== null ? (
      <Button size="sm" variant="outline" disabled={starting} onClick={onDownload}>
        {starting ? <Spinner size="sm" /> : null}
        Reintentar
      </Button>
    ) : phase._tag === "missing" ? (
      <Button size="sm" disabled={starting} onClick={onDownload}>
        {starting ? <Spinner size="sm" /> : null}
        {phase.bytesPresent > 0 ? "Continuar descarga" : "Descargar"}
      </Button>
    ) : phase._tag === "ready" ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-success-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        Listo
      </span>
    ) : phase._tag === "checking" || phase._tag === "verifying" ? (
      <Spinner size="sm" />
    ) : null;
  return (
    <div className="flex flex-col gap-2" data-testid="model-row" data-phase={phase._tag}>
      <div className="flex flex-col gap-2 rounded-lg border bg-background px-3.5 py-2.5">
        <div className="flex min-h-7 items-center gap-3">
          <span className="w-28 shrink-0 text-sm text-foreground">Modelo local</span>
          <span
            role="status"
            className={`min-w-0 flex-1 text-xs tabular-nums ${failed !== null ? "text-destructive-foreground" : "text-muted-foreground"}`}
          >
            {status}
          </span>
          {action === null ? null : <span className="shrink-0">{action}</span>}
        </div>
        {phase._tag === "downloading" || phase._tag === "verifying" ? (
          <progress
            aria-label="Descarga del modelo"
            className={PROGRESS_CLASS}
            value={phase._tag === "downloading" ? phase.bytesDone : 1}
            max={phase._tag === "downloading" ? Math.max(phase.bytesTotal, 1) : 1}
          />
        ) : null}
      </div>
      {failed?.hint ? <p className="text-xs text-muted-foreground">{failed.hint}</p> : null}
      {phase._tag === "ready" ? null : (
        <p className="text-xs text-muted-foreground">
          Agrupa las publicaciones en tu equipo. Se descarga una sola vez.
        </p>
      )}
    </div>
  );
}
