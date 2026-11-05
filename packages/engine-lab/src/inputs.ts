// @effect-diagnostics nodeBuiltinImport:off - resolves the operator's input paths on the machine that reads them.
// The files a campaign reads, resolved to their canonical paths: every one must lie inside a
// root the operator authorized, and neither it nor anything it links to may be sealed. A name
// is not a guarantee: a link called friendly-corpus can point at the frozen evaluation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isSealedPath, LabPolicyError } from "./policy.ts";

export type InputKind = "file" | "optional-file" | "tree";

export interface InputEntry {
  readonly path: string;
  readonly kind: InputKind;
}

const MAX_TREE_ENTRIES = 250_000;

const inside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`);

const realOf = (path: string, kind: InputKind): string => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    if (kind === "optional-file") {
      return NodePath.join(NodeFS.realpathSync(NodePath.dirname(path)), NodePath.basename(path));
    }
    throw new LabPolicyError("invalid-change", `Input ${path} does not exist.`);
  }
};

const assertOpen = (path: string, real: string) => {
  if (isSealedPath(path) || isSealedPath(real)) {
    throw new LabPolicyError(
      "sealed-partition",
      `${path} resolves to ${real}, inside the frozen evaluation; the lab never reads it.`,
    );
  }
};

/** Every entry below `root`, links resolved: none may leave the tree or reach a sealed path. */
function assertTree(path: string, root: string) {
  let seen = 0;
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > MAX_TREE_ENTRIES) {
        throw new LabPolicyError(
          "invalid-change",
          `${path} has more than ${MAX_TREE_ENTRIES} entries.`,
        );
      }
      const full = NodePath.join(dir, entry.name);
      let real = full;
      if (entry.isSymbolicLink()) {
        try {
          real = NodeFS.realpathSync(full);
        } catch {
          throw new LabPolicyError("invalid-change", `${full} is a dangling link.`);
        }
      }
      assertOpen(full, real);
      if (!inside(real, root)) {
        throw new LabPolicyError(
          "permission-denied",
          `${full} links to ${real}, outside ${path}: an input tree may not reach other files.`,
        );
      }
      if (!entry.isSymbolicLink() && entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink() && NodeFS.statSync(real).isDirectory()) walk(real);
    }
  };
  walk(root);
}

/**
 * The canonical path of each entry, after checking it against the authorized roots and the
 * sealed partitions, and, for a tree, every file and link below it.
 */
export function canonicalInputs(
  roots: ReadonlyArray<string>,
  entries: ReadonlyArray<InputEntry>,
): Map<string, string> {
  if (roots.length === 0) {
    throw new LabPolicyError("permission-denied", "The campaign names no authorized input root.");
  }
  const canonicalRoots = roots.map((root) => {
    const real = realOf(root, "file");
    assertOpen(root, real);
    return real;
  });
  const out = new Map<string, string>();
  for (const entry of entries) {
    const real = realOf(entry.path, entry.kind);
    assertOpen(entry.path, real);
    if (!canonicalRoots.some((root) => inside(real, root))) {
      throw new LabPolicyError(
        "permission-denied",
        `${entry.path} resolves to ${real}, outside the authorized inputs ${canonicalRoots.join(", ")}.`,
      );
    }
    if (entry.kind === "tree") {
      if (!NodeFS.statSync(real).isDirectory()) {
        throw new LabPolicyError("invalid-change", `${entry.path} is not a directory.`);
      }
      assertTree(entry.path, real);
    } else if (NodeFS.existsSync(real) && !NodeFS.statSync(real).isFile()) {
      throw new LabPolicyError("invalid-change", `${entry.path} is not a file.`);
    }
    out.set(entry.path, real);
  }
  return out;
}

/** The lexical check for paths on another machine, which its executor resolves again. */
export function assertUnderRoots(roots: ReadonlyArray<string>, paths: ReadonlyArray<string>) {
  if (roots.length === 0) {
    throw new LabPolicyError("permission-denied", "The campaign names no authorized input root.");
  }
  for (const path of paths) {
    const resolved = NodePath.resolve(path);
    if (!roots.some((root) => inside(resolved, NodePath.resolve(root)))) {
      throw new LabPolicyError("permission-denied", `${path} is outside the authorized inputs.`);
    }
  }
}
