// @effect-diagnostics nodeBuiltinImport:off - copies the evaluator to a directory without its sources.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  EVALUATOR_FILES,
  currentEvaluatorHash,
  evaluatorHash,
  resolveEvaluatorHash,
} from "./evaluator.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-lab-evaluator-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

/** A directory like the packaged server's: the evaluator module, none of the files it hashes. */
const packagedLike = (name: string) => {
  const dir = NodePath.join(root, name);
  NodeFS.mkdirSync(dir);
  // The bundle inlines ./hash.ts; the copy imports this package's own.
  const hashUrl = NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "hash.ts")).href;
  NodeFS.writeFileSync(
    NodePath.join(dir, "evaluator.ts"),
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "evaluator.ts"), "utf8").replace(
      '"./hash.ts"',
      JSON.stringify(hashUrl),
    ),
  );
  return dir;
};

describe("evaluator identity", () => {
  it("in a checkout is the hash of the evaluator's sources, as campaigns recorded it", () => {
    expect(currentEvaluatorHash()).toBe(evaluatorHash());
    expect(currentEvaluatorHash()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("prefers the hash a build embedded and then reads no source", () => {
    const empty = NodePath.join(root, "empty");
    NodeFS.mkdirSync(empty);
    expect(resolveEvaluatorHash("sha256:embedded", empty)).toBe("sha256:embedded");
  });

  it("without sources nor an embedded hash, fails naming the missing files", () => {
    expect(() => resolveEvaluatorHash(undefined, NodePath.join(root, "nowhere"))).toThrow(
      EVALUATOR_FILES.join(", "),
    );
  });

  it("loads without its sources: the hash is computed on first use, not at import", async () => {
    const dir = packagedLike("packaged");
    expect(EVALUATOR_FILES.some((name) => NodeFS.existsSync(NodePath.join(dir, name)))).toBe(false);
    const module = (await import(
      NodeURL.pathToFileURL(NodePath.join(dir, "evaluator.ts")).href
    )) as typeof import("./evaluator.ts");
    expect(() => module.currentEvaluatorHash()).toThrow("embeds no evaluator hash");
  });

  it("in the bundle, answers the embedded hash", async () => {
    const dir = packagedLike("embedded");
    const global = globalThis as { __EARLYSCRIPT_EVALUATOR_HASH__?: string };
    global.__EARLYSCRIPT_EVALUATOR_HASH__ = evaluatorHash();
    try {
      const module = (await import(
        NodeURL.pathToFileURL(NodePath.join(dir, "evaluator.ts")).href
      )) as typeof import("./evaluator.ts");
      expect(module.currentEvaluatorHash()).toBe(evaluatorHash());
    } finally {
      delete global.__EARLYSCRIPT_EVALUATOR_HASH__;
    }
  });
});
