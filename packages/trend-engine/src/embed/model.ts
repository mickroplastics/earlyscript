// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - plain library, ages partials by wall time; ported from Earlywindow's src/engine/embed/model.ts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import { QWEN_FILES, QWEN_MODEL, QWEN_REVISION } from "./spec.ts";

/** A partial nobody has written to for this long is abandoned, whatever its owner. */
const PARTIAL_STALE_MS = 60 * 60 * 1000;

/** `<data>/models/<revision>`: where runs, backtests and `engine model` look by default. */
export const defaultModelDir = (dataDir: string, revision: string = QWEN_REVISION): string =>
  NodePath.join(dataDir, "models", revision);

/** Where the pinned files come from; a mirror keeps the same `<model>/resolve/<rev>/<file>` layout. */
export const MODEL_BASE_URL = "https://huggingface.co";

// `<file>.<pid>.<uuid>.partial`; the pid is the downloading process.
const PARTIAL_NAME = /^(.+?)\.(?:(\d+)\.)?[0-9a-f-]{36}\.partial$/;

export interface ModelFile {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Bytes of the whole model on disk, counted while `file` downloads. */
export interface ModelProgress {
  readonly file: string;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface PrepareModelOptions {
  /** Called as bytes arrive; the caller throttles. */
  readonly onProgress?: (progress: ModelProgress) => void;
  /** Defaults to `MODEL_BASE_URL`. */
  readonly baseUrl?: string;
  /** The pinned Qwen files; tests pass small ones. */
  readonly files?: ReadonlyArray<ModelFile>;
}

function processAlive(pid: number): boolean {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface PartialFile {
  readonly path: string;
  /** The file it becomes, absolute. */
  readonly destination: string;
  readonly size: number;
  readonly abandoned: boolean;
}

/** Partial downloads in `dir`. Abandoned: no owner, a dead owner, or an hour unwritten. */
async function listPartials(dir: string, nowMs: number): Promise<Array<PartialFile>> {
  const entries = await NodeFSP.readdir(dir).catch(() => []);
  const partials: Array<PartialFile> = [];
  for (const entry of entries) {
    const match = PARTIAL_NAME.exec(entry);
    if (match === null) continue;
    const path = NodePath.join(dir, entry);
    const stat = await NodeFSP.stat(path).catch(() => null);
    if (stat === null) continue;
    const owner = match[2] === undefined ? null : Number(match[2]);
    partials.push({
      path,
      destination: NodePath.join(dir, match[1] ?? entry),
      size: stat.size,
      abandoned: owner === null || !processAlive(owner) || nowMs - stat.mtimeMs > PARTIAL_STALE_MS,
    });
  }
  return partials;
}

const fileDirs = (root: string, files: ReadonlyArray<ModelFile>) =>
  new Set(files.map(({ file }) => NodePath.dirname(NodePath.join(root, file))));

/**
 * Removes partial downloads left by a process that died mid-download, or untouched for an
 * hour, and returns the largest of them per file, kept so a download resumes from it. A
 * live download of the same file by another process keeps its partial.
 */
async function sweepPartials(
  root: string,
  files: ReadonlyArray<ModelFile>,
  keepForResume: boolean,
): Promise<Map<string, PartialFile>> {
  const nowMs = Date.now();
  const resumable = new Map<string, PartialFile>();
  for (const dir of fileDirs(root, files)) {
    for (const partial of await listPartials(dir, nowMs)) {
      if (!partial.abandoned) continue;
      const kept = resumable.get(partial.destination);
      if (keepForResume && (kept === undefined || kept.size < partial.size)) {
        resumable.set(partial.destination, partial);
        if (kept !== undefined) await NodeFSP.rm(kept.path, { force: true });
      } else {
        await NodeFSP.rm(partial.path, { force: true });
      }
    }
  }
  return resumable;
}

async function fileHash(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Takes over an abandoned partial by renaming it; 0 bytes when another process took it first. */
async function adopt(partial: PartialFile | undefined, own: string): Promise<number> {
  if (partial === undefined) return 0;
  try {
    await NodeFSP.rename(partial.path, own);
    return (await NodeFSP.stat(own)).size;
  } catch {
    return 0;
  }
}

/**
 * Checks every pinned file and downloads the missing ones from the pinned revision. A
 * download that broke or died midway resumes from its partial with an HTTP range request;
 * the finished file is hashed either way, and a mismatch throws the bytes away.
 */
export async function prepareModel(
  modelDir: string,
  allowDownload: boolean,
  options: PrepareModelOptions = {},
): Promise<string> {
  const root = NodePath.resolve(modelDir);
  const files = options.files ?? QWEN_FILES;
  const baseUrl = (options.baseUrl ?? MODEL_BASE_URL).replace(/\/+$/, "");
  const bytesTotal = files.reduce((sum, { bytes }) => sum + bytes, 0);
  const resumable = await sweepPartials(root, files, allowDownload);
  let bytesBefore = 0;
  for (const { file, sha256, bytes } of files) {
    const destination = NodePath.join(root, file);
    if (NodeFS.existsSync(destination)) {
      if ((await fileHash(destination)) !== sha256)
        throw new Error(`Model hash mismatch: ${destination}`);
      bytesBefore += bytes;
      options.onProgress?.({ file, bytesDone: bytesBefore, bytesTotal });
      continue;
    }
    if (!allowDownload) throw new Error(`Model file missing: ${destination}`);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    const partial = `${destination}.${NodeProcess.pid}.${NodeCrypto.randomUUID()}.partial`;
    // Until the hash says otherwise, the bytes are good: a broken connection leaves them
    // for the next attempt instead of throwing away hundreds of megabytes.
    let keepPartial = true;
    try {
      let offset = await adopt(resumable.get(destination), partial);
      const url = `${baseUrl}/${QWEN_MODEL}/resolve/${QWEN_REVISION}/${file}`;
      // A partial as long as the file needs no request: the hash decides.
      if (offset < bytes) {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(600_000),
          ...(offset > 0 ? { headers: { range: `bytes=${offset}-` } } : {}),
        });
        if (!response.ok || !response.body)
          throw new Error(`Model download failed: HTTP ${response.status}`);
        // A server that ignores the range sends the whole file again.
        if (response.status !== 206) offset = 0;
        let done = offset;
        const count = new NodeStream.Transform({
          transform(chunk: Buffer, _encoding, callback) {
            done += chunk.length;
            options.onProgress?.({ file, bytesDone: bytesBefore + done, bytesTotal });
            callback(null, chunk);
          },
        });
        options.onProgress?.({ file, bytesDone: bytesBefore + done, bytesTotal });
        await NodeStreamPromises.pipeline(
          response.body,
          count,
          NodeFS.createWriteStream(partial, { flags: offset > 0 ? "a" : "w" }),
        );
      }
      keepPartial = false;
      if ((await fileHash(partial)) !== sha256) throw new Error(`Model hash mismatch: ${url}`);
      await NodeFSP.rename(partial, destination);
    } finally {
      // Released without an owner, so any later attempt, this process included, resumes it.
      const released = keepPartial
        ? await NodeFSP.rename(partial, `${destination}.${NodeCrypto.randomUUID()}.partial`).then(
            () => true,
            () => false,
          )
        : false;
      if (!released) await NodeFSP.rm(partial, { force: true });
    }
    bytesBefore += bytes;
    options.onProgress?.({ file, bytesDone: bytesBefore, bytesTotal });
  }
  return root;
}

export interface ModelStatus {
  /** `partial`: some bytes are on disk, finished files or a download that stopped. */
  readonly status: "ready" | "missing" | "partial";
  readonly revision: string;
  readonly path: string;
  readonly bytesPresent: number;
  readonly bytesExpected: number;
}

/**
 * What is on disk, by size: hashing 600 MB on every look would take seconds, and
 * `prepareModel` hashes before a run uses the files anyway. A partial counts its bytes.
 */
export async function modelStatus(
  modelDir: string,
  files: ReadonlyArray<ModelFile> = QWEN_FILES,
): Promise<ModelStatus> {
  const root = NodePath.resolve(modelDir);
  const nowMs = Date.now();
  const partials: Array<PartialFile> = [];
  for (const dir of fileDirs(root, files)) partials.push(...(await listPartials(dir, nowMs)));
  let bytesPresent = 0;
  let complete = 0;
  for (const { file, bytes } of files) {
    const destination = NodePath.join(root, file);
    const size = (await NodeFSP.stat(destination).catch(() => null))?.size ?? null;
    if (size === bytes) {
      complete += 1;
      bytesPresent += bytes;
      continue;
    }
    const largest = Math.max(
      0,
      ...partials.filter((partial) => partial.destination === destination).map((p) => p.size),
    );
    bytesPresent += Math.min(largest, bytes);
  }
  return {
    status: complete === files.length ? "ready" : bytesPresent > 0 ? "partial" : "missing",
    revision: QWEN_REVISION,
    path: root,
    bytesPresent,
    bytesExpected: files.reduce((sum, { bytes }) => sum + bytes, 0),
  };
}
