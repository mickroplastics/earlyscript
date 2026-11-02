// @effect-diagnostics nodeBuiltinImport:off - O_NOFOLLOW and lstat, which effect/FileSystem lacks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Files of a video folder, read and written without following links. Every component below
// the real workspace root (`videos`, the video's folder, the file) must be a plain folder or a
// regular file: a symbolic link anywhere is refused before anything is created, read or chmod-ed.

export type VideoFileRefusal =
  | "outside"
  | "link"
  | "not-a-file"
  | "not-found"
  | "too-large"
  | "stopped";

/**
 * Asked right before each folder, file or rename is written; false stops the write with
 * `stopped`. `VideoWorkspace.ts` stops once the thread is decided, so a preparation that
 * outlived its caller never writes into a decided thread.
 */
export type MayWrite = () => Promise<boolean>;

const alwaysWrite: MayWrite = async () => true;

export type VideoFileOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: VideoFileRefusal };

const refuse = (reason: VideoFileRefusal) => ({ ok: false, reason }) as const;
const accept = <A>(value: A) => ({ ok: true, value }) as const;

/** Linux and macOS have them; Windows does not, and relies on the lstat before the open. */
const NO_FOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;
/** A FIFO swapped in after the lstat opens at once instead of waiting for a writer. */
const NON_BLOCK = NodeFS.constants.O_NONBLOCK ?? 0;

/** Largest file read back: far above any script or dossier. */
const MAX_READ_BYTES = 1024 * 1024;

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * The components of a workspace-relative path written with `/`, or null for an absolute path,
 * `~`, `..`, a backslash, NUL or nothing. `.` and repeated slashes are dropped.
 */
export function videoPathComponents(relativePath: string): ReadonlyArray<string> | null {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("~") ||
    NodePath.posix.isAbsolute(relativePath) ||
    NodePath.win32.isAbsolute(relativePath)
  ) {
    return null;
  }
  const parts = relativePath.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length === 0 || parts.includes("..") ? null : parts;
}

/**
 * Walks `folders` down from the real workspace root, each one a real folder and never a link,
 * creating the missing ones one level at a time when `create` is set. Nothing is created
 * before every existing ancestor has been checked.
 */
async function walkFolders(
  root: string,
  folders: ReadonlyArray<string>,
  create: boolean,
  mayWrite: MayWrite = alwaysWrite,
): Promise<VideoFileOutcome<string>> {
  let current = await NodeFSP.realpath(root);
  for (const name of folders) {
    const next = NodePath.join(current, name);
    let stat = await NodeFSP.lstat(next).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    });
    if (stat === null) {
      if (!create) return refuse("not-found");
      if (!(await mayWrite())) return refuse("stopped");
      await NodeFSP.mkdir(next).catch((error: unknown) => {
        if (codeOf(error) !== "EEXIST") throw error;
      });
      stat = await NodeFSP.lstat(next);
    }
    if (stat.isSymbolicLink()) return refuse("link");
    if (!stat.isDirectory()) return refuse("not-a-file");
    current = next;
  }
  return accept(current);
}

/**
 * Opens a regular file for reading without following a link or waiting on it; null when it
 * does not exist. A link, FIFO, socket or device is refused by lstat before the open, and by
 * fstat after it in case the entry was replaced in between (`O_NONBLOCK` keeps a FIFO from
 * blocking the open itself).
 */
async function openNoFollow(path: string): Promise<VideoFileOutcome<NodeFSP.FileHandle | null>> {
  const before = await NodeFSP.lstat(path).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  });
  if (before === null) return accept(null);
  if (before.isSymbolicLink()) return refuse("link");
  if (!before.isFile()) return refuse("not-a-file");
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return accept(null);
    // ELOOP on Linux and macOS, EMLINK on FreeBSD: the final component became a link.
    if (code === "ELOOP" || code === "EMLINK") return refuse("link");
    if (code === "EISDIR" || code === "ENXIO") return refuse("not-a-file");
    throw error;
  }
  const after = await handle.stat().catch(() => null);
  if (after === null || !after.isFile()) {
    await handle.close();
    return refuse("not-a-file");
  }
  return accept(handle);
}

async function readOpen(handle: NodeFSP.FileHandle): Promise<VideoFileOutcome<string>> {
  const stat = await handle.stat();
  if (!stat.isFile()) return refuse("not-a-file");
  if (stat.size > MAX_READ_BYTES) return refuse("too-large");
  return accept(await handle.readFile("utf8"));
}

const split = (relativePath: string) => {
  const parts = videoPathComponents(relativePath);
  return parts === null ? null : { folders: parts.slice(0, -1), name: parts.at(-1)! };
};

/** A text file of the workspace, read without following any link on the way. */
export async function readVideoFile(
  root: string,
  relativePath: string,
): Promise<VideoFileOutcome<string>> {
  const path = split(relativePath);
  if (path === null) return refuse("outside");
  const folder = await walkFolders(root, path.folders, false);
  if (!folder.ok) return folder;
  const opened = await openNoFollow(NodePath.join(folder.value, path.name));
  if (!opened.ok) return opened;
  if (opened.value === null) return refuse("not-found");
  try {
    return await readOpen(opened.value);
  } finally {
    await opened.value.close();
  }
}

/**
 * Writes a read-only (0444) file through a temporary file and a rename, so a reader never sees
 * half of it, and only when its text changes. The rename replaces the directory entry itself:
 * a link put there in between is replaced, never followed.
 */
export async function writeReadOnlyVideoFile(
  root: string,
  relativePath: string,
  contents: string,
  mayWrite: MayWrite = alwaysWrite,
): Promise<VideoFileOutcome<"written" | "unchanged">> {
  const path = split(relativePath);
  if (path === null) return refuse("outside");
  const folder = await walkFolders(root, path.folders, true, mayWrite);
  if (!folder.ok) return folder;
  const target = NodePath.join(folder.value, path.name);
  const opened = await openNoFollow(target);
  if (!opened.ok) return opened;
  if (opened.value !== null) {
    const handle = opened.value;
    try {
      const current = await readOpen(handle);
      if (!current.ok && current.reason === "not-a-file") return current;
      if (current.ok && current.value === contents) {
        // Through the handle: the file checked above, not whatever the name points to now.
        await handle.chmod(0o444);
        return accept("unchanged");
      }
    } finally {
      await handle.close();
    }
  }
  const temporary = NodePath.join(folder.value, `.${path.name}.${process.pid}.tmp`);
  if (!(await mayWrite())) return refuse("stopped");
  await NodeFSP.rm(temporary, { force: true });
  await NodeFSP.writeFile(temporary, contents, { flag: "wx", mode: 0o444 });
  if (!(await mayWrite())) {
    await NodeFSP.rm(temporary, { force: true });
    return refuse("stopped");
  }
  await NodeFSP.rename(temporary, target);
  return accept("written");
}

/**
 * Creates a file only when its name is free. `wx` fails on any existing entry, a dangling link
 * included, so a file the agent or the operator wrote is never replaced; a link is refused.
 */
export async function createVideoFileIfMissing(
  root: string,
  relativePath: string,
  contents: string,
  mayWrite: MayWrite = alwaysWrite,
): Promise<VideoFileOutcome<"created" | "exists">> {
  const path = split(relativePath);
  if (path === null) return refuse("outside");
  const folder = await walkFolders(root, path.folders, true, mayWrite);
  if (!folder.ok) return folder;
  const target = NodePath.join(folder.value, path.name);
  if (!(await mayWrite())) return refuse("stopped");
  try {
    await NodeFSP.writeFile(target, contents, { flag: "wx" });
    return accept("created");
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
  const stat = await NodeFSP.lstat(target);
  if (stat.isSymbolicLink()) return refuse("link");
  return stat.isFile() ? accept("exists") : refuse("not-a-file");
}

/** Whether a regular file is there, by lstat on every component. */
export async function videoFileExists(root: string, relativePath: string): Promise<boolean> {
  const path = split(relativePath);
  if (path === null) return false;
  const folder = await walkFolders(root, path.folders, false);
  if (!folder.ok) return false;
  const stat = await NodeFSP.lstat(NodePath.join(folder.value, path.name)).catch(() => null);
  return stat !== null && stat.isFile();
}
