import type { EditorialProfileVersion } from "@t3tools/contracts";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { EngineScoringPanel, ProfileForm, ProfileHistoryList } from "../profile/ProfileForm";
import type { ProfileEditor } from "../profile/useProfileEditor";
import { EDITORIAL_PROFILE_SECTION_ID } from "./settingsEntry";

const TITLE = "Perfil del estudio";

export interface StudioProfileSettingsViewProps {
  readonly editor: ProfileEditor;
  readonly formId: string;
  readonly history: ReadonlyArray<EditorialProfileVersion>;
  readonly onSave: () => void;
}

/**
 * The single-page profile section from before Settings › Editorial split into pages. Not mounted:
 * «Mi canal» (ChannelSettings.tsx) replaced it. Kept only because the wizard's tests in
 * onboarding/StudioStep.browser.test.tsx render it; delete both together.
 */
export function StudioProfileSettingsView({
  editor,
  formId,
  history,
  onSave,
}: StudioProfileSettingsViewProps) {
  const { view, values } = editor;
  if (view === null || values === null) {
    return (
      <SettingsSection id={EDITORIAL_PROFILE_SECTION_ID} title={TITLE}>
        <SettingsRow
          title={editor.loadError ? "No se pudo leer el perfil" : "Cargando"}
          description={editor.loadError ?? undefined}
          control={
            editor.loadError ? (
              <Button size="xs" variant="outline" onClick={editor.retry}>
                Reintentar
              </Button>
            ) : null
          }
        />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection id={EDITORIAL_PROFILE_SECTION_ID} title={TITLE}>
      <SettingsRow
        title="Canal y temas"
        description="Qué tendencias llegan a la bandeja y para quién redacta el asistente. Guardar crea una versión nueva: la corrida nocturna puntúa con ella y las redacciones anteriores quedan marcadas como desactualizadas."
        className="pb-3"
      >
        <div className="mt-3 max-w-2xl space-y-4">
          <ProfileForm
            formId={formId}
            values={values}
            onChange={editor.setValues}
            errors={editor.errors}
            version={view.active}
            edited={editor.edited}
            disabled={editor.saving}
            readOnly={editor.readOnly}
          />
          {editor.failure ? (
            <p className="text-sm text-destructive-foreground" role="alert">
              {editor.failure}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!editor.edited || editor.saving || editor.readOnly}
              onClick={editor.discard}
            >
              Descartar cambios
            </Button>
            <Button
              size="sm"
              disabled={!editor.edited || editor.saving || editor.readOnly}
              onClick={onSave}
            >
              {editor.saving ? <Spinner size="sm" /> : null}
              Guardar versión {view.active.version + 1}
            </Button>
          </div>
          <EngineScoringPanel
            scoring={view.scoring}
            note="Solo lectura hasta el análisis de sensibilidad; entonces se ajustarán aquí."
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Versiones"
        description="Cada expediente guarda el hash del perfil con que se puntuó."
      >
        <ProfileHistoryList versions={history} className="mt-1 max-w-2xl" />
      </SettingsRow>
    </SettingsSection>
  );
}
