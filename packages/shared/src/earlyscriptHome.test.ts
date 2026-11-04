// @effect-diagnostics nodeBuiltinImport:off - follows real symlinks on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  assertEarlyscriptDataDirectory,
  findT3CodeDataDirectory,
  T3CodeDataDirectoryError,
} from "./earlyscriptHome.ts";

const linux = { homeDirectory: "/home/miguel", platform: "linux" } as const;
const mac = { homeDirectory: "/Users/miguel", platform: "darwin" } as const;

describe("assertEarlyscriptDataDirectory", () => {
  it("rejects T3 Code's home and anything inside it", () => {
    for (const directory of [
      "/home/miguel/.t3",
      "/home/miguel/.t3/",
      "/home/miguel/.t3/userdata",
    ]) {
      assert.throws(
        () => assertEarlyscriptDataDirectory(directory, linux),
        T3CodeDataDirectoryError,
      );
    }
    assert.throws(
      () => assertEarlyscriptDataDirectory("/home/miguel/.earlyscript/../.t3", linux),
      /pertenece a T3 Code \(\/home\/miguel\/\.t3\)/,
    );
  });

  it("accepts Earlyscript's own homes and look-alike names", () => {
    for (const directory of [
      "/home/miguel/.earlyscript",
      "/home/miguel/earlyscript-data/isolation/home",
      "/home/miguel/.t3code",
      "/home/miguel/.t3-old",
      "/repo/.t3",
    ]) {
      assert.equal(assertEarlyscriptDataDirectory(directory, linux), directory);
    }
  });

  it("checks every platform's folders when the platform is unknown", () => {
    const anywhere = { homeDirectory: "/home/miguel" };
    assert.equal(findT3CodeDataDirectory("/home/miguel/.t3/x", anywhere), "/home/miguel/.t3");
    assert.equal(
      findT3CodeDataDirectory("/home/miguel/Library/Application Support/t3code", anywhere),
      "/home/miguel/Library/Application Support/t3code",
    );
    assert.equal(findT3CodeDataDirectory("/home/miguel/.earlyscript", anywhere), undefined);
  });

  it("rejects T3 Code's Electron userData on each platform", () => {
    assert.equal(
      findT3CodeDataDirectory(
        "/Users/miguel/Library/Application Support/T3Code/Local Storage",
        mac,
      ),
      "/Users/miguel/Library/Application Support/t3code",
    );
    assert.equal(
      findT3CodeDataDirectory("/home/miguel/.config/t3code-dev", linux),
      "/home/miguel/.config/t3code-dev",
    );
    assert.equal(
      findT3CodeDataDirectory("D:\\Roaming\\t3code\\x", {
        homeDirectory: "C:\\Users\\miguel",
        platform: "win32",
        appDataDirectory: "D:\\Roaming",
      }),
      "D:\\Roaming\\t3code",
    );
    assert.equal(
      findT3CodeDataDirectory("/Users/miguel/Library/Application Support/earlyscript", mac),
      undefined,
    );
  });

  describe("through symbolic links", () => {
    const roots: Array<string> = [];
    afterEach(() => {
      for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
    });

    it("rejects a link that points into T3 Code's home", () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "es-home-"));
      roots.push(home);
      NodeFS.mkdirSync(NodePath.join(home, ".t3", "userdata"), { recursive: true });
      const link = NodePath.join(home, "looks-harmless");
      NodeFS.symlinkSync(NodePath.join(home, ".t3"), link);
      assert.throws(
        () => assertEarlyscriptDataDirectory(link, { homeDirectory: home, platform: "linux" }),
        T3CodeDataDirectoryError,
      );
    });
  });
});
