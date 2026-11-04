import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, ImageDownIcon } from "lucide-react";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { readLocalApi } from "../../localApi";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { editorialResultsEnvironment } from "../resultsState";
import {
  bytesToBase64,
  type FigureBody,
  type FigureContext,
  type FigureFormat,
  type FigureSpec,
} from "./figureExport.logic";
import {
  isPermissionFailure,
  PERMISSION_FAILURE_TEXT,
  targetFailureText,
} from "./evidenceExport.logic";
import { downloadFigureFiles, figureFile, type FigureFile } from "./figureFiles";

/** How a save ended: written or downloaded somewhere, cancelled in the folder dialog, or failed. */
export type FigureSaveOutcome =
  | { readonly _tag: "saved"; readonly where: string; readonly toFolder: boolean }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "failed"; readonly message: string };

interface FiguresContextValue {
  readonly threads: number | null;
  /** Desktop app over its own server: files go to a folder the native dialog picks. */
  readonly toFolder: boolean;
  readonly register: (spec: FigureSpec, element: HTMLElement | null) => () => void;
  /** The registered figures in page order. */
  readonly figures: () => ReadonlyArray<FigureSpec>;
  readonly save: (files: ReadonlyArray<FigureFile>, zipName: string) => Promise<FigureSaveOutcome>;
}

async function downloadOutcome(
  files: ReadonlyArray<FigureFile>,
  zipName: string,
): Promise<FigureSaveOutcome> {
  try {
    return { _tag: "saved", where: await downloadFigureFiles(files, zipName), toFolder: false };
  } catch {
    return { _tag: "failed", message: "El navegador no pudo preparar la descarga." };
  }
}

/** Without a provider a figure still downloads; it just has no thread count and no registry. */
const FiguresContext = createContext<FiguresContextValue>({
  threads: null,
  toFolder: false,
  register: () => () => {},
  figures: () => [],
  save: downloadOutcome,
});

function figureSaveFailureText(error: unknown): string {
  if (isPermissionFailure(error)) return PERMISSION_FAILURE_TEXT;
  const reason =
    typeof error === "object" && error !== null && "reason" in error
      ? (error as { readonly reason: unknown }).reason
      : null;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { readonly message: unknown }).message)
      : null;
  switch (reason) {
    case "target":
      return targetFailureText(message);
    case "too-large":
      return "Las figuras pesan demasiado para enviarlas en una sola llamada.";
    case "unavailable":
      return "Este entorno no tiene los servicios editoriales montados.";
    default:
      return "El entorno no respondió. Inténtalo de nuevo en un momento.";
  }
}

/**
 * Holds the figures of a page for «Guardar todas las figuras» and decides where files go:
 * on the desktop app over its own server, into a folder the native dialog picks (the server
 * writes them); anywhere else, a browser download.
 */
export function FiguresProvider({
  environmentId,
  threads,
  children,
}: {
  readonly environmentId: EnvironmentId;
  /** Closed threads behind the page, for the provenance line of every image. */
  readonly threads: number;
  readonly children: ReactNode;
}) {
  const registry = useRef(new Map<string, { spec: FigureSpec; element: HTMLElement | null }>());
  const lastFolder = useRef<string | null>(null);
  const saveFigures = useAtomCommand(editorialResultsEnvironment.saveFigures, {
    reportFailure: false,
  });
  const environment = useEnvironment(environmentId);
  const toFolder =
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    environment !== null &&
    isDesktopLocalConnectionTarget(environment.entry.target);

  const value: FiguresContextValue = {
    threads,
    toFolder,
    register: (spec, element) => {
      registry.current.set(spec.id, { spec, element });
      return () => {
        if (registry.current.get(spec.id)?.spec === spec) registry.current.delete(spec.id);
      };
    },
    figures: () =>
      [...registry.current.values()]
        .toSorted((a, b) =>
          a.element && b.element
            ? a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING
              ? -1
              : 1
            : 0,
        )
        .map((entry) => entry.spec),
    save: async (files, zipName) => {
      if (!toFolder) return downloadOutcome(files, zipName);
      const directory =
        (await readLocalApi()?.dialogs.pickFolder({ initialPath: lastFolder.current })) ?? null;
      if (directory === null) return { _tag: "cancelled" };
      lastFolder.current = directory;
      const result = await saveFigures({
        environmentId,
        input: {
          directory,
          files: files.map((file) => ({ name: file.name, base64: bytesToBase64(file.bytes) })),
        },
      });
      if (result._tag !== "Success") {
        return isAtomCommandInterrupted(result)
          ? { _tag: "cancelled" }
          : { _tag: "failed", message: figureSaveFailureText(squashAtomCommandFailure(result)) };
      }
      const written = result.value;
      return {
        _tag: "saved",
        toFolder: true,
        where:
          written.files.length === 1
            ? `${written.directory.replace(/[\\/]+$/, "")}/${written.files[0]!.name}`
            : written.directory,
      };
    },
  };
  return <FiguresContext value={value}>{children}</FiguresContext>;
}

/** The figures registered on the page, to save them all; see `FiguresExportButton`. */
export function useFigures(): FiguresContextValue {
  return use(FiguresContext);
}

type SaveState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "saving" }
  | { readonly _tag: "saved"; readonly text: string }
  | { readonly _tag: "failed"; readonly message: string };

export function figureContext(threads: number | null): FigureContext {
  return { threads, exportedAt: new Date() };
}

/**
 * Wraps one chart of a page: a row with the figure's title and «Guardar imagen» (PNG or SVG),
 * then the chart as the page draws it (or nothing, when the frame sits just before the chart). The image is not a screenshot: `figure` is the data the
 * print version draws again in light colours on white (see `figureExport.logic.ts`).
 *
 * Inside a `FiguresProvider`, the frame also joins «Guardar todas las figuras».
 */
export function FigureFrame({
  id,
  title,
  caption,
  figure,
  children,
}: {
  /** Lowercase slug, unique on the page; names the file `figura-<id>-<día>.png`. */
  readonly id: string;
  /** Title drawn on top of the image and shown beside the button. */
  readonly title: string;
  /** Caption for the report; goes to `figuras.md`, not into the image. */
  readonly caption: string;
  readonly figure: FigureBody;
  /**
   * The chart as the page draws it. Optional: placed right before an existing chart without
   * children, the frame is only its title row, and the page's markup stays untouched.
   */
  readonly children?: ReactNode;
}) {
  const figures = useFigures();
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SaveState>({ _tag: "idle" });
  const { register } = figures;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps this figure's registry entry for «Guardar todas las figuras» until unmount.
  useEffect(
    () => register({ id, title, caption, body: figure }, element.current),
    [register, id, title, caption, figure],
  );

  const save = async (format: FigureFormat) => {
    setState({ _tag: "saving" });
    let file: FigureFile;
    try {
      file = await figureFile(
        { id, title, caption, body: figure },
        figureContext(figures.threads),
        format,
      );
    } catch {
      setState({ _tag: "failed", message: "No se pudo dibujar la imagen en este navegador." });
      return;
    }
    const outcome = await figures.save([file], file.name);
    setState(
      outcome._tag === "saved"
        ? {
            _tag: "saved",
            text: outcome.toFolder
              ? `Guardada en ${outcome.where}`
              : `Descargada: ${outcome.where}`,
          }
        : outcome._tag === "failed"
          ? { _tag: "failed", message: outcome.message }
          : { _tag: "idle" },
    );
  };

  const titleId = `figure-${id}-title`;
  return (
    <div
      ref={element}
      {...(children === undefined ? {} : { role: "group", "aria-labelledby": titleId })}
      data-figure={id}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span id={titleId} className="min-w-0 text-xs text-muted-foreground">
          Figura: {title}
        </span>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={state._tag === "saving"}
                aria-label={`Guardar imagen: ${title}`}
              />
            }
          >
            <ImageDownIcon />
            {state._tag === "saving" ? "Guardando…" : "Guardar imagen"}
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void save("png")}>PNG para el informe</MenuItem>
            <MenuItem onClick={() => void save("svg")}>SVG vectorial</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {state._tag === "saved" ? (
        <p role="status" className="break-all text-xs text-muted-foreground">
          {state.text}
        </p>
      ) : state._tag === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          No se guardó la imagen. {state.message}
        </p>
      ) : null}
      {children}
    </div>
  );
}
