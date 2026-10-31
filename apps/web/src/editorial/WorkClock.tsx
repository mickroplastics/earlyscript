import type {
  EditorialResultsStage,
  EditorialVideoState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  PauseIcon,
  PlayIcon,
  TimerIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowSecond } from "../hooks/useNowSecond";
import { cn } from "../lib/utils";
import { useScriptAutoVersion, useThreadWorkspaceRoot, useVideoCommands } from "./videoCommands";
import {
  STAGE_LABEL,
  formatClock,
  interpolateClock,
  restartStage,
  stagesOf,
} from "./videoThread.logic";
import { useVideoThread } from "./videoState";

interface WorkClockControls {
  readonly busy: boolean;
  readonly onPause: (reason: string) => void;
  readonly onResume: () => void;
  readonly onStart: (stage: EditorialResultsStage) => void;
  readonly onStage: (stage: EditorialResultsStage) => void;
}

/**
 * The work clock of a video thread, top right of the thread header. The server keeps the
 * segments; this shows its summary moved forward by the client's own seconds. Stops for good
 * at the decision.
 */
function WorkClockView({
  video,
  receivedAtMs,
  nowMs,
  controls,
}: {
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly controls: WorkClockControls;
}) {
  const { clock } = video;
  const { activeMs } = interpolateClock(clock, receivedAtMs, nowMs);
  const time = formatClock(activeMs);
  const decided = video.decision !== null;
  const state = clock.state;

  if (decided) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="timer"
              aria-label={`Reloj definitivo: ${time}`}
              className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs"
            />
          }
        >
          <CircleCheckIcon aria-hidden className="size-3.5" />
          <span>Decidido</span>
          <span className="text-foreground tabular-nums">{time}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {clock.definitive
            ? "El reloj se detuvo en la decisión."
            : "Un tramo sin resolver quedó fuera: el tiempo es un mínimo."}
        </TooltipPopup>
      </Tooltip>
    );
  }

  const stageLabel =
    state._tag === "running"
      ? STAGE_LABEL[state.stage]
      : state._tag === "paused"
        ? `En pausa · ${STAGE_LABEL[state.stage]}`
        : "Detenido";

  return (
    <div
      role="group"
      aria-label="Reloj de trabajo"
      className="flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs"
    >
      {clock.unresolved.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label="Tramo sin resolver"
                className="inline-flex text-warning-foreground"
              />
            }
          >
            <TriangleAlertIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            El servidor se reinició con el reloj en marcha. Indica en los detalles del hilo cuándo
            dejaste de trabajar.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Menu>
        <MenuTrigger
          render={<Button size="xs" variant="ghost-muted" />}
          aria-label={`Etapa: ${stageLabel}. Cambiar etapa`}
          disabled={controls.busy || state._tag === "idle"}
        >
          <TimerIcon aria-hidden />
          <span>{stageLabel}</span>
          <span role="timer" className="text-foreground tabular-nums">
            {time}
          </span>
          <ChevronDownIcon aria-hidden className="size-3 opacity-70" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={state._tag === "idle" ? "" : state.stage}
            onValueChange={(value) => {
              const next = stagesOf(video.thread.mode).find((stage) => stage === value);
              if (next !== undefined && (state._tag !== "running" || next !== state.stage)) {
                controls.onStage(next);
              }
            }}
          >
            {stagesOf(video.thread.mode).map((stage) => (
              <MenuRadioItem key={stage} value={stage} closeOnClick>
                {STAGE_LABEL[stage]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      {state._tag === "running" ? (
        <PauseControl busy={controls.busy} onPause={controls.onPause} />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Reanudar reloj"
                disabled={controls.busy}
                onClick={() =>
                  state._tag === "paused"
                    ? controls.onResume()
                    : controls.onStart(restartStage(video.thread.mode, clock))
                }
              />
            }
          >
            <PlayIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Reanudar</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function PauseControl({
  busy,
  onPause,
}: {
  readonly busy: boolean;
  readonly onPause: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const submit = () => {
    onPause(reason);
    setOpen(false);
    setReason("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label="Pausar reloj" disabled={busy} />
        }
      >
        <PauseIcon aria-hidden />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-64">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="text-muted-foreground text-xs" htmlFor="work-clock-pause-reason">
            Motivo de la pausa (opcional)
          </label>
          <Input
            id="work-clock-pause-reason"
            size="compact"
            autoFocus
            value={reason}
            maxLength={2000}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <Button type="submit" size="xs" className="self-end">
            Pausar
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Mounted once in `ChatHeader.tsx`; renders nothing for a thread with no editorial side. It
 * also versions the script as the editor saves it, because the header stays mounted while the
 * details card and the file surface come and go.
 */
export function WorkClock({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const live = useVideoThread(threadRef);
  const nowMs = useNowSecond();
  const commands = useVideoCommands(threadRef);
  const workspaceRoot = useThreadWorkspaceRoot(threadRef);
  const [busy, setBusy] = useState(false);
  const video = live?.view.video ?? null;
  useScriptAutoVersion({
    threadRef,
    workspaceRoot,
    scriptPath: video?.script.path ?? null,
    enabled: video !== null && video.decision === null,
    saveScript: () => commands.saveScript("No se guardó la versión del guion"),
  });
  if (live === null || video === null) return null;

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    return action().finally(() => setBusy(false));
  };
  return (
    <div className={cn("flex shrink-0 items-center", busy && "opacity-80")}>
      <WorkClockView
        video={video}
        receivedAtMs={live.receivedAtMs}
        nowMs={Math.max(nowMs, live.receivedAtMs)}
        controls={{
          busy,
          onPause: (reason) =>
            void run(() =>
              commands.clock(
                reason.trim() ? { _tag: "pause", reason: reason.trim() } : { _tag: "pause" },
                "No se pausó el reloj",
              ),
            ),
          onResume: () => void run(() => commands.clock({ _tag: "resume" }, "No se reanudó")),
          onStart: (stage) =>
            void run(() => commands.clock({ _tag: "start", stage }, "No se reanudó")),
          onStage: (stage) =>
            void run(() => commands.clock({ _tag: "stage", stage }, "No se cambió la etapa")),
        }}
      />
    </div>
  );
}
