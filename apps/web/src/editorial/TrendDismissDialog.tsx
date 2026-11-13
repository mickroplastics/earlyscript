import { EDITORIAL_REASON_MAX_CHARS } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";

/** The reason is part of the record of what the operator chose, so it is required. */
const DISMISS_REASON_MIN_CHARS = 3;

function dismissReasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < DISMISS_REASON_MIN_CHARS) {
    return `Escribe el motivo, al menos ${DISMISS_REASON_MIN_CHARS} caracteres.`;
  }
  if (length > EDITORIAL_REASON_MAX_CHARS) {
    return `El motivo admite hasta ${EDITORIAL_REASON_MAX_CHARS} caracteres.`;
  }
  return null;
}

/**
 * "Descartar…": asks for the reason and confirms. Mounted only while open, so each opening
 * starts empty. `onConfirm` resolves to whether the server accepted the dismissal; the dialog
 * stays open on a failure so the reason is not lost.
 */
export function TrendDismissDialog({
  trendTitle,
  onConfirm,
  onClose,
}: {
  readonly trendTitle: string;
  readonly onConfirm: (reason: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={async (event) => {
            event.preventDefault();
            const invalid = dismissReasonError(reason);
            setError(invalid);
            if (invalid !== null || pending) return;
            setPending(true);
            const accepted = await onConfirm(reason.trim());
            setPending(false);
            if (accepted) onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>Descartar tendencia</DialogTitle>
            <DialogDescription>
              «{trendTitle}» pasa a Descartadas. Puedes reabrirla después; el motivo queda grabado.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-reason`}>Motivo</Label>
              <Textarea
                id={`${id}-reason`}
                value={reason}
                maxLength={EDITORIAL_REASON_MAX_CHARS}
                aria-invalid={error !== null}
                aria-describedby={error !== null ? `${id}-error` : undefined}
                placeholder="Ya cubierto, fuera del tema del canal, poca evidencia…"
                onChange={(event) => {
                  setReason(event.target.value);
                  if (error !== null) setError(dismissReasonError(event.target.value));
                }}
              />
              {error !== null ? (
                <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              Descartar
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
