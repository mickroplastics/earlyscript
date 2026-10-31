// @effect-diagnostics nodeBuiltinImport:off - lays out partial downloads in a temporary model directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { describe, expect, it } from "vite-plus/test";

import { tempDir } from "../testkit/syntheticCorpus.ts";
import { prepareModel } from "./model.ts";

describe("prepareModel", () => {
  it("removes partials of a dead or stalled download and keeps a live one", async () => {
    const dir = tempDir("model-partials");
    const partial = (owner: number | null) => {
      const file = NodePath.join(
        dir,
        `config.json.${owner === null ? "" : `${owner}.`}${NodeCrypto.randomUUID()}.partial`,
      );
      NodeFS.writeFileSync(file, "x".repeat(128));
      return file;
    };
    const exited = NodeChildProcess.spawnSync(NodeProcess.execPath, ["-e", ""]).pid;
    const crashed = partial(exited);
    const unowned = partial(null);
    const stalled = partial(NodeProcess.pid);
    NodeFS.utimesSync(stalled, 946_684_800, 946_684_800); // 2000-01-01, seconds
    const live = partial(NodeProcess.pid);

    await expect(prepareModel(dir, false)).rejects.toThrow(/Model file missing/);

    expect([crashed, unowned, stalled, live].map((file) => NodeFS.existsSync(file))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});
