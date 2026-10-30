// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - plain library; children run ONNX off the main process.
import * as NodeChildProcess from "node:child_process";

import type { EmbeddingSpec } from "@earlyscript/editorial-contracts/dossier";

import { EmbeddingCache } from "./cache.ts";
import { type Embedder, embeddingKey, QWEN_MODEL, validateVector } from "./spec.ts";

export interface LocalEmbedderOptions {
  readonly cacheFile: string;
  readonly modelDir: string;
  /** Child processes, each with intra_op_threads; a text's vector does not depend on which one embeds it. */
  readonly workers: number;
  readonly allowDownload?: boolean;
  readonly log?: (line: string) => void;
}

const CHUNK = 16;

type Reply =
  | {
      kind: "result";
      id: number;
      vectors: Array<Float32Array>;
      inferred: number;
      peakRssBytes: number;
    }
  | { kind: "error"; id: number; message: string };

class Worker {
  private readonly child: NodeChildProcess.ChildProcess;
  private readonly pending = new Map<
    number,
    { resolve: (r: Reply) => void; reject: (e: Error) => void }
  >();
  private sequence = 0;
  private stderr = "";
  readonly exited: Promise<void>;
  peakRssBytes = 0;

  constructor(options: { modelDir: string; threads: number; allowDownload: boolean }) {
    this.child = NodeChildProcess.fork(
      new URL("./worker.ts", import.meta.url),
      [JSON.stringify(options)],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "advanced",
        execArgv: [],
      },
    );
    this.child.stderr?.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
    });
    this.child.on("message", (reply: Reply) => {
      const request = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      request?.resolve(reply);
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        const error = new Error(
          `Embedding worker exited (${signal ?? code}): ${this.stderr.trim()}`,
        );
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        resolve();
      });
    });
  }

  async embed(texts: Array<string>): Promise<Array<Float32Array>> {
    const id = ++this.sequence;
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ kind: "embed", id, texts });
    });
    if (reply.kind === "error") throw new Error(reply.message);
    this.peakRssBytes = Math.max(this.peakRssBytes, reply.peakRssBytes);
    if (reply.vectors.length !== texts.length) throw new Error("Embedding result count differs");
    return reply.vectors;
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    try {
      if (this.child.connected) this.child.send({ kind: "dispose" });
      else this.child.kill();
      await this.exited;
    } finally {
      clearTimeout(kill);
    }
  }
}

/** Qwen through transformers.js in child processes, behind a disk cache keyed by spec. */
export function createLocalEmbedder(spec: EmbeddingSpec, options: LocalEmbedderOptions): Embedder {
  if (spec.model !== QWEN_MODEL || spec.batch_size !== 1) {
    throw new Error(`The local embedder only runs ${QWEN_MODEL} with batch size 1`);
  }
  const threads = Number(/intra_op_threads=(\d+)/.exec(spec.runtime)?.[1] ?? Number.NaN);
  if (!Number.isInteger(threads)) throw new Error(`No intra_op_threads in runtime ${spec.runtime}`);
  const key = embeddingKey(spec);
  const cache = new EmbeddingCache(options.cacheFile, key);
  const workers: Array<Worker> = [];
  let cacheHits = 0;
  let inferred = 0;

  const embed = async (texts: ReadonlyArray<string>) => {
    const results: Array<Float32Array | undefined> = Array.from({ length: texts.length });
    const missing = new Map<string, Array<number>>();
    texts.forEach((text, index) => {
      if (text.trim().length === 0) throw new Error("Embedding texts must be non-empty");
      const cached = cache.get(text);
      if (cached) {
        cacheHits++;
        results[index] = cached;
      } else missing.set(text, [...(missing.get(text) ?? []), index]);
    });
    const unique = [...missing.keys()];
    const chunks: Array<Array<string>> = [];
    for (let start = 0; start < unique.length; start += CHUNK)
      chunks.push(unique.slice(start, start + CHUNK));
    while (chunks.length > 0 && workers.length < Math.min(options.workers, chunks.length)) {
      workers.push(
        new Worker({
          modelDir: options.modelDir,
          threads,
          allowDownload: options.allowDownload ?? false,
        }),
      );
    }
    let next = 0;
    let done = 0;
    const started = performance.now();
    await Promise.all(
      workers.map(async (worker) => {
        while (next < chunks.length) {
          const chunk = chunks[next++]!;
          const vectors = await worker.embed(chunk);
          vectors.forEach(validateVector);
          cache.setMany(chunk.map((text, k) => [text, vectors[k]!] as const));
          chunk.forEach((text, k) => {
            for (const index of missing.get(text)!) results[index] = vectors[k]!;
          });
          inferred += chunk.length;
          done += chunk.length;
          if (options.log && (done % 1024 < CHUNK || done === unique.length)) {
            const seconds = (performance.now() - started) / 1000;
            options.log(
              JSON.stringify({
                phase: "embed",
                inferred: done,
                total: unique.length,
                elapsed_s: Math.round(seconds),
                texts_per_s: Math.round((done / seconds) * 100) / 100,
              }),
            );
          }
        }
      }),
    );
    return results.map((vector, index) => {
      if (!vector) throw new Error(`No vector for text ${index}`);
      return vector;
    });
  };

  return {
    spec,
    key,
    embed,
    stats: () => ({
      cache_hits: cacheHits,
      inferred,
      workers: workers.length,
      worker_peak_rss_bytes: Math.max(0, ...workers.map((worker) => worker.peakRssBytes)),
    }),
    dispose: async () => {
      await Promise.all(workers.map((worker) => worker.dispose()));
      cache.close();
    },
  };
}
