import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EditorialTrendKey, type EnvironmentId, trendTitle } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { NotebookPenIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarGroup } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTrendInbox } from "./TrendInbox";
import { videoFailureText } from "./videoThread.logic";
import { editorialVideoEnvironment } from "./videoState";
import { resolveVideoThreadTarget } from "./videoThreadTarget";

const NO_TREND = "";

/** "Manual · 31 oct": the day the exploration starts, as the sidebar lists it. */
function defaultManualTitle(now: Date = new Date()): string {
  const day = now.toLocaleDateString("es", { day: "numeric", month: "short" }).replace(".", "");
  return `Manual · ${day}`;
}

/**
 * "Nuevo hilo manual" in the Threads space: a manual video thread with no trend, its clock in
 * Explorar. Picking a trend only records that it works the same topic, for the paired
 * comparison; the thread shows nothing of it.
 */
export function NewManualThreadButton({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const createManual = useOrchestrationCommand(editorialVideoEnvironment.createManual, {
    reportFailure: false,
  });
  const inbox = AsyncResult.getOrElse(useTrendInbox(environmentId, "new-first-growth"), () => null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultManualTitle);
  const [trendKey, setTrendKey] = useState<string>(NO_TREND);
  const [busy, setBusy] = useState(false);
  // One id per opening of the form, so a double click or a retry creates one thread.
  const [operationId, setOperationId] = useState(randomUUID);
  const trends = (inbox?.trends ?? []).filter(
    (trend): trend is typeof trend & { readonly trendKey: EditorialTrendKey } =>
      trend.trendKey !== undefined,
  );

  const create = async () => {
    const target = resolveVideoThreadTarget(environmentId, "manual");
    setBusy(true);
    const result = await createManual({
      environmentId,
      input: {
        operationId,
        ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
        modelSelection: target.modelSelection,
        title: title.trim() || defaultManualTitle(),
        ...(trendKey === NO_TREND ? {} : { trendKey: trendKey as EditorialTrendKey }),
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "No se pudo crear el hilo manual",
          description: videoFailureText(squashAtomCommandFailure(result)),
        });
      }
      return;
    }
    setOpen(false);
    setOperationId(randomUUID());
    setTitle(defaultManualTitle());
    setTrendKey(NO_TREND);
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };

  return (
    <SidebarGroup className="order-1 shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button size="xs" variant="ghost-muted" className="w-full justify-start" />}
        >
          <NotebookPenIcon aria-hidden />
          Nuevo hilo manual
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-80">
          <form
            aria-label="Nuevo hilo manual"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <p className="text-muted-foreground text-xs">
              Sin chat ni motor: exploras a mano, escribes y decides, con los relojes en marcha.
            </p>
            <label className="text-muted-foreground text-xs" htmlFor="new-manual-title">
              Título
            </label>
            <Input
              id="new-manual-title"
              size="compact"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
            <span className="text-muted-foreground text-xs">
              Mismo tema que (comparación por pares, opcional)
            </span>
            <Select
              value={trendKey}
              onValueChange={(value) => setTrendKey(typeof value === "string" ? value : NO_TREND)}
            >
              <SelectTrigger size="sm" aria-label="Mismo tema que">
                <SelectValue>
                  {(value: string) =>
                    value === NO_TREND
                      ? "Ninguno: exploración libre"
                      : (() => {
                          const trend = trends.find((candidate) => candidate.trendKey === value);
                          return trend === undefined ? value : trendTitle(trend);
                        })()
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value={NO_TREND}>Ninguno: exploración libre</SelectItem>
                {trends.map((trend) => (
                  <SelectItem key={trend.trendKey} value={trend.trendKey}>
                    {trendTitle(trend)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button type="submit" size="xs" className="self-end" disabled={busy}>
              Crear hilo manual
            </Button>
          </form>
        </PopoverPopup>
      </Popover>
    </SidebarGroup>
  );
}
