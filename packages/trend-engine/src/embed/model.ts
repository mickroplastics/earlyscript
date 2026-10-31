// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - plain library, ages partials by wall time; ported from Earlywindow's src/engine/embed/model.ts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStreamPromises from "node:stream/promises";

import { QWEN_FILES, QWEN_MODEL, QWEN_REVISION } from "./spec.ts";

/** A partial nobody has written to for this long is abandoned, whatever its owner. */
const PARTIAL_STALE_MS = 60 * 60 * 1000;

// `<file>.<pid>.<uuid>.partial`; the pid is the downloading process.
const PARTIAL_NAME = /^.+?\.(?:(\d+)\.)?[0-9a-f-]{36}\.partial$/;

function processAlive(pid: number): boolean {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes partial downloads left by a process that died mid-download, or untouched for
 * an hour. A live download of the same file by another process keeps its partial.
 */
async function removeAbandonedPartials(dir: string, nowMs: number): Promise<void> {
  const entries = await NodeFSP.readdir(dir).catch(() => []);
  for (const entry of entries) {
    const match = PARTIAL_NAME.exec(entry);
    if (match === null) continue;
    const path = NodePath.join(dir, entry);
    const stat = await NodeFSP.stat(path).catch(() => null);
    if (stat === null) continue;
    const owner = match[1] === undefined ? null : Number(match[1]);
    const abandoned = owner === null || !processAlive(owner);
    if (abandoned || nowMs - stat.mtimeMs > PARTIAL_STALE_MS) {
      await NodeFSP.rm(path, { force: true });
    }
  }
}

async function fileHash(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Checks every pinned file and downloads the missing ones from the pinned revision. */
export async function prepareModel(modelDir: string, allowDownload: boolean): Promise<string> {
  const root = NodePath.resolve(modelDir);
  const nowMs = Date.now();
  for (const dir of new Set(
    QWEN_FILES.map(({ file }) => NodePath.dirname(NodePath.join(root, file))),
  )) {
    await removeAbandonedPartials(dir, nowMs);
  }
  for (const { file, sha256 } of QWEN_FILES) {
    const destination = NodePath.join(root, file);
    if (NodeFS.existsSync(destination)) {
      if ((await fileHash(destination)) !== sha256)
        throw new Error(`Model hash mismatch: ${destination}`);
      continue;
    }
    if (!allowDownload) throw new Error(`Model file missing: ${destination}`);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    const partial = `${destination}.${NodeProcess.pid}.${NodeCrypto.randomUUID()}.partial`;
    try {
      const url = `https://huggingface.co/${QWEN_MODEL}/resolve/${QWEN_REVISION}/${file}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body)
        throw new Error(`Model download failed: HTTP ${response.status}`);
      await NodeStreamPromises.pipeline(response.body, NodeFS.createWriteStream(partial));
      if ((await fileHash(partial)) !== sha256) throw new Error(`Model hash mismatch: ${url}`);
      await NodeFSP.rename(partial, destination);
    } finally {
      await NodeFSP.rm(partial, { force: true });
    }
  }
  return root;
}
