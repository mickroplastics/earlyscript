// @effect-diagnostics nodeBuiltinImport:off - a plain library; the server wraps it in Effect.
import * as NodeCrypto from "node:crypto";

export const sha256 = (data: string | Uint8Array): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(data).digest("hex")}`;

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  );
}
