import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { EngineScoringPanel, ProfileForm } from "../profile/ProfileForm";
import { useProfileEditor, type ProfileEditor } from "../profile/useProfileEditor";
import type { OnboardingStepProps } from "./steps";

/** What the shell records when the step is accepted: the version and the engine's hash. */
export interface StudioAcceptance {
  readonly profileVersion: number;
  readonly profileHash: string;
}

export interface StudioStepViewProps {
  readonly editor: ProfileEditor;
  readonly formId: string;
  readonly onBack: (() => void) | null;
  readonly onContinue: (acceptance: StudioAcceptance) => void;
}

export function StudioStepView({ editor, formId, onBack, onContinue }: StudioStepViewProps) {
  const { view, values } = editor;
  const submit = async () => {
    const outcome = await editor.save();
    if (outcome._tag === "saved") {
      onContinue({ profileVersion: outcome.active.version, profileHash: outcome.active.hash });
    }
  };
  return (
    <div className="flex min-h-0 flex-col" data-testid="studio-step">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Estudio</h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Qué tendencias llegan a la bandeja y para quién redacta el asistente. Viene con el perfil de
        Earlywindow; cada cambio guardado crea una versión nueva.
      </p>

      {/* No scroll of its own: the step grows inside the wizard dialog's single scroll. */}
      <div className="mt-4 space-y-5">
        {view === null || values === null ? (
          editor.loadError ? (
            <div className="space-y-2 py-6 text-sm" role="alert">
              <p className="text-foreground">No se pudo leer el perfil del estudio.</p>
              <p className="text-xs text-muted-foreground">{editor.loadError}</p>
              <Button size="xs" variant="outline" onClick={editor.retry}>
                Reintentar
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
              <Spinner size="sm" />
              Leyendo el perfil del estudio…
            </p>
          )
        ) : (
          <>
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
            <EngineScoringPanel
              scoring={view.scoring}
              note="Se ajustan en Ajustes › Editorial tras el análisis de sensibilidad."
            />
          </>
        )}
      </div>

      {editor.failure ? (
        <p className="mt-3 text-sm text-destructive-foreground" role="alert">
          {editor.failure}
        </p>
      ) : null}

      <div className="mt-5 flex items-center justify-between gap-2">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeftIcon className="size-3.5" />
            Atrás
          </Button>
        ) : (
          <span />
        )}
        <Button disabled={values === null || editor.saving} onClick={() => void submit()}>
          {editor.saving ? <Spinner size="sm" /> : null}
          {editor.edited ? "Guardar y continuar" : "Continuar"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Step 3 of the first-run wizard: the studio profile, saved as a new version when edited. */
export function StudioStep({ environmentId, onContinue, onBack }: OnboardingStepProps) {
  const formId = useId();
  const editor = useProfileEditor(environmentId, formId);
  return (
    <StudioStepView
      editor={editor}
      formId={formId}
      onBack={onBack}
      onContinue={(acceptance) => onContinue({ ...acceptance })}
    />
  );
}
