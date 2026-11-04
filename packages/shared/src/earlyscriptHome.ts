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

/** The path rules of the machine this runs on. */
const hostPathApi = NodePath.sep === "\\" ? NodePath.win32 : NodePath.posix;
const MAX_LINKS = 40;
const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
/** A missing component (or a file where a folder should be): nothing below it exists yet. */
const isMissing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes(errorCode(error));

type Resolution =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "unverifiable"; readonly detail: string };

/**
 * Where `candidate` lands once every existing link (dangling ones too) is followed, its missing
 * tail added back; `link/..` is the parent of the link's target, as for the kernel. Paths of
 * another platform are compared lexically. Any error but a missing component is unverifiable.
 */
function resolveOnDisk(candidate: string, path: NodePath.PlatformPath): Resolution {
  if (path !== hostPathApi) return { kind: "resolved", path: path.resolve(candidate) };
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : `${process.cwd()}${path.sep}${candidate}`;
  const separators = path === NodePath.win32 ? /[\\/]+/u : /\/+/u;
  const split = (value: string) => value.split(separators).filter((part) => part.length > 0);
  const rootOf = (value: string) => path.parse(value).root;
  let resolved = rootOf(absolute);
  const pending = split(absolute.slice(resolved.length));
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, part);
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(next);
    } catch (error) {
      if (isMissing(error)) return { kind: "resolved", path: path.join(next, ...pending) };
      return { kind: "unverifiable", detail: `${errorCode(error) || "error"} en ${next}` };
    }
    if (!stat.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    if (++links > MAX_LINKS) {
      return { kind: "unverifiable", detail: `demasiados enlaces simbólicos en ${candidate}` };
    }
    try {
      resolved = NodeFS.realpathSync.native(next);
      continue;
    } catch (error) {
      if (!isMissing(error)) {
        return { kind: "unverifiable", detail: `${errorCode(error) || "error"} en ${next}` };
      }
    }
    // A dangling link: what it would point to once its target is created.
    let target: string;
    try {
      target = NodeFS.readlinkSync(next).replace(/^\\\\\?\\/u, "");
    } catch (error) {
      return { kind: "unverifiable", detail: `${errorCode(error) || "error"} en ${next}` };
    }
    if (path.isAbsolute(target)) resolved = rootOf(target);
    pending.unshift(...split(path.isAbsolute(target) ? target.slice(resolved.length) : target));
  }
  return { kind: "resolved", path: resolved };
}

/** Result of checking a directory Earlyscript is about to use or create. */
export type T3CodeDataDirectoryCheck =
  | { readonly kind: "outside" }
  | { readonly kind: "inside"; readonly t3CodeDirectory: string }
  /** The links on the way could not be followed: treat as refused. */
  | { readonly kind: "unverifiable"; readonly detail: string };

/**
 * Whether `candidate` is (or would be, once created) T3 Code's data directory or inside it,
 * following symbolic links of every existing ancestor, including dangling ones.
 */
export function checkEarlyscriptDataDirectory(
  candidate: string,
  context: EarlyscriptHomeContext,
): T3CodeDataDirectoryCheck {
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
  const onDisk = resolveOnDisk(candidate, path);
  const candidates = new Set([normalize(candidate)]);
  if (onDisk.kind === "resolved") candidates.add(normalize(onDisk.path));
  for (const directory of t3CodeDataDirectories(context)) {
    const resolvedDirectory = resolveOnDisk(directory, path);
    const parents = new Set([normalize(directory)]);
    if (resolvedDirectory.kind === "resolved") parents.add(normalize(resolvedDirectory.path));
    for (const parent of parents) {
      for (const child of candidates) {
        if (isWithin(parent, child)) return { kind: "inside", t3CodeDirectory: directory };
      }
    }
  }
  return onDisk.kind === "unverifiable" ? onDisk : { kind: "outside" };
}

export class T3CodeDataDirectoryError extends Error {
  readonly directory: string;
  /** The T3 Code folder it belongs to; undefined when the path could not be verified. */
  readonly t3CodeDirectory: string | undefined;

  constructor(directory: string, check: Exclude<T3CodeDataDirectoryCheck, { kind: "outside" }>) {
    super(describeRefusedDataDirectory(directory, check));
    this.name = "T3CodeDataDirectoryError";
    this.directory = directory;
    this.t3CodeDirectory = check.kind === "inside" ? check.t3CodeDirectory : undefined;
  }
}

/** The refusal message every entry point shows, in Spanish. */
export function describeRefusedDataDirectory(
  directory: string,
  check: Exclude<T3CodeDataDirectoryCheck, { kind: "outside" }>,
): string {
  const why =
    check.kind === "inside"
      ? `pertenece a T3 Code (${check.t3CodeDirectory})`
      : `no se pudo comprobar que quede fuera de las carpetas de T3 Code (${check.detail})`;
  return (
    `Earlyscript no puede usar ${directory} como carpeta de datos: ${why}. ` +
    "Usa la carpeta por defecto (~/.earlyscript) o indica otra con EARLYSCRIPT_HOME, --base-dir (servidor) o --home-dir (pnpm dev)."
  );
}

/** Returns `directory` unchanged, or throws when it is T3 Code's data directory, lies inside it or cannot be verified. */
export function assertEarlyscriptDataDirectory(
  directory: string,
  context: EarlyscriptHomeContext,
): string {
  const check = checkEarlyscriptDataDirectory(directory, context);
  if (check.kind !== "outside") throw new T3CodeDataDirectoryError(directory, check);
  return directory;
}
