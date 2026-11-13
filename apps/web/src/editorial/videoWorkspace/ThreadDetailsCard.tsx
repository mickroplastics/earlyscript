import type { EditorialResultsStage, EditorialVideoState } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import { formatClock, formatSavedAt, stageClockMs } from "../videoThread.logic";
import { ASSISTED_STEPS, STEP_TITLE, dateAndTime, stageSumNote } from "./videoWorkspace.logic";

const STAGE_TONE: Readonly<Record<EditorialResultsStage, string>> = {
  explore: "bg-violet-400",
  read: "bg-violet-400",
  write: "bg-primary",
  decide: "bg-emerald-500",
};

const STAGE_HINT: Readonly<Record<EditorialResultsStage, string>> = {
  explore: "",
  read: "hasta tu primer mensaje",
  write: "borrador y revisión",
  decide: "hasta guardar la decisión",
};

/**
 * Time per step as one bar and its exact figures. Before the decision it reads the running
 * second itself, a leaf, so only the chart repaints.
 */
function WorkTimeChart({
  video,
  receivedAtMs,
}: {
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
}) {
  const nowMs = useNowSecond();
  const decision = video.decision;
  const rows = ASSISTED_STEPS.map((stage) => {
    const ms = decision
      ? stage === "read"
        ? decision.durations.readMs
        : stage === "write"
          ? decision.durations.writeMs
          : decision.durations.decideMs
      : video.clock.stages.some((entry) => entry.stage === stage) ||
          (video.clock.state._tag !== "idle" && video.clock.state.stage === stage)
        ? stageClockMs(video.clock, stage, receivedAtMs, Math.max(nowMs, receivedAtMs))
        : null;
    return { stage, ms };
  });
  const sum = rows.reduce((acc, row) => acc + (row.ms ?? 0), 0);
  const total = decision ? decision.durations.totalMs : sum;
  const note = decision
    ? stageSumNote(
        rows.map((row) => row.ms),
        total,
      )
    : null;
  return (
    <section aria-label="Tiempo de trabajo" className="flex flex-col gap-3">
      <h3 className="flex items-baseline gap-2 font-semibold text-sm">
        Tiempo de trabajo
        <span className="font-normal text-muted-foreground text-xs">
          {decision
            ? decision.clockDefinitive
              ? "reloj definitivo"
              : "con un tramo sin resolver"
            : video.clock.unresolved.length > 0
              ? "con un tramo abierto"
              : video.clock.state._tag === "running"
                ? "en marcha"
                : video.clock.state._tag === "paused"
                  ? "en pausa: no cuenta"
                  : "detenido: no cuenta"}
        </span>
      </h3>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted">
        {sum > 0
          ? rows.map((row) =>
              row.ms ? (
                <div
                  key={row.stage}
                  className={cn("h-full min-w-1", STAGE_TONE[row.stage])}
                  style={{ flexGrow: row.ms }}
                />
              ) : null,
            )
          : null}
      </div>
      <dl className="flex flex-col gap-1 text-sm">
        {rows.map((row) => (
          <div key={row.stage} className="grid grid-cols-[auto_1fr_auto_auto] items-baseline gap-2">
            <span
              aria-hidden
              className={cn("size-2 self-center rounded-full", STAGE_TONE[row.stage])}
            />
            <dt>{STEP_TITLE[row.stage]}</dt>
            <span className="text-muted-foreground text-xs">{STAGE_HINT[row.stage]}</span>
            <dd className="w-20 text-right tabular-nums">
              {row.ms === null ? "sin registro" : formatClock(row.ms)}
            </dd>
          </div>
        ))}
        <div className="mt-1 grid grid-cols-[1fr_auto] items-baseline gap-2 border-t pt-1.5 font-medium">
          <dt>Total</dt>
          <dd className="w-20 text-right tabular-nums">
            {total === null ? "sin registro" : formatClock(total)}
          </dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Tiempo activo, medido por la app mientras trabajas; las pausas no cuentan.
        {decision ? " Es la medición que cuenta en Resultados." : ""}
        {note ? ` ${note}` : ""}
      </p>
    </section>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-2">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** Everything about the thread in one place: origin, script, sources, clock, trial, metrics. */
export function ThreadDetailsCard({
  video,
  receivedAtMs,
  trend,
  modelLabel,
  sourceCount,
  citedCount,
  busy,
  onToggleCohort,
}: {
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly trend: ReactNode;
  readonly modelLabel: string | null;
  readonly sourceCount: number | null;
  readonly citedCount: number;
  readonly busy: boolean;
  readonly onToggleCohort: () => void;
}) {
  const { script, decision, clock } = video;
  const head = script.head;
  const trial = video.thread.cohort === "trial";
  const latest = video.results[0];
  return (
    <div className="flex flex-col gap-6" data-thread-map-script>
      <WorkTimeChart video={video} receivedAtMs={receivedAtMs} />
      <dl className="flex flex-col divide-y border-t">
        <Row label="Tendencia">{trend}</Row>
        <Row label="Modo">Con asistente{modelLabel ? ` · ${modelLabel}` : ""}</Row>
        <Row label="Guion">
          <span className="block">
            {decision?.scriptVersionHash === null
              ? `Decisión sin versión guardada, del ${dateAndTime(decision.decidedAt)}`
              : decision
                ? `La versión que decidiste el ${dateAndTime(decision.decidedAt)}`
                : head
                  ? `Versión ${script.versionCount}, guardada ${formatSavedAt(head.savedAt)}`
                  : "Sin versiones guardadas todavía"}
          </span>
          {script.path ? (
            <code className="block truncate text-muted-foreground text-xs [direction:rtl]">
              <bdi>{script.path}</bdi>
            </code>
          ) : null}
        </Row>
        <Row label="Fuentes">
          {sourceCount === null
            ? "Cargando…"
            : `${sourceCount} del expediente${citedCount > 0 ? `; el guion cita ${citedCount}` : ""}`}
        </Row>
        <Row label="Revisión de referencias">
          {head?.claims != null && head.cited != null
            ? `${head.claims} frases · ${head.claims - head.cited} sin número de fuente`
            : "Sin guion revisado todavía"}
        </Row>
        <Row label="Reloj">
          {clock.unresolved.length > 0
            ? "Un tramo abierto espera la hora en que dejaste de trabajar; hasta entonces no cuenta."
            : decision
              ? decision.clockDefinitive
                ? "Medición completa, sin tramos abiertos."
                : "Un tramo quedó sin resolver al decidir: los tiempos son un mínimo."
              : clock.state._tag === "paused"
                ? "En pausa: ese tiempo no cuenta."
                : clock.state._tag === "idle"
                  ? "Detenido."
                  : `En marcha en «${STEP_TITLE[clock.state.stage]}».`}
        </Row>
        <Row label="Ensayo">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {trial
                ? "Sí. Se conserva, pero no cuenta en Resultados."
                : "No. Cuenta en Resultados."}
            </span>
            <Button size="xs" variant="outline" disabled={busy} onClick={onToggleCohort}>
              {trial ? "Quitar marca de ensayo" : "Marcar como ensayo"}
            </Button>
          </span>
        </Row>
        <Row label="Métricas del video">
          {latest
            ? `${video.results.length === 1 ? "1 observación" : `${video.results.length} observaciones`}, la última del ${latest.observedAt.slice(0, 10)}`
            : "Ninguna anotada todavía"}
        </Row>
      </dl>
    </div>
  );
}
