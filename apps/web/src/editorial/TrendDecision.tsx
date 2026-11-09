import type {
  EditorialTrendInboxState,
  EditorialTrendKey,
  EditorialTrendSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import { Button } from "../components/ui/button";
import { Group, GroupSeparator } from "../components/ui/group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../components/ui/menu";
import { useClientSettings } from "../hooks/useSettings";
import { snoozePresetLabel, snoozeStateText } from "./editorial.logic";
import { useTrendActions, type TrendActions } from "./trendActions";
import { TrendDismissDialog } from "./TrendDismissDialog";

// The exits of a trend: create its video thread (assisted or manual), keep watching, dismiss;
// each replaced by its way back once taken. Shared by the dossier page and the brief card.

/** "Seguir observando": growth by default, or one of the thread snooze times. */
function KeepWatchingControl({
  environmentId,
  trendKey,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly trendKey: EditorialTrendKey;
  readonly actions: TrendActions;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [open, setOpen] = useState(false);
  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, environmentId)
    : [];
  return (
    <Group aria-label="Seguir observando">
      <Button size="sm" variant="outline" onClick={() => void actions.keepWatching(trendKey)}>
        Seguir observando
      </Button>
      <GroupSeparator />
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={<Button size="icon-sm" variant="outline" aria-label="Observar hasta…" />}
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          <MenuItem onClick={() => void actions.keepWatching(trendKey)}>Hasta que crezca</MenuItem>
          <MenuSeparator />
          {presets.map((preset) => (
            <MenuItem
              key={preset.id}
              onClick={() => {
                const picked = pickSnoozePreset(presets, preset.id, timestampFormat, environmentId);
                if (picked) void actions.keepWatching(trendKey, picked);
              }}
            >
              {snoozePresetLabel(preset.label)}
              <MenuShortcut>{preset.whenLabel}</MenuShortcut>
            </MenuItem>
          ))}
          <MenuItem
            onClick={async () => {
              const choice = await requestCustomSnooze();
              if (choice) void actions.keepWatching(trendKey, choice);
            }}
          >
            Personalizado…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
}

function trendStateText(state: EditorialTrendInboxState | undefined): string | null {
  if (state?.dismissed) return `Descartada: ${state.dismissed.reason}`;
  if (state?.snoozed) return snoozeStateText(state.snoozed);
  if (state?.production) return "En producción.";
  return null;
}

/** The three exits of the dossier, each replaced by its way back once taken. */
export function TrendDecision({
  environmentId,
  trend,
  bare = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
  /** Without the separator above it, inside a card's detail. */
  readonly bare?: boolean;
}) {
  const actions = useTrendActions(environmentId);
  const [dismissing, setDismissing] = useState(false);
  const [creating, setCreating] = useState(false);
  const { trendKey, inbox: state } = trend;
  const title = trend.presentation?.title ?? trend.label;
  const status = trendStateText(state);
  return (
    <div
      className={bare ? "flex flex-col gap-2" : "flex flex-col gap-2 border-t border-border pt-4"}
    >
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
      <div role="group" aria-label="Decisión" className="flex flex-wrap gap-2">
        {trendKey === undefined ? (
          <p className="text-sm text-muted-foreground">
            Este servidor no identifica la tendencia entre corridas; actualízalo para decidir.
          </p>
        ) : (
          <>
            {state?.production ? (
              <Button
                size="sm"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId,
                      threadId: ThreadId.make(state.production.threadId),
                    }}
                    onClick={() => {
                      if (state?.production) {
                        actions.prepareVideo(ThreadId.make(state.production.threadId));
                      }
                    }}
                  />
                }
              >
                Abrir hilo de video
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={creating}
                onClick={async () => {
                  setCreating(true);
                  // The button comes back even if the action throws.
                  await actions
                    .createVideo({ ...trend, trendKey })
                    .finally(() => setCreating(false));
                }}
              >
                Crear hilo de video
              </Button>
            )}
            {state?.trial ? (
              <Button
                size="sm"
                variant="ghost-muted"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: ThreadId.make(state.trial.threadId) }}
                  />
                }
              >
                Ver el ensayo
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={creating}
              title="Mismo tema, sin asistente ni expediente: para comparar por pares"
              onClick={async () => {
                setCreating(true);
                // The button comes back even if the action throws.
                await actions
                  .createVideo({ ...trend, trendKey }, "manual")
                  .finally(() => setCreating(false));
              }}
            >
              Crear hilo manual
            </Button>
            {state?.snoozed ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void actions.returnToInbox(trendKey)}
              >
                Volver a la bandeja
              </Button>
            ) : state?.dismissed ? null : (
              <KeepWatchingControl
                environmentId={environmentId}
                trendKey={trendKey}
                actions={actions}
              />
            )}
            {state?.dismissed ? (
              <Button size="sm" variant="outline" onClick={() => void actions.reopen(trendKey)}>
                Reabrir
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setDismissing(true)}>
                Descartar…
              </Button>
            )}
          </>
        )}
      </div>
      {dismissing && trendKey !== undefined ? (
        <TrendDismissDialog
          trendTitle={title}
          onConfirm={(reason) => actions.dismiss(trendKey, reason)}
          onClose={() => setDismissing(false)}
        />
      ) : null}
    </div>
  );
}
