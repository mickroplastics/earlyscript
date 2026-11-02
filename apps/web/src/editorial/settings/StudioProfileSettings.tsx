import type { EditorialProfileVersion, EnvironmentId } from "@t3tools/contracts";
import { useId } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { profileVersionLabel } from "../profile/profileForm.logic";
import { EngineScoringPanel, ProfileForm, ProfileHistoryList } from "../profile/ProfileForm";
import { editorialProfileEnvironment } from "../profile/profileState";
import { useProfileEditor, type ProfileEditor } from "../profile/useProfileEditor";
import { EDITORIAL_PROFILE_SECTION_ID } from "./settingsEntry";

const TITLE = "Perfil del estudio";

export interface StudioProfileSettingsViewProps {
  readonly editor: ProfileEditor;
  readonly formId: string;
  readonly history: ReadonlyArray<EditorialProfileVersion>;
  readonly onSave: () => void;
}

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

function StudioProfileSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const formId = useId();
  const editor = useProfileEditor(environmentId, formId);
  const history = useEnvironmentQuery(
    editorialProfileEnvironment.history({ environmentId, input: {} }),
  );
  const onSave = () =>
    void editor.save().then((outcome) => {
      if (outcome._tag === "saved") {
        toastManager.add({ type: "success", title: `${profileVersionLabel(outcome.active)}.` });
      }
    });
  return (
    <StudioProfileSettingsView
      editor={editor}
      formId={formId}
      history={history.data?.versions ?? []}
      onSave={onSave}
    />
  );
}

/** Settings › Editorial › Perfil del estudio, on the primary environment, which runs the engine. */
export function StudioProfileSettings() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <StudioProfileSettingsForEnvironment environmentId={environmentId} />;
}
