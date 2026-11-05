// @effect-diagnostics nodeBuiltinImport:off - a plain library; the server wraps it in Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The engine's `sha256` and `canonicalJson` (packages/trend-engine/src/hash.ts), unchanged. */
export const sha256 = (data: string | Uint8Array): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(data).digest("hex")}`;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  );
}

export const hmac = (secret: string, data: string): string =>
  `hmac-sha256:${NodeCrypto.createHmac("sha256", secret).update(data).digest("hex")}`;

/** Constant-time comparison of two signatures of the same format. */
export function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
}

/**
 * The files `ENGINE_SOURCE_HASH` covers (packages/trend-engine/src/editorial-eval.ts): every
 * `.ts` under `src`, outside `tools/` and `testkit/`, that is neither a test nor `editorial-*`.
 * Relative to `src`, sorted.
 */
export function engineSourceFiles(srcDir: string): Array<string> {
  const files: Array<string> = [];
  const walk = (rel: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(srcDir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "tools" && entry.name !== "testkit") walk(path);
      } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$|^editorial-/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk("");
  return files.toSorted();
}

/**
 * `ENGINE_SOURCE_HASH` of the engine sources in `srcDir`, with `overrides` (paths relative to
 * `src`) in place of the files on disk: the code identity of a run, recomputed outside it.
 */
export function engineSourceHash(
  srcDir: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): string {
  return sha256(
    engineSourceFiles(srcDir)
      .map(
        (path) =>
          `${path}\n${sha256(overrides.get(path) ?? NodeFS.readFileSync(NodePath.join(srcDir, path)))}`,
      )
      .join("\n"),
  );
}
