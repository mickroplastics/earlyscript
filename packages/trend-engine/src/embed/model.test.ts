// @effect-diagnostics nodeBuiltinImport:off - lays out partial downloads in a temporary model directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { serveModel, syntheticModelFiles, type ModelMirror } from "../testkit/modelMirror.ts";
import { tempDir } from "../testkit/syntheticCorpus.ts";
import { prepareModel } from "./model.ts";

const body = NodeCrypto.randomBytes(4096);
const files = syntheticModelFiles({ "config.json": body });

const mirrors: Array<ModelMirror> = [];
afterEach(async () => {
  for (const mirror of mirrors.splice(0)) await mirror.close();
});

/** Partials of a crashed, an unowned, a stalled and a live download of config.json. */
function layPartials() {
  const dir = tempDir("model-partials");
  const partial = (owner: number | null, bytes: Buffer) => {
    const file = NodePath.join(
      dir,
      `config.json.${owner === null ? "" : `${owner}.`}${NodeCrypto.randomUUID()}.partial`,
    );
    NodeFS.writeFileSync(file, bytes);
    return file;
  };
  const exited = NodeChildProcess.spawnSync(NodeProcess.execPath, ["-e", ""]).pid;
  const crashed = partial(exited, body.subarray(0, 2048));
  const unowned = partial(null, body.subarray(0, 512));
  const stalled = partial(NodeProcess.pid, body.subarray(0, 1024));
  NodeFS.utimesSync(stalled, 946_684_800, 946_684_800); // 2000-01-01, seconds
  const live = partial(NodeProcess.pid, Buffer.alloc(128));
  return { dir, crashed, unowned, stalled, live };
}

const sizes = (paths: ReadonlyArray<string>) =>
  paths.map((path) => (NodeFS.existsSync(path) ? NodeFS.statSync(path).size : null));

describe("prepareModel", () => {
  it("touches no partial when it may not download, and fails as missing", async () => {
    const { dir, crashed, unowned, stalled, live } = layPartials();
    await expect(prepareModel(dir, false, { files })).rejects.toThrow(/Model file missing/);
    expect(sizes([crashed, unowned, stalled, live])).toEqual([2048, 512, 1024, 128]);
  });

  it("resumes the largest abandoned partial, removes the others and keeps a live one", async () => {
    const { dir, crashed, unowned, stalled, live } = layPartials();
    const served = await serveModel({ files: { "config.json": body } });
    mirrors.push(served);
    await prepareModel(dir, true, { files, baseUrl: served.baseUrl });
    expect(served.requests.map((request) => request.range)).toEqual(["bytes=2048-"]);
    expect(NodeFS.readFileSync(NodePath.join(dir, "config.json")).equals(body)).toBe(true);
    expect(sizes([crashed, unowned, stalled, live])).toEqual([null, null, null, 128]);
  });
});
