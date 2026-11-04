// @effect-diagnostics nodeBuiltinImport:off - follows real symlinks on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  assertEarlyscriptDataDirectory,
  checkEarlyscriptDataDirectory,
  earlyscriptHomeContextOf,
  T3CodeDataDirectoryError,
  type EarlyscriptHomeContext,
} from "./earlyscriptHome.ts";

/** The T3 Code folder holding `candidate`, or undefined when it is outside them. */
const findT3CodeDataDirectory = (candidate: string, context: EarlyscriptHomeContext) => {
  const check = checkEarlyscriptDataDirectory(candidate, context);
  assert.notEqual(check.kind, "unverifiable");
  return check.kind === "inside" ? check.t3CodeDirectory : undefined;
};

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

  it("derives T3 Code's userData from APPDATA and XDG_CONFIG_HOME, keeping the defaults", () => {
    const windows = earlyscriptHomeContextOf({
      homeDirectory: "C:\\Users\\Miguel",
      platform: "win32",
      env: { APPDATA: "D:\\Roaming", XDG_CONFIG_HOME: "/ignored" },
    });
    assert.equal(windows.appDataDirectory, "D:\\Roaming");
    assert.equal(findT3CodeDataDirectory("D:\\Roaming\\t3code", windows), "D:\\Roaming\\t3code");
    assert.equal(
      findT3CodeDataDirectory("C:\\Users\\Miguel\\AppData\\Roaming\\t3code-dev", windows),
      "C:\\Users\\Miguel\\AppData\\Roaming\\t3code-dev",
    );
    const linux = earlyscriptHomeContextOf({
      homeDirectory: "/home/miguel",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/data/config", APPDATA: "D:\\ignored" },
    });
    assert.equal(findT3CodeDataDirectory("/data/config/t3code/x", linux), "/data/config/t3code");
    assert.equal(
      findT3CodeDataDirectory("/home/miguel/.config/t3code", linux),
      "/home/miguel/.config/t3code",
    );
    assert.equal(findT3CodeDataDirectory("/data/config/earlyscript", linux), undefined);
    assert.isUndefined(
      earlyscriptHomeContextOf({ homeDirectory: "/Users/m", platform: "darwin", env: {} })
        .appDataDirectory,
    );
    assert.isUndefined(
      earlyscriptHomeContextOf({
        homeDirectory: "/home/m",
        platform: "linux",
        env: { XDG_CONFIG_HOME: " " },
      }).appDataDirectory,
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

    const fakeHome = () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "es-home-"));
      roots.push(home);
      NodeFS.mkdirSync(NodePath.join(home, ".t3", "userdata"), { recursive: true });
      return { home, context: { homeDirectory: home, platform: "linux" } as const };
    };

    it("rejects missing folders below a link to T3 Code's home, one or several levels deep", () => {
      const { home, context } = fakeHome();
      const link = NodePath.join(home, "looks-harmless");
      NodeFS.symlinkSync(NodePath.join(home, ".t3"), link);
      for (const candidate of [
        NodePath.join(link, "missing"),
        NodePath.join(link, "missing", "child"),
        NodePath.join(link, "userdata", "missing", "a", "b"),
        `${link}/./missing/../other/child`,
      ]) {
        assert.throws(
          () => assertEarlyscriptDataDirectory(candidate, context),
          /pertenece a T3 Code/,
          candidate,
        );
      }
      assert.deepEqual(NodeFS.readdirSync(NodePath.join(home, ".t3")), ["userdata"]);
    });

    it("rejects paths through a link whose parent folder is a link to T3 Code's home", () => {
      const { home, context } = fakeHome();
      NodeFS.mkdirSync(NodePath.join(home, "work"));
      NodeFS.symlinkSync(NodePath.join(home, ".t3"), NodePath.join(home, "work", "t3"));
      NodeFS.symlinkSync(NodePath.join(home, "work", "t3"), NodePath.join(home, "chain"));
      assert.throws(
        () => assertEarlyscriptDataDirectory(NodePath.join(home, "chain", "x", "y"), context),
        T3CodeDataDirectoryError,
      );
    });

    it("follows `..` after a link the way the kernel does", () => {
      const { home, context } = fakeHome();
      // `inside/..` is ~/.t3 on disk, although the path reads as `<home>/x`.
      NodeFS.symlinkSync(NodePath.join(home, ".t3", "userdata"), NodePath.join(home, "inside"));
      assert.throws(
        () =>
          assertEarlyscriptDataDirectory(`${NodePath.join(home, "inside")}/../new/child`, context),
        T3CodeDataDirectoryError,
      );
    });

    it("rejects a dangling link that would create its target inside T3 Code's home", () => {
      const { home, context } = fakeHome();
      const link = NodePath.join(home, "dangling");
      NodeFS.symlinkSync(NodePath.join(home, ".t3", "not-yet"), link);
      assert.throws(() => assertEarlyscriptDataDirectory(link, context), T3CodeDataDirectoryError);
      assert.throws(
        () => assertEarlyscriptDataDirectory(NodePath.join(link, "child"), context),
        T3CodeDataDirectoryError,
      );
      const relative = NodePath.join(home, "relative");
      NodeFS.symlinkSync(".t3/later", relative);
      assert.throws(
        () => assertEarlyscriptDataDirectory(NodePath.join(relative, "a"), context),
        T3CodeDataDirectoryError,
      );
    });

    it("refuses when a link on the way cannot be followed", () => {
      const { home, context } = fakeHome();
      const loop = NodePath.join(home, "loop");
      NodeFS.symlinkSync(loop, loop);
      const check = checkEarlyscriptDataDirectory(NodePath.join(loop, "child"), context);
      assert.equal(check.kind, "unverifiable");
      assert.throws(
        () => assertEarlyscriptDataDirectory(NodePath.join(loop, "child"), context),
        /no se pudo comprobar/,
      );
    });

    it("still accepts new folders of Earlyscript's own", () => {
      const { home, context } = fakeHome();
      NodeFS.mkdirSync(NodePath.join(home, "real"));
      NodeFS.symlinkSync(NodePath.join(home, "real"), NodePath.join(home, "safe-link"));
      for (const candidate of [
        NodePath.join(home, ".earlyscript-x"),
        NodePath.join(home, "nueva", "carpeta"),
        NodePath.join(home, "safe-link", "nueva", "carpeta"),
        NodePath.join(home, ".t3code", "x"),
      ]) {
        assert.equal(assertEarlyscriptDataDirectory(candidate, context), candidate);
      }
    });
  });
});
