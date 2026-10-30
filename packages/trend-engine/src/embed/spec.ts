// Model pin and file hashes from Earlywindow's src/engine/embed/{config,model}.ts.
import type { EmbeddingSpec } from "@earlyscript/editorial-contracts/dossier";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { canonicalJson, sha256 } from "../hash.ts";
import { HOST, type Host } from "../host.ts";

export const DIMENSIONS = 1024;
export const TRANSFORMERS_VERSION = "4.3.1";
export const ONNXRUNTIME_VERSION = "1.30.0";

export const QWEN_MODEL = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
export const QWEN_REVISION = "c25a394dd583836952667c12f008335071b3f43d";
/** What the worker runs; the local embedder refuses any other spec. */
export const QWEN_DTYPE = "q8";
export const QWEN_POOLING = "last_token";
export const QWEN_FILES = [
  {
    file: "config.json",
    sha256: "66a10929782f3c9a3cd5dec90e2a95c60e05736134a63cd54479eeae80bed175",
  },
  {
    file: "tokenizer.json",
    sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a",
  },
  {
    file: "tokenizer_config.json",
    sha256: "977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1",
  },
  {
    file: "special_tokens_map.json",
    sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd",
  },
  {
    file: "onnx/model_quantized.onnx",
    sha256: "87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f",
  },
] as const;

/**
 * Everything that can change a vector. Platform and arch are part of it because
 * Qwen's vectors on Linux do not reproduce macOS ones (median cosine 0.965).
 */
export function embeddingSpec(
  embedder: EngineConfig["embedder"],
  host: Host = HOST,
): EmbeddingSpec {
  return {
    model: embedder.model,
    revision: embedder.revision,
    dtype: embedder.dtype,
    pooling: embedder.pooling,
    batch_size: embedder.batch_size,
    runtime: `transformers.js@${TRANSFORMERS_VERSION}+onnxruntime-node@${ONNXRUNTIME_VERSION}+cpu+intra_op_threads=${embedder.intra_op_threads}`,
    platform: host.platform,
    arch: host.arch,
  };
}

/** Cache key prefix: one per spec, so a vector is never reused across platforms or runtimes. */
export const embeddingKey = (spec: EmbeddingSpec): string => sha256(canonicalJson(spec));

export function validateVector(vector: Float32Array): void {
  if (vector.length !== DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error(`Embedding must contain ${DIMENSIONS} finite coordinates`);
  }
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (Math.abs(Math.sqrt(sum) - 1) > 1e-5) throw new Error("Embedding must be L2 normalized");
}

export interface Embedder {
  readonly spec: EmbeddingSpec;
  readonly key: string;
  /** Unit vectors, one per text, in input order. */
  embed(texts: ReadonlyArray<string>): Promise<Array<Float32Array>>;
  dispose(): Promise<void>;
  readonly stats?: () => Record<string, number>;
}
