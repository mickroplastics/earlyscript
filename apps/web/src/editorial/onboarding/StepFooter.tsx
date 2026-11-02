import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";

/**
 * «Atrás» and the step's main action, as Datos, Estudio and Motor draw them: arrows, «Atrás»
 * as a ghost button, and «Guardando…» with a spinner while the step saves.
 */
export function StepFooter({
  onBack,
  label,
  onContinue,
  disabled,
  saving,
  autoFocus = false,
}: {
  readonly onBack: (() => void) | null;
  readonly label: string;
  readonly onContinue: () => void;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly autoFocus?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      {onBack ? (
        <Button variant="ghost" onClick={onBack} disabled={saving}>
          <ArrowLeftIcon className="size-3.5" />
          Atrás
        </Button>
      ) : (
        <span />
      )}
      <Button autoFocus={autoFocus} disabled={disabled || saving} onClick={onContinue}>
        {saving ? (
          <>
            <span aria-hidden className="flex">
              <Spinner size="sm" />
            </span>
            Guardando…
          </>
        ) : (
          <>
            {label}
            <ArrowRightIcon className="size-3.5" />
          </>
        )}
      </Button>
    </div>
  );
}
