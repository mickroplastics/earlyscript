// @effect-diagnostics nodeBuiltinImport:off - pure POSIX paths for a pure function.
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";
import * as Option from "effect/Option";
import { T3CodeDataDirectoryError } from "@t3tools/shared/earlyscriptHome";

import { resolveDesktopBaseDir } from "../app/DesktopStatePaths.ts";

const resolve = (t3Home: string | undefined) =>
  resolveDesktopBaseDir({
    homeDirectory: "/home/miguel",
    joinPath: NodePath.posix.join,
    t3Home: Option.fromUndefinedOr(t3Home),
  });

describe("resolveDesktopBaseDir (Earlyscript guard)", () => {
  it("defaults to ~/.earlyscript and keeps other homes", () => {
    assert.equal(resolve(undefined), "/home/miguel/.earlyscript");
    assert.equal(resolve("/repo/.t3"), "/repo/.t3");
  });

  it("refuses T3 Code's home", () => {
    assert.throws(() => resolve("/home/miguel/.t3"), T3CodeDataDirectoryError);
    assert.throws(() => resolve("/home/miguel/.t3/userdata"), T3CodeDataDirectoryError);
  });
});
