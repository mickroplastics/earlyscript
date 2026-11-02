// @effect-diagnostics globalDate:off - throttles progress lines by wall time.
import { prepareModel, type ModelFile, type ModelProgress } from "./model.ts";

/** A progress line at least this often while bytes arrive… */
export const PROGRESS_INTERVAL_MS = 500;
/** …or after this many bytes, whichever comes first. */
export const PROGRESS_BYTES = 8 * 1024 * 1024;

/** Why `engine model prepare` stopped, for the operator; `message` keeps the detail. */
export type ModelErrorCode = "network" | "http" | "hash" | "disk" | "other";

export type ModelCommandLine =
  | ModelProgress
  | { readonly done: true; readonly path: string }
  | { readonly error: { readonly code: ModelErrorCode; readonly message: string } };

const DISK_ERRORS = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "EDQUOT"]);

export function classifyModelError(error: unknown): {
  readonly code: ModelErrorCode;
  readonly message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && DISK_ERRORS.has(code)) return { code: "disk", message };
  if (message.startsWith("Model hash mismatch")) return { code: "hash", message };
  if (message.startsWith("Model download failed: HTTP")) return { code: "http", message };
  if (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
  ) {
    const cause = (error as { cause?: { message?: unknown } }).cause?.message;
    return {
      code: "network",
      message: typeof cause === "string" ? `${message}: ${cause}` : message,
    };
  }
  return { code: "other", message };
}

export interface ModelCommandOptions {
  readonly baseUrl?: string;
  readonly files?: ReadonlyArray<ModelFile>;
  readonly now?: () => number;
}

/**
 * `engine model prepare`: downloads what is missing and writes one JSON line per progress
 * step (throttled, plus the first and the last byte of every file) and `{ done, path }`.
 */
export async function prepareModelCommand(
  modelDir: string,
  write: (line: ModelCommandLine) => void,
  options: ModelCommandOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  let lastAt = Number.NEGATIVE_INFINITY;
  let lastBytes = Number.NEGATIVE_INFINITY;
  let lastFile = "";
  const path = await prepareModel(modelDir, true, {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.files === undefined ? {} : { files: options.files }),
    onProgress: (progress) => {
      const at = now();
      const fileEnd = progress.file !== lastFile || progress.bytesDone === progress.bytesTotal;
      if (
        !fileEnd &&
        at - lastAt < PROGRESS_INTERVAL_MS &&
        progress.bytesDone - lastBytes < PROGRESS_BYTES
      ) {
        return;
      }
      lastAt = at;
      lastBytes = progress.bytesDone;
      lastFile = progress.file;
      write(progress);
    },
  });
  write({ done: true, path });
  return path;
}
