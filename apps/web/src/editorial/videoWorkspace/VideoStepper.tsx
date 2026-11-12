import type {
  EditorialResultsStage,
  EditorialVideoClock,
  EditorialVideoState,
  EditorialVideoUnresolvedInterval,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import { formatClock, stageClockMs } from "../videoThread.logic";
import {
  ASSISTED_STEPS,
  STEP_TITLE,
  type DraftParts,
  openStageTime,
  stopTimeIso,
  type StepView,
  type StepperModel,
} from "./videoWorkspace.logic";

/**
 * The running time of one stage. A leaf that reads the second on its own, so the clock ticking
 * repaints this text and nothing around it.
 */
function StageTime({
  clock,
  stage,
  receivedAtMs,
  floor = false,
  className,
}: {
  readonly clock: EditorialVideoClock;
  readonly stage: EditorialResultsStage;
  readonly receivedAtMs: number;
  /** An open segment does not count yet: the time shown is a minimum. */
  readonly floor?: boolean;
  readonly className?: string;
}) {
  const nowMs = useNowSecond();
  const ms = stageClockMs(clock, stage, receivedAtMs, Math.max(nowMs, receivedAtMs));
  return (
    <span role="timer" className={cn("tabular-nums", className)}>
      {floor ? openStageTime(ms) : formatClock(ms)}
    </span>
  );
}

const BAR_TONE: Readonly<Record<StepView["status"], string>> = {
  done: "bg-success",
  active: "bg-primary",
  paused: "bg-warning",
  open: "bg-warning",
  pending: "bg-muted",
};

function StepMarker({ step }: { readonly step: StepView }) {
  if (step.status === "done") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success text-background">
        <CheckIcon aria-hidden className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border font-semibold text-xs tabular-nums",
        step.status === "active" && "border-primary text-primary ring-2 ring-primary/24",
        (step.status === "paused" || step.status === "open") &&
          "border-warning bg-warning text-background",
        step.status === "pending" && "border-border text-muted-foreground",
      )}
    >
      {step.number}
    </span>
  );
}

/** Both halves of Escribir y revisar: the draft counts its parts, the review only shows activity. */
function WriteBar({
  step,
  parts,
  agentWorking,
}: {
  readonly step: StepView;
  readonly parts: DraftParts;
  readonly agentWorking: boolean;
}) {
  const drafted = parts.done > 0;
  const draftShare = step.status === "done" ? 1 : parts.total === 0 ? 0 : parts.done / parts.total;
  const tone = BAR_TONE[step.status];
  const reviewing =
    step.status === "done" ||
    (step.status !== "pending" && drafted && !(agentWorking && parts.done === 0));
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {[
        { label: "Borrador", share: draftShare, lit: draftShare > 0 },
        { label: "Revisión", share: reviewing ? 1 : 0, lit: reviewing },
      ].map((half) => (
        <div key={half.label} className="flex flex-col gap-1">
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", step.status === "pending" ? "" : tone)}
              style={{ width: `${Math.round(half.share * 100)}%` }}
            />
          </div>
          <span
            className={cn(
              "text-2xs",
              half.lit && step.status === "done"
                ? "text-success-foreground"
                : half.lit && step.status === "active"
                  ? "text-primary"
                  : half.lit
                    ? "text-warning-foreground"
                    : "text-muted-foreground/70",
            )}
          >
            {half.label}
            {half.label === "Borrador" && parts.total > 0 && step.status !== "done" && drafted
              ? ` · ${parts.done} de ${parts.total} partes`
              : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The three steps of an assisted thread, each with its time and its bar. */
export function VideoSteps({
  model,
  video,
  receivedAtMs,
  parts,
  agentWorking,
}: {
  readonly model: StepperModel;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly parts: DraftParts;
  readonly agentWorking: boolean;
}) {
  const decision = video.decision;
  const openStages = new Set(video.clock.unresolved.map((interval) => interval.stage));
  return (
    <ol aria-label="Pasos del video" className="grid grid-cols-[1fr_1.35fr_1fr] gap-4">
      {model.steps.map((step) => {
        const recorded = decision
          ? null
          : video.clock.stages.some((entry) => entry.stage === step.stage);
        const decidedMs = decision
          ? step.stage === "read"
            ? decision.durations.readMs
            : step.stage === "write"
              ? decision.durations.writeMs
              : decision.durations.decideMs
          : null;
        return (
          <li
            key={step.stage}
            aria-current={step.status === "active" || step.status === "paused" ? "step" : undefined}
            className="flex min-w-0 flex-col gap-2"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <StepMarker step={step} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "truncate font-semibold text-sm",
                      step.status === "pending" && "text-muted-foreground",
                    )}
                  >
                    {step.title}
                  </span>
                  {decision ? (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {decidedMs === null ? "sin registro" : formatClock(decidedMs)}
                    </span>
                  ) : recorded || step.status === "active" ? (
                    <StageTime
                      clock={video.clock}
                      stage={step.stage}
                      receivedAtMs={receivedAtMs}
                      floor={openStages.has(step.stage)}
                      className={cn(
                        "text-xs",
                        step.status === "active"
                          ? "text-primary"
                          : step.status === "paused" || step.status === "open"
                            ? "text-warning-foreground"
                            : "text-muted-foreground",
                      )}
                    />
                  ) : null}
                </div>
                <p
                  className={cn(
                    "truncate text-xs",
                    step.status === "paused" || step.status === "open"
                      ? "text-warning-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {step.detail}
                </p>
              </div>
            </div>
            {step.stage === "write" ? (
              <WriteBar step={step} parts={parts} agentWorking={agentWorking} />
            ) : (
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    step.status === "pending" ? "w-0" : "w-full",
                    BAR_TONE[step.status],
                  )}
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const NOW_TONE: Readonly<Record<StepperModel["now"]["tone"], string>> = {
  now: "border-primary/32 bg-primary/10 text-primary",
  pause: "border-warning/40 bg-warning/14 text-warning-foreground",
  open: "border-warning/40 bg-warning/14 text-warning-foreground",
  done: "border-success/40 bg-success/12 text-success-foreground",
};

/** The single line that says what to do now, with at most one action, at a fixed height. */
export function NowLine({
  model,
  actions,
}: {
  readonly model: StepperModel;
  readonly actions: ReactNode;
}) {
  return (
    <div
      className="flex min-h-11 items-center gap-3 border-t border-dashed pt-3"
      data-now-tone={model.now.tone}
    >
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 font-semibold text-2xs uppercase tracking-wider",
          NOW_TONE[model.now.tone],
        )}
      >
        {model.now.label}
      </span>
      <p className="min-w-0 flex-1 text-sm leading-snug">{model.now.text}</p>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

/** Asks, inside the «Ahora» line, when a segment left open by a restart ended. */
export function ResolveIntervalForm({
  interval,
  busy,
  onResolve,
}: {
  readonly interval: EditorialVideoUnresolvedInterval;
  readonly busy: boolean;
  readonly onResolve: (intervalId: string, endedAt: string) => void;
}) {
  const [value, setValue] = useState("");
  const endedAt = value.trim() === "" ? null : stopTimeIso(value, interval);
  const invalid = value.trim() !== "" && endedAt === null;
  const inputId = `video-resolve-${interval.intervalId}`;
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (endedAt !== null) onResolve(interval.intervalId, endedAt);
      }}
    >
      <label className="whitespace-nowrap text-sm" htmlFor={inputId}>
        Dejé de trabajar a las
      </label>
      <Input
        id={inputId}
        size="compact"
        className="w-20"
        inputMode="numeric"
        autoComplete="off"
        placeholder="hh:mm"
        aria-invalid={invalid || undefined}
        aria-describedby={`${inputId}-hint`}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <span id={`${inputId}-hint`} className="sr-only">
        Una hora entre el inicio del tramo y el cierre de la app.
      </span>
      <Button type="submit" size="sm" disabled={endedAt === null || busy}>
        Guardar
      </Button>
    </form>
  );
}

/**
 * The clock in the thread header: a dot and «Pausar», or «En pausa», opening a menu to pause or
 * resume and to move to another step. What is already measured stays in its step.
 */
export function ClockPill({
  video,
  busy,
  onPause,
  onResume,
  onStage,
}: {
  readonly video: EditorialVideoState;
  readonly busy: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStage: (stage: EditorialResultsStage) => void;
}) {
  const state = video.clock.state;
  if (video.decision !== null) return null;
  const running = state._tag === "running";
  const current = state._tag === "idle" ? null : state.stage;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={running ? "outline" : "warning-outline"}
            aria-label={`Reloj ${running ? "en marcha" : state._tag === "paused" ? "en pausa" : "detenido"}. Pausar, reanudar o cambiar de paso`}
          />
        }
        disabled={busy}
      >
        {running ? (
          <span aria-hidden className="size-2 rounded-full bg-success" />
        ) : (
          <PauseIcon aria-hidden />
        )}
        <span>{running ? "Pausar" : state._tag === "paused" ? "En pausa" : "Detenido"}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-72">
        {running ? (
          <MenuItem onClick={onPause}>
            <PauseIcon aria-hidden />
            Pausar el reloj
          </MenuItem>
        ) : (
          <MenuItem onClick={onResume}>
            <PlayIcon aria-hidden />
            {current === null ? "Reanudar el reloj" : `Reanudar en «${STEP_TITLE[current]}»`}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Cambiar de paso</MenuGroupLabel>
          <MenuRadioGroup
            value={current ?? ""}
            onValueChange={(value) => {
              const next = ASSISTED_STEPS.find((stage) => stage === value);
              if (next !== undefined && (state._tag !== "running" || next !== state.stage)) {
                onStage(next);
              }
            }}
          >
            {ASSISTED_STEPS.map((stage, index) => (
              <MenuRadioItem key={stage} value={stage} closeOnClick>
                {index + 1} · {STEP_TITLE[stage]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <p className="px-2 pt-1 pb-1.5 text-muted-foreground text-xs leading-snug">
          El tiempo ya medido se queda en su paso. Al elegir un paso, el reloj sigue contando en ese
          paso{running ? "" : " y la pausa termina"}.
        </p>
      </MenuPopup>
    </Menu>
  );
}
