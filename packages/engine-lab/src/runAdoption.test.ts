// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the adoption works on directories on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { adoptArtifactRun, sweepIncoming } from "./runAdoption.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-lab-adoption-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const expect_ = {
  cutoff_at: "2026-08-20T00:00:00.000Z",
  config_hash: "sha256:c",
  profile_hash: "sha256:p",
  profile_path: NodePath.join(root, "profile.g1.json"),
};

/** A private output holding one run whose run.json names `files`. */
function output(name: string, runId: string, files: ReadonlyArray<string>) {
  const out = NodePath.join(root, name);
  const dir = NodePath.join(out, "runs", runId);
  NodeFS.mkdirSync(NodePath.join(dir, "dossiers"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "dossiers", "0.json"), "{}");
  NodeFS.writeFileSync(
    NodePath.join(dir, "run.json"),
    JSON.stringify({
      run_id: runId,
      status: "ok",
      cutoff_at: expect_.cutoff_at,
      config_hash: expect_.config_hash,
      profile: { hash: expect_.profile_hash, path: expect_.profile_path },
      files,
    }),
  );
  return out;
}

describe("adopting an approved artifact's nightly run (Sol S1)", () => {
  const runsDir = NodePath.join(root, "runs");

  it.each([
    ["a parent path", ["../foreign/0.json"]],
    ["an absolute path", [NodePath.join(root, "foreign", "0.json")]],
    ["a file it does not hold", ["dossiers/1.json"]],
    ["a repeated file", ["dossiers/0.json", "dossiers/0.json"]],
    ["no list", "none"],
  ])("refuses a run.json that names %s", (_name, files) => {
    // Sol's case: dossiers beside the product's runs, named from the private output.
    NodeFS.mkdirSync(NodePath.join(root, "foreign"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "foreign", "0.json"), "{}");
    const runId = `run_refused_${String(files).length}`;
    const out = output(`out-${runId}`, runId, typeof files === "string" ? [] : files);
    if (files === "none") {
      const file = NodePath.join(out, "runs", runId, "run.json");
      const { files: _files, ...rest } = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      NodeFS.writeFileSync(file, JSON.stringify(rest));
    }
    expect(() => adoptArtifactRun({ out, runsDir, runId, expect: expect_ })).toThrow(
      "dossiers outside its own output",
    );
    expect(NodeFS.existsSync(NodePath.join(runsDir, runId))).toBe(false);
  });

  it("adopts a run whose dossiers are its own, and sweeps copies a crashed adoption left", () => {
    // A copy whose process is gone, as a crash mid-adoption leaves it.
    NodeFS.mkdirSync(runsDir, { recursive: true });
    const orphan = NodePath.join(runsDir, ".incoming-run_crashed-999999999");
    NodeFS.mkdirSync(orphan, { recursive: true });
    const live = NodePath.join(runsDir, `.incoming-run_live-${process.pid}`);
    NodeFS.mkdirSync(live, { recursive: true });
    const out = output("out-valid", "run_valid", ["dossiers/0.json"]);
    expect(adoptArtifactRun({ out, runsDir, runId: "run_valid", expect: expect_ })).toBe(
      "run_valid",
    );
    expect(NodeFS.existsSync(NodePath.join(runsDir, "run_valid", "dossiers", "0.json"))).toBe(true);
    expect(NodeFS.existsSync(orphan)).toBe(false);
    expect(NodeFS.existsSync(live)).toBe(true);
    expect(sweepIncoming(runsDir)).toEqual([]);
  });
});
