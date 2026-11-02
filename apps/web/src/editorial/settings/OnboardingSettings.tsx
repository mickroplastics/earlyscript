import type { EditorialOnboardingAcceptance, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { DataHandlingDialog } from "../onboarding/DataHandlingDialog";
import { editorialOnboardingEnvironment, stepLabel } from "../onboarding/onboardingState";
import { EDITORIAL_DATA_HANDLING_ID, EDITORIAL_ONBOARDING_SECTION_ID } from "./settingsEntry";

const whenFormat = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
const formatWhen = (iso: string) => whenFormat.format(new Date(iso));

/** Decisions shown before «Mostrar todas»: one full pass of the wizard and the one before. */
const RECENT_DECISIONS = 8;

interface OnboardingSettingsViewProps {
  /** Oldest first, as the server lists them; shown newest first. */
  readonly acceptances: ReadonlyArray<EditorialOnboardingAcceptance> | null;
  readonly completedAt: string | null;
  readonly error: string | null;
}

function OnboardingSettingsView({ acceptances, completedAt, error }: OnboardingSettingsViewProps) {
  const [showAll, setShowAll] = useState(false);
  const newestFirst = acceptances === null ? [] : [...acceptances].reverse();
  const shown = showAll ? newestFirst : newestFirst.slice(0, RECENT_DECISIONS);
  const decisionsDescription =
    error !== null
      ? `No se pudieron leer: ${error}`
      : acceptances === null
        ? "Cargando."
        : acceptances.length === 0
          ? "Todavía no hay decisiones registradas."
          : completedAt === null
            ? "Cada paso aceptado, con su fecha. El asistente no se ha terminado."
            : `Cada paso aceptado, con su fecha. Terminado por última vez el ${formatWhen(completedAt)}.`;
  return (
    <SettingsSection id={EDITORIAL_ONBOARDING_SECTION_ID} title="Asistente de inicio">
      <SettingsRow
        title="Recorrer de nuevo"
        description="Vuelve a recorrer los cuatro pasos. No borra nada: cada paso que aceptes se registra de nuevo."
        control={
          <Button size="sm" variant="outline" render={<Link to="/welcome" />}>
            Abrir el asistente de inicio
          </Button>
        }
      />
      <SettingsRow title="Decisiones del asistente" description={decisionsDescription}>
        {shown.length > 0 ? (
          <div className="mt-3 space-y-2">
            <ol className="space-y-1 text-sm" data-testid="onboarding-decisions">
              {shown.map((acceptance) => (
                <li
                  key={acceptance.id}
                  className="flex flex-col sm:flex-row sm:items-baseline sm:gap-x-2"
                >
                  <span className="font-medium text-foreground sm:w-36 sm:shrink-0">
                    {stepLabel(acceptance.step)}
                  </span>
                  <span className="whitespace-nowrap text-muted-foreground">
                    {formatWhen(acceptance.acceptedAt)}
                    <span className="text-xs"> · v{acceptance.appVersion}</span>
                  </span>
                </li>
              ))}
            </ol>
            {newestFirst.length > RECENT_DECISIONS ? (
              <Button size="xs" variant="ghost-muted" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Mostrar solo las recientes" : `Mostrar todas (${newestFirst.length})`}
              </Button>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        id={EDITORIAL_DATA_HANDLING_ID}
        title="Cómo se tratan tus datos"
        description="Quedan en esta máquina, sin telemetría ni analítica."
        control={
          <DataHandlingDialog label="Ver" trigger={<Button size="sm" variant="outline" />} />
        }
      />
    </SettingsSection>
  );
}

function OnboardingSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const target = { environmentId, input: {} };
  const list = useEnvironmentQuery(editorialOnboardingEnvironment.list(target));
  const status = useEnvironmentQuery(editorialOnboardingEnvironment.status(target));
  return (
    <OnboardingSettingsView
      acceptances={list.data?.acceptances ?? null}
      completedAt={status.data?.completedAt ?? null}
      error={list.error ?? null}
    />
  );
}

/** Settings › Editorial › Asistente de inicio, on the primary environment, which stores them. */
export function OnboardingSettings() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <OnboardingSettingsForEnvironment environmentId={environmentId} />;
}
