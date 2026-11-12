import type { EditorialResultsSummary } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { closingStrip, domainNote } from "./results.logic";
import { ResultsBox } from "./resultsMarks";
import { shortResultsDate, shortResultsDayRange } from "./resultsOverview.logic";

const yearDate = (iso: string) => shortResultsDate(iso, { year: true });

/**
 * The one caveat every figure above carries, fixed under the cards, with the sample and its
 * limits one click away; decisions out of domain warn apart.
 */
export function ResultsCaveat({ summary }: { readonly summary: EditorialResultsSummary }) {
  const [open, setOpen] = useState(false);
  const outOfDomain = domainNote(summary);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Collapsible open={open} onOpenChange={setOpen}>
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>
            Cifras descriptivas de un solo operador, sobre la decisión vigente de cada hilo. Cada
            modo tiene temas distintos: no mide un efecto. La comparación de la tesis es por pares,
            sobre el mismo tema y con revisores externos.
          </AlertDescription>
          <AlertAction>
            <CollapsibleTrigger render={<Button variant="link" size="xs" />}>
              {/* Both labels share one cell, so the button keeps its width and the text its breaks. */}
              <span className="grid justify-items-end underline underline-offset-2">
                <span className="col-start-1 row-start-1">
                  {open ? "Ocultar" : "Muestra y límites"}
                </span>
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  Muestra y límites
                </span>
              </span>
            </CollapsibleTrigger>
          </AlertAction>
        </Alert>
        <CollapsiblePanel>
          <ResultsBox className="mt-2 grid gap-4 @3xl:grid-cols-3">
            {closingStrip(summary, yearDate, shortResultsDayRange).map((block) => (
              <div key={block.title} className="flex min-w-0 flex-col gap-1">
                <h3 className="text-xs font-medium text-foreground">{block.title}</h3>
                <p className="text-xs text-muted-foreground tabular-nums">{block.text}</p>
              </div>
            ))}
          </ResultsBox>
        </CollapsiblePanel>
      </Collapsible>
      {outOfDomain ? (
        <Alert variant="warning">
          <InfoIcon />
          <AlertDescription>{outOfDomain}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
