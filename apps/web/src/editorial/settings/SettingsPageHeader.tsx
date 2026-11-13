import type { ReactNode } from "react";

import { SettingsPageContainer } from "../../components/settings/settingsLayout";

/** The title of an editorial settings page: what it answers, in one line under it. */
export function SettingsPageHeader({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-1">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center pt-0.5">{action}</div> : null}
    </div>
  );
}

/** Every editorial page reads the primary environment; without one there is nothing to show. */
export function NoEnvironment() {
  return (
    <SettingsPageContainer>
      <p className="text-sm text-muted-foreground">
        Conecta el entorno principal para ver y cambiar Editorial.
      </p>
    </SettingsPageContainer>
  );
}
