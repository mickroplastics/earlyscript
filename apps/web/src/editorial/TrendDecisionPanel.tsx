import { ThreadId, type EditorialTrendSummary, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Fragment, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { usePairsMode } from "./pairsMode";
import { useTrendActions } from "./trendActions";
import { JudgeOpinion } from "./TrendCard";
import { KeepWatchingControl } from "./TrendDecision";
import { DossierDisclosure } from "./TrendDossierDisclosure";
import { TrendDismissDialog } from "./TrendDismissDialog";
import { decisionPanelState } from "./trendDossier.logic";

const MANUAL_HINT = "Mismo tema, sin asistente ni ficha: para comparar por pares.";

function ThreadLink({
  environmentId,
  threadId,
  onOpen,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: ThreadId.make(threadId) }}
          onClick={onOpen}
        />
      }
    >
      {children}
    </Button>
  );
}

/**
 * The dossier's decision: where the trend stands, its main way forward and the secondary
 * exits, each replaced by its way back once taken. The list's brief card keeps `TrendDecision`.
 */
export function TrendDecisionPanel({
  environmentId,
  trend,
}: {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
}) {
  const actions = useTrendActions(environmentId);
  const pairsMode = usePairsMode();
  const [dismissing, setDismissing] = useState(false);
  const [creating, setCreating] = useState(false);
  const panel = decisionPanelState(trend);
  const { trendKey, inbox: state } = trend;
  const title = trend.presentation?.title ?? trend.label;

  const create = async (mode: "assisted" | "manual") => {
    if (trendKey === undefined) return;
    setCreating(true);
    // The button comes back even if the action throws.
    await actions.createVideo({ ...trend, trendKey }, mode).finally(() => setCreating(false));
  };

  const primary = panel.primary;
  const primaryButton =
    primary === null ? null : primary.kind === "open" ? (
      <Button
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: ThreadId.make(primary.threadId) }}
            onClick={() => {
              if (primary.prepare) actions.prepareVideo(ThreadId.make(primary.threadId));
            }}
          />
        }
      >
        {primary.label}
      </Button>
    ) : primary.kind === "reopen" ? (
      <Button onClick={() => trendKey !== undefined && void actions.reopen(trendKey)}>
        Reabrir
      </Button>
    ) : (
      <Button disabled={creating} onClick={() => void create("assisted")}>
        Crear hilo de video
      </Button>
    );

  const secondary: Array<{ readonly key: string; readonly node: ReactNode }> = [];
  if (trendKey !== undefined) {
    if (state?.dismissed) {
      secondary.push({
        key: "create",
        node: (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={creating}
            onClick={() => void create("assisted")}
          >
            Crear hilo de video
          </Button>
        ),
      });
    } else if (state?.snoozed) {
      secondary.push({
        key: "return",
        node: (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => void actions.returnToInbox(trendKey)}
          >
            Volver a la bandeja
          </Button>
        ),
      });
    } else {
      secondary.push({
        key: "watch",
        node: (
          <KeepWatchingControl
            environmentId={environmentId}
            trendKey={trendKey}
            actions={actions}
            size="xs"
          />
        ),
      });
    }
    if (!state?.dismissed) {
      secondary.push({
        key: "dismiss",
        node: (
          <Button size="xs" variant="ghost-muted" onClick={() => setDismissing(true)}>
            Descartar…
          </Button>
        ),
      });
    }
    secondary.push({
      key: "manual",
      node: (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={creating}
                onClick={() => void create("manual")}
              />
            }
          >
            Crear hilo manual
          </TooltipTrigger>
          <TooltipPopup side="top">{MANUAL_HINT}</TooltipPopup>
        </Tooltip>
      ),
    });
    for (const link of panel.links) {
      secondary.push({
        key: `link-${link.threadId}`,
        node: (
          <ThreadLink
            environmentId={environmentId}
            threadId={link.threadId}
            {...(link.prepare
              ? { onOpen: () => actions.prepareVideo(ThreadId.make(link.threadId)) }
              : {})}
          >
            {link.label}
          </ThreadLink>
        ),
      });
    }
    if (state?.trial) {
      secondary.push({
        key: "trial",
        node: (
          <ThreadLink environmentId={environmentId} threadId={state.trial.threadId}>
            Ver el ensayo
          </ThreadLink>
        ),
      });
    }
  }

  return (
    <section
      aria-label="Decisión"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 rounded-xl border border-border bg-card px-5 py-4 text-card-foreground"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">{panel.headline}</p>
        {panel.reason ? <p className="text-sm text-foreground/90">«{panel.reason}»</p> : null}
        {panel.meta ? <p className="text-xs text-muted-foreground">{panel.meta}</p> : null}
        {panel.stateLine ? (
          <p className="text-xs text-muted-foreground">{panel.stateLine}</p>
        ) : null}
        {panel.records.map((record) => (
          <p
            key={record.threadId}
            className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
          >
            <span>{record.text}</span>
            {record.reason ? <span>· «{record.reason}»</span> : null}
            <ThreadLink environmentId={environmentId} threadId={record.threadId}>
              {record.linkLabel}
            </ThreadLink>
          </p>
        ))}
      </div>
      <div className="justify-self-end">{primaryButton}</div>
      {secondary.length > 0 ? (
        <div className="col-span-2 flex flex-wrap items-center gap-x-1 gap-y-1">
          <div
            role="group"
            aria-label="Otras acciones"
            className="flex flex-wrap items-center gap-1"
          >
            {secondary.map((entry, index) => (
              <Fragment key={entry.key}>
                {index === 0 ? null : (
                  <span aria-hidden className="text-xs text-muted-foreground">
                    ·
                  </span>
                )}
                {entry.node}
              </Fragment>
            ))}
          </div>
          <span className="ms-auto text-xs text-muted-foreground">La decisión final es tuya.</span>
        </div>
      ) : null}
      {pairsMode ? null : (
        <div className="col-span-2">
          <DossierDisclosure label="Opinión de los jueces">
            <JudgeOpinion
              environmentId={environmentId}
              trend={trend}
              decision={trend.card?.decision ?? null}
              titled={false}
            />
          </DossierDisclosure>
        </div>
      )}
      {dismissing && trendKey !== undefined ? (
        <TrendDismissDialog
          trendTitle={title}
          onConfirm={(reason) => actions.dismiss(trendKey, reason)}
          onClose={() => setDismissing(false)}
        />
      ) : null}
    </section>
  );
}
