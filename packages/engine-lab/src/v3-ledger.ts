// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - an append-only file, written by one process at a time.
// The ledger of protocols P2 and P3 (packages/trend-engine/src/editorial-eval.ts, readLedger and
// appendLedger), ported to engine-lab for v3: JSON lines, each naming the sha256 of the line
// before it; a line that does not close the chain is refused on read, and the writer holds an
// exclusive lock file while it appends.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { sha256 } from "./hash.ts";

/** A ledger line: append-only JSON lines, each chained to the SHA-256 of the line before it. */
export interface LedgerEntry {
  readonly kind: string;
  readonly at: string;
  readonly prev_sha256: string | null;
  readonly [key: string]: unknown;
}

export class LedgerChainError extends Error {
  readonly code = "ledger-chain";
}

const linesOf = (path: string) =>
  NodeFS.existsSync(path)
    ? NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];

/** Reads the ledger and checks its chain: every line names the SHA-256 of the line before it. */
export function readLedger(path: string): Array<LedgerEntry> {
  const lines = linesOf(path);
  return lines.map((line, k) => {
    const entry = JSON.parse(line) as LedgerEntry;
    const expected = k === 0 ? null : sha256(lines[k - 1]!);
    if (entry.prev_sha256 !== expected) {
      throw new LedgerChainError(
        `${path}: line ${k + 1} breaks the chain (prev_sha256 does not match)`,
      );
    }
    return entry;
  });
}

/** sha256 of each ledger line, in order (the identity later entries cite). */
export const ledgerLineShas = (path: string) => linesOf(path).map((line) => sha256(line));

/**
 * Appends one entry under an exclusive lock, after checking the whole chain: a ledger whose
 * chain does not close takes no new entry. `at` and `prev_sha256` are set here, never by callers.
 */
export function appendLedger(
  path: string,
  entry: { readonly kind: string } & Record<string, unknown>,
  now: () => Date = () => new Date(),
): LedgerEntry {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = NodeFS.openSync(lockPath, "wx");
  try {
    readLedger(path);
    const last = linesOf(path).at(-1);
    const { at: _at, prev_sha256: _prev, ...rest } = entry as Record<string, unknown>;
    const full: LedgerEntry = {
      ...(rest as { kind: string }),
      at: now().toISOString(),
      prev_sha256: last === undefined ? null : sha256(last),
    };
    NodeFS.appendFileSync(path, `${JSON.stringify(full)}\n`);
    NodeFS.fsyncSync(lock);
    return full;
  } finally {
    NodeFS.closeSync(lock);
    NodeFS.rmSync(lockPath, { force: true });
  }
}

export const fileSha256 = (path: string) => sha256(NodeFS.readFileSync(path));
