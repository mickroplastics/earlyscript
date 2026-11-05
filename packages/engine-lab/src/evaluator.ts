// @effect-diagnostics nodeBuiltinImport:off - hashes this package's own evaluator sources.
// The evaluator's identity by content: the code that reads labels, matches them to topics,
// compares the arms, groups cards into families and applies the gate. A campaign fixes it when
// it is created; a report computed by any other evaluator does not count for that campaign.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { sha256 } from "./hash.ts";

/** The files whose code decides a report or a gate; the worker and the policy are apart. */
export const EVALUATOR_FILES = ["compare.ts", "gate.ts", "labels.ts", "hash.ts"] as const;

export function evaluatorHash(dir: string = import.meta.dirname): string {
  return sha256(
    EVALUATOR_FILES.map(
      (name) => `${name}\n${sha256(NodeFS.readFileSync(NodePath.join(dir, name)))}`,
    ).join("\n"),
  );
}

export const EVALUATOR_HASH = evaluatorHash();
