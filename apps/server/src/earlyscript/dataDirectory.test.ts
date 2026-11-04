import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { resolveBaseDir } from "../os-jank.ts";

const inHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.HomeDirectory, "/home/miguel"),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

it.layer(NodeServices.layer)("resolveBaseDir (Earlyscript guard)", (it) => {
  it.effect("defaults to ~/.earlyscript", () =>
    Effect.gen(function* () {
      assert.equal(yield* inHome(resolveBaseDir(undefined)), "/home/miguel/.earlyscript");
      assert.equal(yield* inHome(resolveBaseDir("~/.earlyscript")), "/home/miguel/.earlyscript");
    }),
  );

  it.effect.each(["~/.t3", "/home/miguel/.t3", "~/.t3/userdata", "/home/miguel/.config/t3code"])(
    "refuses %s",
    (raw) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(inHome(resolveBaseDir(raw)));
        assert.equal(error._tag, "EarlyscriptDataDirectoryError");
        assert.include(error.message, "pertenece a T3 Code");
      }),
  );
});
