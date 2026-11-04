import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { createDevRunnerEnv } from "../dev-runner.ts";

const envFor = (t3Home: string | undefined) =>
  createDevRunnerEnv({
    mode: "dev:server",
    baseEnv: {},
    serverOffset: 0,
    webOffset: 0,
    t3Home,
    browser: undefined,
    autoBootstrapProjectFromCwd: undefined,
    logWebSocketEvents: undefined,
    host: undefined,
    port: undefined,
    devUrl: undefined,
  }).pipe(Effect.provideService(HostProcess.HomeDirectory, "/home/miguel"));

describe("dev-runner data directory (Earlyscript guard)", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("accepts the isolation home", () =>
      Effect.gen(function* () {
        const env = yield* envFor("/home/miguel/earlyscript-data/isolation/home");
        assert.equal(env.T3CODE_HOME, "/home/miguel/earlyscript-data/isolation/home");
      }),
    );

    it.effect.each(["~/.t3", "/home/miguel/.t3", "/home/miguel/.t3/userdata"])(
      "refuses %s",
      (t3Home) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(envFor(t3Home));
          assert.isTrue(Exit.isFailure(exit));
          assert.include(
            String(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)),
            "pertenece a T3 Code",
          );
        }),
    );
  });
});
