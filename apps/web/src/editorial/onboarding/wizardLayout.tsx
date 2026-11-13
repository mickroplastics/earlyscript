import { useId, type ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The frame every step shares: what the operator chooses on the left, a fixed example of what
 * it produces on the right, and the step's actions in a bar at the bottom that never scrolls.
 */
export function StepLayout({
  title,
  description,
  children,
  aside,
  footer,
  testId,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly aside: ReactNode;
  readonly footer: ReactNode;
  readonly testId: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="min-h-0 overflow-y-auto px-7 py-7" data-wizard-scroll>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
          <div className="mt-6 flex flex-col gap-6">{children}</div>
        </div>
        <aside className="min-h-0 overflow-y-auto border-t bg-muted/40 px-6 py-7 md:border-t-0 md:border-l">
          {aside}
        </aside>
      </div>
      <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-t px-6 py-3">
        {footer}
      </div>
    </div>
  );
}

/** «FUENTES QUE SE LEERÁN»: the small heading over a group of controls or an example. */
export function SectionLabel({
  children,
  tone = "muted",
  id,
}: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "accent" | "success" | "error";
  readonly id?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "text-2xs font-semibold tracking-wider uppercase",
        tone === "muted" && "text-muted-foreground",
        tone === "accent" && "text-primary",
        tone === "success" && "text-success-foreground",
        tone === "error" && "text-error-foreground",
      )}
    >
      {children}
    </h2>
  );
}

/** A labelled group of the left column. */
export function StepSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5">
      <SectionLabel id={id}>{label}</SectionLabel>
      {children}
    </section>
  );
}
