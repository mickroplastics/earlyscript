// @effect-diagnostics nodeBuiltinImport:off - hashes this package's own evaluator sources.
// The evaluator's identity by content: the code that reads labels, matches them to topics,
// compares the arms, groups cards into families and applies the gate. A campaign fixes it when
// it is created; a report computed by any other evaluator does not count for that campaign.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { sha256 } from "./hash.ts";

/** The files whose code decides a report or a gate; the worker and the policy are apart. */
export const EVALUATOR_FILES = ["compare.ts", "gate.ts", "labels.ts", "hash.ts"] as const;

/** The directory of the evaluator's sources in a checkout: this file's own. */
export const EVALUATOR_SOURCE_DIR: string = import.meta.dirname;

export function evaluatorHash(dir: string = EVALUATOR_SOURCE_DIR): string {
  return sha256(
    EVALUATOR_FILES.map(
      (name) => `${name}\n${sha256(NodeFS.readFileSync(NodePath.join(dir, name)))}`,
    ).join("\n"),
  );
}

/**
 * Set by the server bundle's build (apps/server/vite.config.ts) to `evaluatorHash()` of the
 * sources it bundles; undefined when this file runs from a checkout.
 */
declare const __EARLYSCRIPT_EVALUATOR_HASH__: string | undefined;

/** The embedded hash when there is one, otherwise the hash of the sources in `dir`. */
export function resolveEvaluatorHash(embedded: string | undefined, dir: string): string {
  if (embedded !== undefined) return embedded;
  const missing = EVALUATOR_FILES.filter((name) => !NodeFS.existsSync(NodePath.join(dir, name)));
  if (missing.length > 0) {
    throw new Error(
      `The evaluator's sources (${missing.join(", ")}) are not in ${dir} and this build embeds no evaluator hash.`,
    );
  }
  return evaluatorHash(dir);
}

let evaluatorHashMemo: string | undefined;

/**
 * This build's evaluator identity, computed on first use so that loading the module reads no
 * source: the packaged server has no `.ts` files and carries the hash its build embedded.
 */
export function currentEvaluatorHash(): string {
  evaluatorHashMemo ??= resolveEvaluatorHash(
    typeof __EARLYSCRIPT_EVALUATOR_HASH__ === "undefined"
      ? undefined
      : __EARLYSCRIPT_EVALUATOR_HASH__,
    EVALUATOR_SOURCE_DIR,
  );
  return evaluatorHashMemo;
}
