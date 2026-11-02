import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Placeholder: the engine stream replaces it. Shows the state of the local embedding model
 * (missing, downloading with progress, ready) and lets the operator start the download.
 * `onReady` fires when the model is present on disk.
 */
export function ModelDownloadCard({
  environmentId: _environmentId,
  onReady,
}: {
  readonly environmentId: EnvironmentId;
  readonly onReady: (ready: boolean) => void;
}) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-muted-foreground">Descarga del modelo en construcción.</p>
      <button type="button" onClick={() => onReady(true)}>
        Marcar como listo
      </button>
    </div>
  );
}
