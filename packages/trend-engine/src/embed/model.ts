// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - plain library; ported from Earlywindow's src/engine/embed/model.ts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import { QWEN_FILES, QWEN_MODEL, QWEN_REVISION } from "./spec.ts";

async function fileHash(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Checks every pinned file and downloads the missing ones from the pinned revision. */
export async function prepareModel(modelDir: string, allowDownload: boolean): Promise<string> {
  const root = NodePath.resolve(modelDir);
  for (const { file, sha256 } of QWEN_FILES) {
    const destination = NodePath.join(root, file);
    if (NodeFS.existsSync(destination)) {
      if ((await fileHash(destination)) !== sha256)
        throw new Error(`Model hash mismatch: ${destination}`);
      continue;
    }
    if (!allowDownload) throw new Error(`Model file missing: ${destination}`);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    const partial = `${destination}.${NodeCrypto.randomUUID()}.partial`;
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
