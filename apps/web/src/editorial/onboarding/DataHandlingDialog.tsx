import { XIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { DATA_OUTBOUND, outboundSentence } from "./dataOutbound";

const STATE_DIR = "~/.earlyscript";
const DATA_DIR = "~/earlyscript-data";

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="font-medium text-foreground text-sm">{title}</h3>
      <div className="space-y-1.5 text-muted-foreground text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function Path({ children }: { readonly children: string }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

/**
 * «Cómo se tratan tus datos»: where Earlyscript keeps its data and what leaves the machine.
 * What leaves the machine comes from dataOutbound.ts, the list the first-run step shows too.
 */
export function DataHandlingDialog({
  trigger,
  label = "Cómo se tratan tus datos",
}: {
  readonly trigger: ReactElement;
  readonly label?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger render={trigger}>{label}</DialogTrigger>
      {/* Its own close button: the automatic one is named "Close" and no translator covers this portal. */}
      <DialogPopup showCloseButton={false}>
        <DialogClose
          aria-label="Cerrar"
          className="absolute end-2 top-2"
          render={<Button size="icon" variant="ghost" />}
        >
          <XIcon />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>Cómo se tratan tus datos</DialogTitle>
          <DialogDescription>
            Earlyscript trabaja en esta máquina, para un solo operador.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <Section title="Dónde quedan">
              <p>
                La base, los ajustes y tus decisiones quedan en <Path>{STATE_DIR}</Path>. El corpus
                de tendencias, las corridas del motor y el modelo de embeddings quedan en{" "}
                <Path>{DATA_DIR}</Path>.
              </p>
            </Section>
            <Section title="Sin telemetría">
              <p>
                Earlyscript no envía telemetría ni analítica de uso. Las funciones de T3 Code que lo
                hacían están apagadas.
              </p>
            </Section>
            <Section title="Qué sale de esta máquina">
              {/* The same list as the «Datos y permisos» step (dataOutbound.ts). */}
              <ul className="list-disc space-y-1 ps-5">
                {DATA_OUTBOUND.filter((entry) => entry.origin === "earlyscript").map((entry) => (
                  <li key={entry.id} data-outbound-id={entry.id}>
                    {outboundSentence(entry)}
                  </li>
                ))}
              </ul>
              <p>Consultas técnicas heredadas de T3 Code, sin tus textos:</p>
              <ul className="list-disc space-y-1 ps-5">
                {DATA_OUTBOUND.filter((entry) => entry.origin === "t3").map((entry) => (
                  <li key={entry.id} data-outbound-id={entry.id}>
                    {outboundSentence(entry)}
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Cómo borrarlo">
              <p>
                Cierra Earlyscript y borra <Path>{STATE_DIR}</Path> y <Path>{DATA_DIR}</Path>.
              </p>
            </Section>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" />}>Cerrar</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
