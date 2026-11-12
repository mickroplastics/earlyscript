import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";

/** The dossier's closed-by-default disclosures: weeks by source, judges, provenance. */
export function DossierDisclosure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible className="flex min-w-0 flex-col">
      <CollapsibleTrigger className="group/disclosure inline-flex items-center gap-1 self-start rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform group-data-panel-open/disclosure:rotate-90"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-3">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
