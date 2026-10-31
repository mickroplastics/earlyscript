import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { DatabaseIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";
import { videoFailureText } from "./videoThread.logic";
import { editorialVideoEnvironment } from "./videoState";

/**
 * What a manual thread keeps and how it goes away: the text of the header popover and of the
 * deleted-thread page. Keep it in step with §24 of docs/upstream-divergence.md.
 */
function ManualRetentionText() {
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="font-medium text-foreground text-sm">Qué guarda este hilo</p>
      <p className="text-muted-foreground">
        En <code>editorial.sqlite</code>, junto al estado del servidor: cada página que cargó el
        navegador (dirección completa, título, pestaña y hora; <code>editorial_browser_visits</code>
        ), tus capturas con su nota (<code>editorial_captures</code>), cada versión del guion (
        <code>editorial_script_versions</code>
        ), la decisión con sus tiempos (<code>editorial_decisions</code>), los tramos del reloj (
        <code>editorial_work_intervals</code>), los resultados (<code>editorial_video_results</code>
        ) y el registro de eventos (<code>editorial_events</code>). Las copias de versiones
        decididas que abriste quedan en <code>editorial/versions/</code> del directorio de estado.
      </p>
      <p className="text-muted-foreground">
        No hay plazo de borrado automático. Borrar el hilo en la barra lateral no borra estos datos.
      </p>
      <p className="text-muted-foreground">
        «Quitar» oculta una captura de la lista; sus datos siguen guardados. «Borrar datos del hilo»
        los elimina de verdad: primero borra el hilo y después usa ese botón en la página que
        aparece. El archivo del guion en el proyecto no se toca.
      </p>
    </div>
  );
}

/** The header button that opens the retention text. */
export function ManualRetentionInfo() {
  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="ghost-muted" />}>
        <DatabaseIcon aria-hidden />
        Datos guardados
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-96">
        <ManualRetentionText />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Takes the manual workspace's place once the T3 thread is deleted, by URL or from another
 * client: nothing to work on, the record still on disk, and the way to delete it for good.
 */
export function DeletedManualThread({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const purge = useAtomCommand(editorialVideoEnvironment.purge, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [purged, setPurged] = useState(false);

  const purgeNow = async () => {
    setBusy(true);
    const result = await purge({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setBusy(false);
    setConfirming(false);
    if (result._tag === "Success") {
      setPurged(true);
      toastManager.add({ type: "success", title: "Datos del hilo borrados" });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "No se borraron los datos del hilo",
        description: videoFailureText(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      data-testid="manual-thread-deleted"
    >
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Este hilo manual se borró</EmptyTitle>
          <EmptyDescription>
            {purged
              ? "Sus datos editoriales también se borraron."
              : "No se puede seguir trabajando en él. Sus datos editoriales siguen guardados hasta que los borres."}
          </EmptyDescription>
        </EmptyHeader>
        {purged ? null : (
          <div className="max-w-lg text-left">
            <ManualRetentionText />
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/" })}>
            Ir a Hilos
          </Button>
          {purged ? null : (
            <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
              <Trash2Icon aria-hidden />
              Borrar datos del hilo
            </Button>
          )}
        </div>
      </Empty>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Borrar los datos de este hilo?</AlertDialogTitle>
            <AlertDialogDescription>
              Se eliminan de editorial.sqlite las páginas visitadas, las capturas (también las
              quitadas), las versiones del guion y sus copias, la decisión, los resultados, los
              tramos del reloj y los eventos del hilo. Queda solo un evento con los recuentos. No se
              puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancelar</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void purgeNow()}>
              Sí, borrar los datos
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
