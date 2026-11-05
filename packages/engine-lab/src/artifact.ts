// @effect-diagnostics nodeBuiltinImport:off - builds engine copies on disk for the server.
// Code artifacts: an approved code candidate's engine, built by content hash away from the
// installed engine, which never changes for it. The nightly run executes the artifact the active
// manifest names, verified by hash at each use; reverting points back at the previous one.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { engineSourceHash, sha256 } from "./hash.ts";
import { LabPolicyError } from "./policy.ts";

const ENGINE_PREFIX = "packages/trend-engine/src/";

const hexOf = (hash: string) => {
  const hex = hash.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new LabPolicyError("artifact-mismatch", `${hash} is not a sha256.`);
  return hex;
};

/** The artifact directory of a source hash; its CLI is `<dir>/packages/trend-engine/src/cli.ts`. */
export const artifactDir = (root: string, sourceHash: string) =>
  NodePath.join(root, hexOf(sourceHash));

export const artifactCli = (root: string, sourceHash: string) =>
  NodePath.join(artifactDir(root, sourceHash), "packages", "trend-engine", "src", "cli.ts");

/**
 * Verifies the artifact of `sourceHash`: its sources hash to it. Null when it holds, else why
 * not; an artifact edited after it was built never runs.
 */
export function artifactProblem(root: string, sourceHash: string): string | null {
  const src = NodePath.join(artifactDir(root, sourceHash), "packages", "trend-engine", "src");
  if (!NodeFS.existsSync(NodePath.join(src, "cli.ts")))
    return `no engine artifact for ${sourceHash}`;
  const actual = engineSourceHash(src);
  return actual === sourceHash ? null : `the artifact for ${sourceHash} hashes ${actual}`;
}

const readOnly = (path: string) => {
  const stat = NodeFS.lstatSync(path);
  if (stat.isSymbolicLink()) return;
  // Files only: the guarantee is the hash checked at every use; directories stay removable.
  if (stat.isDirectory()) {
    for (const name of NodeFS.readdirSync(path)) readOnly(NodePath.join(path, name));
  } else NodeFS.chmodSync(path, 0o444);
};

/**
 * Builds, once, the engine whose sources are the installed ones with `files` (repository path to
 * contents) in place, and checks it hashes to `sourceHash`. Its configuration directory is a
 * copy, so the relevance model it loads does not follow later installs; its dependencies are
 * the installed ones. Built under a temporary name and renamed, its files read-only.
 */
export function prepareArtifact(input: {
  readonly root: string;
  readonly engineRoot: string;
  readonly files: Readonly<Record<string, string>>;
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly sourceHash: string;
}): string {
  const dir = artifactDir(input.root, input.sourceHash);
  if (NodeFS.existsSync(dir)) {
    const problem = artifactProblem(input.root, input.sourceHash);
    if (problem !== null) throw new LabPolicyError("artifact-mismatch", problem);
    return artifactCli(input.root, input.sourceHash);
  }
  const installed = NodePath.join(input.engineRoot, "packages", "trend-engine");
  const tmp = `${dir}.building-${process.pid}`;
  NodeFS.rmSync(tmp, { recursive: true, force: true });
  const pkg = NodePath.join(tmp, "packages", "trend-engine");
  NodeFS.mkdirSync(pkg, { recursive: true });
  NodeFS.cpSync(NodePath.join(installed, "src"), NodePath.join(pkg, "src"), { recursive: true });
  NodeFS.cpSync(NodePath.join(installed, "config"), NodePath.join(pkg, "config"), {
    recursive: true,
  });
  NodeFS.copyFileSync(NodePath.join(installed, "package.json"), NodePath.join(pkg, "package.json"));
  NodeFS.symlinkSync(NodePath.join(installed, "node_modules"), NodePath.join(pkg, "node_modules"));
  for (const [path, contents] of Object.entries(input.files)) {
    if (!path.startsWith(ENGINE_PREFIX) || path.includes("..")) {
      throw new LabPolicyError("artifact-mismatch", `${path} is not an engine source file.`);
    }
    if (sha256(contents) !== input.fileHashes[path]) {
      throw new LabPolicyError("artifact-mismatch", `${path} differs from the manifest.`);
    }
    NodeFS.writeFileSync(NodePath.join(pkg, "src", path.slice(ENGINE_PREFIX.length)), contents);
  }
  const built = engineSourceHash(NodePath.join(pkg, "src"));
  if (built !== input.sourceHash) {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
    throw new LabPolicyError(
      "artifact-mismatch",
      `the built engine hashes ${built}, not ${input.sourceHash}.`,
    );
  }
  readOnly(tmp);
  NodeFS.renameSync(tmp, dir);
  return artifactCli(input.root, input.sourceHash);
}
