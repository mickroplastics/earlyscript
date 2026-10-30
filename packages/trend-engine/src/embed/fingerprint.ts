// @effect-diagnostics nodeBuiltinImport:off - plain library.
// Deterministic stand-in for tests (Earlywindow's fingerprintEmbedder in src/engine/run.ts):
// texts that share words are close.
import * as NodeCrypto from "node:crypto";

import { normalized } from "../cluster.ts";
import { type Embedder, embeddingKey } from "./spec.ts";

const DIMS = 256;

export function fingerprintEmbedder(): Embedder {
  const spec = {
    model: "earlyscript/fingerprint-bow",
    revision: "1",
    dtype: "float32",
    pooling: "mean" as const,
    batch_size: 1,
    runtime: `node:crypto sha256, ${DIMS} dims`,
    platform: null,
    arch: null,
  };
  const words = new Map<string, Float32Array>();
  const wordVector = (word: string) => {
    let vector = words.get(word);
    if (!vector) {
      vector = new Float32Array(DIMS);
      for (let block = 0; block * 8 < DIMS; block++) {
        const digest = NodeCrypto.createHash("sha256").update(`${word}#${block}`).digest();
        for (let k = 0; k < 8; k++) vector[block * 8 + k] = digest.readInt32LE(k * 4) / 2 ** 31;
      }
      words.set(word, vector);
    }
    return vector;
  };
  const embedOne = (text: string) => {
    const sum = new Float32Array(DIMS);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? ["empty"]) {
      const word = wordVector(token);
      for (let i = 0; i < DIMS; i++) sum[i]! += word[i]!;
    }
    return normalized(sum);
  };
  return {
    spec,
    key: embeddingKey(spec),
    embed: async (texts) => texts.map(embedOne),
    dispose: async () => {},
  };
}
