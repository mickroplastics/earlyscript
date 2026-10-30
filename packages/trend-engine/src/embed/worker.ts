// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - child process entry; options come from the parent.
// Child process that owns one Qwen pipeline (Earlywindow's src/engine/embed/worker.ts,
// without the cache: the parent is the only cache writer).
import { env, pipeline } from "@huggingface/transformers";
import * as ort from "onnxruntime-node";

import { prepareModel } from "./model.ts";
import { ONNXRUNTIME_VERSION, TRANSFORMERS_VERSION, validateVector } from "./spec.ts";

interface WorkerOptions {
  readonly modelDir: string;
  readonly threads: number;
  readonly allowDownload: boolean;
}
type Request = { kind: "embed"; id: number; texts: Array<string> } | { kind: "dispose" };

if (env.version !== TRANSFORMERS_VERSION || ort.env.versions.node !== ONNXRUNTIME_VERSION) {
  throw new Error("Embedding runtime differs from the pinned versions");
}
env.allowRemoteModels = false;
const options = JSON.parse(process.argv[2] ?? "null") as WorkerOptions;

let extractor: Awaited<ReturnType<typeof load>> | undefined;
let inferred = 0;

async function load() {
  const modelPath = await prepareModel(options.modelDir, options.allowDownload);
  return pipeline("feature-extraction", modelPath, {
    dtype: "q8",
    device: "cpu",
    local_files_only: true,
    session_options: { intraOpNumThreads: options.threads },
  });
}

let queue = Promise.resolve();
process.on("message", (message: Request) => {
  queue = queue.then(async () => {
    if (message.kind === "dispose") {
      await extractor?.dispose();
      process.disconnect();
      return;
    }
    try {
      extractor ??= await load();
      const vectors: Array<Float32Array> = [];
      for (const text of message.texts) {
        const output = await extractor(text, { pooling: "last_token", normalize: true });
        const vector = Float32Array.from(output.data as Float32Array);
        validateVector(vector);
        vectors.push(vector);
        inferred++;
      }
      const peakRssBytes = process.resourceUsage().maxRSS * 1024;
      process.send?.({ kind: "result", id: message.id, vectors, inferred, peakRssBytes });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      process.send?.({ kind: "error", id: message.id, message: text });
    }
  });
});
process.on("disconnect", () => process.exit(0));
