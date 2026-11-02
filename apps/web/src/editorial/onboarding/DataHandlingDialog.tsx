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
 * Kept true against the network inventory in docs/upstream-divergence.md (flags section).
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
      <DialogPopup>
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
              <ul className="list-disc space-y-1 ps-5">
                <li>Las peticiones de captura a las fuentes que actives.</li>
                <li>
                  Los textos de las tendencias, solo al proveedor de modelos que elijas, cuando
                  redacta presentaciones o guiones.
                </li>
                <li>La descarga del modelo de embeddings desde Hugging Face, una vez.</li>
                <li>
                  Consultas técnicas heredadas de T3 Code, sin tus textos: el catálogo de modelos y
                  la tabla de precios desde GitHub, y los iconos de los sitios enlazados desde
                  Google, que recibe sus dominios.
                </li>
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

/** The wizard's privacy line: short, true, and a way to read the details. */
export function PrivacyNote() {
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      Tus datos quedan en esta máquina, sin telemetría ni analítica. Los textos de las tendencias
      solo van al proveedor de modelos que elijas al redactar.{" "}
      <DataHandlingDialog
        trigger={
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground focus-visible:text-foreground"
          />
        }
      />
    </p>
  );
}
