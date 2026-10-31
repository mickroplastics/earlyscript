import type { EditorialVideoBrowserVisit, EditorialVideoCapture } from "@t3tools/contracts";
import { BookmarkPlusIcon, HistoryIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Collapsible, CollapsiblePanel } from "../components/ui/collapsible";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { hostOf, type CapturablePage } from "./manualMode.logic";
import { formatSavedAt } from "./videoThread.logic";

export interface ManualCaptureControls {
  readonly busy: boolean;
  /** Resolves true when the server kept the capture. */
  readonly onCapture: (capture: {
    readonly url: string;
    readonly title: string;
    readonly note: string;
  }) => Promise<boolean>;
  readonly onRemove: (captureId: string) => void;
}

function CaptureForm({
  page,
  busy,
  onCancel,
  onSave,
}: {
  readonly page: CapturablePage;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (title: string, note: string) => void;
}) {
  const [title, setTitle] = useState(page.title);
  const [note, setNote] = useState("");
  return (
    <form
      aria-label="Nueva captura"
      className="flex flex-col gap-1.5 rounded-lg border border-primary/40 bg-primary/4 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(title, note);
      }}
    >
      <Input
        size="compact"
        aria-label="Título"
        value={title}
        maxLength={1000}
        placeholder={hostOf(page.url)}
        onChange={(event) => setTitle(event.currentTarget.value)}
      />
      <p className="truncate text-muted-foreground text-xs">{page.url}</p>
      <Textarea
        size="sm"
        aria-label="Nota"
        placeholder="Tu nota: por qué importa"
        autoFocus
        autoComplete="off"
        maxLength={2000}
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave(title, note);
          }
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" size="xs" disabled={busy}>
          Guardar captura
        </Button>
      </div>
    </form>
  );
}

function VisitLog({ visits }: { readonly visits: ReadonlyArray<EditorialVideoBrowserVisit> }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleSectionHeader
        expanded={open}
        onClick={() => setOpen(!open)}
        accessory={<span className="text-muted-foreground tabular-nums">{visits.length}</span>}
      >
        <span className="inline-flex items-center gap-1">
          <HistoryIcon aria-hidden className="size-3.5" />
          Páginas abiertas
        </span>
      </CollapsibleSectionHeader>
      <CollapsiblePanel>
        {visits.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-xs">
            Cada página que abras en el navegador queda aquí con su hora.
          </p>
        ) : (
          <ol aria-label="Páginas abiertas" className="flex flex-col gap-1 px-2 py-1">
            {visits.map((visit) => (
              <li key={visit.visitId} className="flex min-w-0 gap-2 text-xs">
                <time className="shrink-0 text-muted-foreground tabular-nums">
                  {formatSavedAt(visit.visitedAt)}
                </time>
                <a
                  href={visit.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-foreground underline-offset-2 hover:underline"
                >
                  {visit.title ?? hostOf(visit.url)}
                </a>
              </li>
            ))}
          </ol>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * The quick capture list of a manual thread: "Capturar" takes the address and title of the
 * page open in the integrated browser, the operator writes the note. Below, folded, every page
 * the browser loaded, as the server recorded it. Read-only once the thread is decided.
 */
export function ManualCaptureList({
  captures,
  visits,
  page,
  readOnly,
  controls,
}: {
  readonly captures: ReadonlyArray<EditorialVideoCapture>;
  readonly visits: ReadonlyArray<EditorialVideoBrowserVisit>;
  /** The page open in the browser; null while none is. */
  readonly page: CapturablePage | null;
  readonly readOnly: boolean;
  readonly controls: ManualCaptureControls;
}) {
  const [draft, setDraft] = useState<CapturablePage | null>(null);
  return (
    <section aria-label="Capturas" className="flex min-h-0 flex-col gap-2">
      {captures.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Sin capturas todavía. Cada hallazgo, en una línea.
        </p>
      ) : (
        <ul aria-label="Tus capturas" className="flex flex-col gap-1.5">
          {captures.map((capture) => (
            <li
              key={capture.captureId}
              className="group flex min-w-0 items-start gap-2 rounded-lg border bg-card p-2"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <a
                  href={capture.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium text-foreground text-sm underline-offset-2 hover:underline"
                >
                  {capture.title ?? hostOf(capture.url)}
                </a>
                <p className="truncate text-muted-foreground text-xs">
                  <time className="tabular-nums">{formatSavedAt(capture.capturedAt)}</time> ·{" "}
                  {hostOf(capture.url)}
                  {capture.note ? ` · «${capture.note}»` : ""}
                </p>
              </div>
              {readOnly ? null : (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Quitar ${capture.title ?? hostOf(capture.url)}`}
                  disabled={controls.busy}
                  onClick={() => controls.onRemove(capture.captureId)}
                >
                  <XIcon aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {readOnly ? null : draft !== null ? (
        <CaptureForm
          key={draft.url}
          page={draft}
          busy={controls.busy}
          onCancel={() => setDraft(null)}
          onSave={(title, note) =>
            void controls
              .onCapture({ url: draft.url, title: title.trim(), note: note.trim() })
              .then((kept) => {
                if (kept) setDraft(null);
              })
          }
        />
      ) : (
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            variant="outline"
            className="justify-start"
            disabled={page === null || controls.busy}
            onClick={() => setDraft(page)}
          >
            <BookmarkPlusIcon aria-hidden />
            Capturar la página abierta
          </Button>
          <p className="text-muted-foreground text-xs">
            {page === null
              ? "Abre una página en el navegador para capturarla."
              : `Título y enlace se llenan solos desde ${hostOf(page.url)}; tú pones la nota.`}{" "}
            «Quitar» oculta una captura; sus datos siguen guardados.
          </p>
        </div>
      )}
      <VisitLog visits={visits} />
    </section>
  );
}
