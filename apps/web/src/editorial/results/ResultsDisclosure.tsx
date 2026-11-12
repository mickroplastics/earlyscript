import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";

/**
 * A folded box for the long tables: closed by default, its content unmounts while closed so a
 * hidden table costs nothing. Never holds a figure (figures stay registered while hidden).
 */
export function ResultsDisclosure({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-start text-xs outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">{title}</span>
            {subtitle ? <span className="text-muted-foreground">{subtitle}</span> : null}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            {open ? "Ocultar" : "Mostrar"}
            <ChevronDownIcon
              aria-hidden
              className="size-3.5 transition-transform duration-150 group-data-[panel-open]:rotate-180"
            />
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex min-w-0 flex-col gap-2 px-3.5 pb-3.5">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
