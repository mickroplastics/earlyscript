import {
  EDITORIAL_ONBOARDING_STEPS,
  type EditorialOnboardingAcceptance,
  type EditorialOnboardingStep,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { SettingsGroup } from "../../components/settings/SettingsGroup";
import {
  SettingsPageContainer,
  SettingsRow,
  useSettingsSearchTarget,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { DataHandlingDialog } from "../onboarding/DataHandlingDialog";
import { editorialOnboardingEnvironment } from "../onboarding/onboardingState";
import { formatDay } from "./editorialStatus.logic";
import { shortHash } from "./channel.logic";
import { EDITORIAL_DATA_HANDLING_ID, EDITORIAL_ONBOARDING_SECTION_ID } from "./settingsEntry";
import { NoEnvironment, SettingsPageHeader } from "./SettingsPageHeader";

const whenFormat = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
const formatWhen = (iso: string) => whenFormat.format(new Date(iso));

/** What each step of the wizard asked to accept, in Settings' words. */
const STEP_TEXT: Readonly<Record<EditorialOnboardingStep, string>> = {
  datos: "Datos y permisos de las fuentes",
  proveedores: "Proveedores y tope mensual",
  estudio: "Perfil del canal",
  motor: "Revisión nocturna",
};

/** The latest acceptance of each step, oldest first; steps never accepted are left out. */
function latestPerStep(
  acceptances: ReadonlyArray<EditorialOnboardingAcceptance>,
): ReadonlyArray<EditorialOnboardingAcceptance> {
  return EDITORIAL_ONBOARDING_STEPS.flatMap((step) => {
    const latest = acceptances.findLast((acceptance) => acceptance.step === step);
    return latest === undefined ? [] : [latest];
  }).toSorted((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
}

const policyOf = (acceptance: EditorialOnboardingAcceptance): string | null =>
  typeof acceptance.payload.policyHash === "string" ? acceptance.payload.policyHash : null;

/** What stays on this machine and what leaves it, as the «Datos y permisos» step says it. */
function DataSummary() {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(EDITORIAL_DATA_HANDLING_ID);
  return (
    <div
      id={EDITORIAL_DATA_HANDLING_ID}
      ref={targetRef}
      tabIndex={-1}
      className="overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 outline-none"
    >
      <div className="grid sm:grid-cols-2 sm:divide-x divide-border/50 max-sm:[&>*+*]:border-t">
        <div className="space-y-2 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            Se guarda en este equipo
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Lo capturado de las fuentes</li>
            <li>Tu perfil, tus decisiones y tus guiones</li>
            <li>Sin telemetría ni analítica</li>
          </ul>
        </div>
        <div className="space-y-2 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-warning" />
            Sale de este equipo
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">Al usar IA:</span> tu perfil, la evidencia de cada
              tendencia y lo que escribes en un hilo, al proveedor que elijas
            </li>
            <li>
              <span className="text-foreground">Al capturar:</span> las peticiones a cada fuente
              activada
            </li>
            <li>
              <span className="text-foreground">Otras:</span> la descarga del modelo, una vez, y
              consultas técnicas sin tus textos
            </li>
          </ul>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-border/50 px-4 py-3">
        <p className="flex-1 text-sm text-muted-foreground">
          Detalle completo, rutas y cómo borrarlo todo.
        </p>
        <DataHandlingDialog label="Ver detalle" trigger={<Button size="sm" variant="outline" />} />
      </div>
    </div>
  );
}

interface FirstRunSettingsViewProps {
  /** Oldest first, as the server lists them. */
  readonly acceptances: ReadonlyArray<EditorialOnboardingAcceptance> | null;
  readonly error: string | null;
}

/** «Recorrer de nuevo» and what was accepted, folded: the latest of each step, then all of it. */
function FirstRunSettingsView({ acceptances, error }: FirstRunSettingsViewProps) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const latest = acceptances === null ? [] : latestPerStep(acceptances);
  const newest = latest.at(-1) ?? null;
  const all = acceptances === null ? [] : [...acceptances].reverse();
  const summary =
    error !== null
      ? `No se pudo leer: ${error}`
      : acceptances === null
        ? "Cargando…"
        : newest === null
          ? "Todavía nada"
          : `${latest.length} ${latest.length === 1 ? "paso" : "pasos"} · último el ${formatDay(newest.acceptedAt.slice(0, 10))}`;
  return (
    <section
      id={EDITORIAL_ONBOARDING_SECTION_ID}
      tabIndex={-1}
      aria-labelledby="editorial-first-run-title"
      className="space-y-2 outline-none"
    >
      <h3
        id="editorial-first-run-title"
        className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        Primer arranque
      </h3>
      <SettingsGroup>
        <SettingsRow
          title="Recorrer de nuevo"
          description="No borra nada; lo que aceptes se registra otra vez."
          control={
            <Button size="sm" variant="outline" render={<Link to="/welcome" />}>
              Abrir
            </Button>
          }
        />
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="flex-1">Lo que aceptaste</span>
            <span className="text-xs text-muted-foreground">{summary}</span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="space-y-1 px-4 pb-3 pl-10">
              <ol className="text-sm" data-testid="onboarding-decisions">
                {(showAll ? all : latest).map((acceptance) => {
                  const policy = policyOf(acceptance);
                  return (
                    <li
                      key={acceptance.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5"
                    >
                      <span className="text-foreground">{STEP_TEXT[acceptance.step]}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatWhen(acceptance.acceptedAt)}
                        {showAll ? (
                          <span className="text-xs">
                            {" "}
                            · v{acceptance.appVersion}
                            {policy === null ? "" : ` · política ${shortHash(policy)}`}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {all.length > latest.length ? (
                <Button size="xs" variant="ghost-muted" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Ver solo lo último" : `Ver todo el registro (${all.length})`}
                </Button>
              ) : null}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </SettingsGroup>
    </section>
  );
}

function DataSettingsForEnvironment({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const list = useEnvironmentQuery(
    editorialOnboardingEnvironment.list({ environmentId, input: {} }),
  );
  return (
    <FirstRunSettingsView acceptances={list.data?.acceptances ?? null} error={list.error ?? null} />
  );
}

/** Settings › Editorial › Mis datos: what stays and what leaves, and the first-run wizard. */
export function DataSettingsPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return <NoEnvironment />;
  return (
    <SettingsPageContainer className="gap-6">
      <div className="space-y-4">
        <SettingsPageHeader title="Mis datos" />
        <DataSummary />
      </div>
      <DataSettingsForEnvironment environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
