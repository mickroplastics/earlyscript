// @effect-diagnostics nodeBuiltinImport:off - plain synchronous Node so scripts and Electron launchers can load it.
/**
 * Earlyscript-only module: keeps every Earlyscript entry point off T3 Code's data directories.
 * T3 Code runs on the same machines with `~/.t3` and its Electron userData; an Earlyscript server,
 * dev runner or desktop app pointed there would migrate or lock T3 Code's databases.
 * Plain Node only: scripts/dev-runner.ts loads this file through type stripping.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface EarlyscriptHomeContext {
  readonly homeDirectory: string;
  /** Omitted: every platform's folders count, matched without case (refuses more, never less). */
  readonly platform?: NodeJS.Platform | undefined;
  /** `%APPDATA%` on Windows; defaults to `<home>\AppData\Roaming`. */
  readonly appDataDirectory?: string | undefined;
}

const pathApi = (platform: NodeJS.Platform) =>
  platform === "win32" ? NodePath.win32 : NodePath.posix;

const looksLikeWindowsPath = (value: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(value);

const platformsOf = (context: EarlyscriptHomeContext): ReadonlyArray<NodeJS.Platform> =>
  context.platform !== undefined
    ? [context.platform]
    : looksLikeWindowsPath(context.homeDirectory)
      ? ["win32"]
      : ["linux", "darwin"];

/** T3 Code's home and its Electron userData folders (release and development builds). */
function t3CodeDataDirectories(context: EarlyscriptHomeContext): ReadonlyArray<string> {
  const directories = platformsOf(context).flatMap((platform) => {
    const path = pathApi(platform);
    const home = context.homeDirectory;
    const userDataRoot =
      platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : platform === "win32"
          ? (context.appDataDirectory ?? path.join(home, "AppData", "Roaming"))
          : path.join(home, ".config");
    return [
      path.join(home, ".t3"),
      path.join(userDataRoot, "t3code"),
      path.join(userDataRoot, "t3code-dev"),
    ];
  });
  return [...new Set(directories)];
}

const realPathOrSelf = (candidate: string): string => {
  try {
    return NodeFS.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
};

/** The T3 Code directory that holds `candidate` (or is it), if any. Follows symlinks. */
export function findT3CodeDataDirectory(
  candidate: string,
  context: EarlyscriptHomeContext,
): string | undefined {
  const path = pathApi(platformsOf(context)[0]!);
  const foldCase = context.platform !== "linux";
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return foldCase ? resolved.toLowerCase() : resolved;
  };
  const isWithin = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const candidates = new Set([normalize(candidate), normalize(realPathOrSelf(candidate))]);
  for (const directory of t3CodeDataDirectories(context)) {
    const parents = new Set([normalize(directory), normalize(realPathOrSelf(directory))]);
    for (const parent of parents) {
      for (const child of candidates) {
        if (isWithin(parent, child)) return directory;
      }
    }
  }
  return undefined;
}

export class T3CodeDataDirectoryError extends Error {
  readonly directory: string;
  readonly t3CodeDirectory: string;

  constructor(directory: string, t3CodeDirectory: string) {
    super(
      `Earlyscript no puede usar ${directory} como carpeta de datos: pertenece a T3 Code (${t3CodeDirectory}). ` +
        "Usa la carpeta por defecto (~/.earlyscript) o indica otra con --home-dir o EARLYSCRIPT_HOME.",
    );
    this.name = "T3CodeDataDirectoryError";
    this.directory = directory;
    this.t3CodeDirectory = t3CodeDirectory;
  }
}

/** Returns `directory` unchanged, or throws when it is T3 Code's data directory or lies inside it. */
export function assertEarlyscriptDataDirectory(
  directory: string,
  context: EarlyscriptHomeContext,
): string {
  const t3CodeDirectory = findT3CodeDataDirectory(directory, context);
  if (t3CodeDirectory !== undefined) {
    throw new T3CodeDataDirectoryError(directory, t3CodeDirectory);
  }
  return directory;
}
