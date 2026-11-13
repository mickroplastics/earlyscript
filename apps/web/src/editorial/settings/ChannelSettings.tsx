import type {
  EditorialEngineScoring,
  EditorialProfileVersion,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { scoringRows } from "../profile/profileForm.logic";
import { ProfileForm } from "../profile/ProfileForm";
import { editorialProfileEnvironment } from "../profile/profileState";
import { useProfileEditor, type ProfileEditor } from "../profile/useProfileEditor";
import { shortHash, versionChange } from "./channel.logic";
import { EditorialStatusStrip } from "./EditorialStatusStrip";
import { EDITORIAL_PROFILE_SECTION_ID } from "./settingsEntry";
import { NoEnvironment, SettingsPageHeader } from "./SettingsPageHeader";

const savedFormat = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function VersionHistory({
  id,
  versions,
}: {
  readonly id: string;
  readonly versions: ReadonlyArray<EditorialProfileVersion>;
}) {
  return (
    <div id={id} className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
      <ol aria-label="Versiones del perfil" className="divide-y divide-border/50">
        {versions.map((version, index) => (
          <li key={version.version} className="flex items-start gap-3 px-4 py-3">
            <span
              aria-hidden
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
                version.active
                  ? "border-success/60 text-success-foreground"
                  : "text-muted-foreground",
              )}
            >
              {version.version}
            </span>
            <div className="min-w-0 space-y-0.5">
              <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        tabIndex={0}
                        className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    }
                  >
                    Versión {version.version}
                    <span className="sr-only">, huella {shortHash(version.hash)}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    Huella <code className="font-mono">{shortHash(version.hash)}</code>
                  </TooltipPopup>
                </Tooltip>
                {version.active ? (
                  <Badge size="sm" variant="success">
                    En uso
                  </Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {version.origin === "earlywindow" && versions[index + 1] === undefined
                  ? versionChange(version, undefined)
                  : `${savedFormat.format(new Date(version.createdAt))} · ${versionChange(version, versions[index + 1])}`}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p className="border-t border-border/50 px-4 py-2.5 text-xs text-muted-foreground">
        Cada tendencia guarda la versión con que se eligió.
      </p>
    </div>
  );
}

function FilterPanel({ scoring }: { readonly scoring: EditorialEngineScoring | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border/50">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="flex-1">Cómo se filtra</span>
          <span className="text-xs text-muted-foreground">solo lectura</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-2 px-4 pb-3">
            {scoring === null ? (
              <p className="text-xs text-muted-foreground">
                Aparecerá cuando la revisión nocturna esté instalada en este equipo.
              </p>
            ) : (
              <>
                <dl className="divide-y divide-border/50">
                  {scoringRows(scoring).map((row) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-2"
                    >
                      <dt className="text-sm text-foreground">{row.label}</dt>
                      <dd className="row-span-2 text-sm text-foreground tabular-nums">
                        {row.value}
                      </dd>
                      {row.description ? (
                        <dd className="text-xs leading-normal text-muted-foreground">
                          {row.description}
                        </dd>
                      ) : null}
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">
                  Se ajustarán aquí tras el análisis de sensibilidad.
                </p>
              </>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

interface ChannelProfileViewProps {
  readonly editor: ProfileEditor;
  readonly formId: string;
  readonly history: ReadonlyArray<EditorialProfileVersion>;
  readonly onSave: () => void;
}

/** «Mi canal»: the profile form, its versions behind «Historial», and a bar to save changes. */
function ChannelProfileView({ editor, formId, history, onSave }: ChannelProfileViewProps) {
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const { view, values } = editor;
  const next = view === null ? null : view.active.version + 1;
  return (
    <section id={EDITORIAL_PROFILE_SECTION_ID} tabIndex={-1} className="space-y-4 outline-none">
      <SettingsPageHeader
        title="Mi canal"
        description="Lo que la app usa para elegir tus tendencias y escribir para tu audiencia."
        action={
          view === null ? null : (
            <div className="flex items-center gap-2">
              <Badge variant="success">Versión {view.active.version}</Badge>
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={historyOpen}
                aria-controls={historyOpen ? historyId : undefined}
                onClick={() => setHistoryOpen(!historyOpen)}
              >
                {historyOpen ? "Ocultar historial" : "Historial"}
              </Button>
            </div>
          )
        }
      />
      {historyOpen ? <VersionHistory id={historyId} versions={history} /> : null}
      {view === null || values === null ? (
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3 text-sm">
          <span className="flex-1 text-muted-foreground">
            {editor.loadError ? `No se pudo leer el perfil: ${editor.loadError}` : "Cargando…"}
          </span>
          {editor.loadError ? (
            <Button size="xs" variant="outline" onClick={editor.retry}>
              Reintentar
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
          <div className="px-4 py-4">
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
          </div>
          <FilterPanel scoring={view.scoring} />
        </div>
      )}
      {editor.edited && !editor.readOnly && next !== null ? (
        <div
          role="region"
          aria-label="Cambios sin guardar"
          className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg/10"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Cambios sin guardar.</span> La próxima
            revisión usará la versión {next}; los resúmenes ya escritos quedarán marcados como
            anteriores.
            {editor.failure ? (
              <span role="alert" className="block text-destructive-foreground">
                {editor.failure}
              </span>
            ) : null}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" disabled={editor.saving} onClick={editor.discard}>
              Descartar
            </Button>
            <Button size="sm" disabled={editor.saving} onClick={onSave}>
              {editor.saving ? <Spinner size="sm" /> : null}
              Guardar versión {next}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ChannelProfileForEnvironment({
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
        toastManager.add({
          type: "success",
          title: `Versión ${outcome.active.version} guardada`,
          description: "La próxima revisión nocturna la usará.",
        });
      }
    });
  return (
    <ChannelProfileView
      editor={editor}
      formId={formId}
      history={history.data?.versions ?? []}
      onSave={onSave}
    />
  );
}

/** The channel profile alone, on the primary environment, which runs the review. */
export function ChannelProfileSettings() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <ChannelProfileForEnvironment environmentId={environmentId} />;
}

/** Settings › Editorial › Mi canal: the status of everything first, then the profile. */
export function ChannelSettingsPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return <NoEnvironment />;
  return (
    <SettingsPageContainer className="gap-6">
      <EditorialStatusStrip environmentId={environmentId} />
      <ChannelProfileForEnvironment environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
