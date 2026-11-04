import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ChildProcessEnvironment from "./childProcessEnvironment.ts";

/** What an Earlyscript server holds after adopting its environment. */
const serverEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  EARLYSCRIPT_HOME: "/tmp/es-home",
  EARLYSCRIPT_PORT: "14842",
  T3CODE_HOME: "/tmp/es-home",
  T3CODE_PORT: "14842",
  T3CODE_PORT_OFFSET: "69",
  ELECTRON_RUN_AS_NODE: "1",
};

const INTERESTING = /^(T3CODE_|T3_|EARLYSCRIPT_|ELECTRON_RUN_AS_NODE$)/u;
const printEnv = (options: ChildProcess.CommandOptions = {}) =>
  ChildProcess.make(
    process.execPath,
    [
      "-e",
      `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => ${INTERESTING}.test(k)))))`,
    ],
    options,
  );

const layer = ChildProcessEnvironment.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(HostProcess.Environment, serverEnv)),
);

const childEnv = (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return JSON.parse(yield* spawner.string(command)) as Record<string, string>;
  }).pipe(Effect.provide(layer));

it.effect("a real child gets the home but none of the server's aliases", () =>
  Effect.gen(function* () {
    const expected = { EARLYSCRIPT_HOME: "/tmp/es-home", ELECTRON_RUN_AS_NODE: "1" };
    // Inherited, inherited plus extras, and a copy of the server's environment.
    assert.deepStrictEqual(yield* childEnv(printEnv()), expected);
    assert.deepStrictEqual(
      yield* childEnv(
        printEnv({
          extendEnv: true,
          env: { T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:14842/mcp/s1" },
        }),
      ),
      { ...expected, T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:14842/mcp/s1" },
    );
    assert.deepStrictEqual(
      yield* childEnv(printEnv({ env: { ...serverEnv, T3CODE_PROJECT_ROOT: "/repo" } })),
      { ...expected, T3CODE_PROJECT_ROOT: "/repo" },
    );
  }),
);

it.effect("filters each side of a pipeline", () =>
  Effect.gen(function* () {
    const command = ChildProcess.make(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ]);
    const piped = printEnv().pipe(ChildProcess.pipeTo(command));
    assert.deepStrictEqual(yield* childEnv(piped), {
      EARLYSCRIPT_HOME: "/tmp/es-home",
      ELECTRON_RUN_AS_NODE: "1",
    });
    const rebuilt = ChildProcessEnvironment.withEarlyscriptChildEnvironment(piped, serverEnv);
    assert.equal(rebuilt._tag, "PipedCommand");
    if (rebuilt._tag !== "PipedCommand" || rebuilt.right._tag !== "StandardCommand") return;
    assert.isUndefined(rebuilt.right.options.env?.T3CODE_HOME);
    assert.isFalse(rebuilt.right.options.extendEnv);
  }),
);

it.effect("replaces the plain spawner in layerNodeServices", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* spawner.string(
      printEnv({ env: { PATH: process.env.PATH, T3CODE_HOME: "/tmp/server-alias" } }),
    );
    // HostProcess.Environment holds the same value, so the child does not get it.
    assert.deepStrictEqual(JSON.parse(output), {});
  }).pipe(
    Effect.provide(ChildProcessEnvironment.layerNodeServices),
    Effect.provideService(HostProcess.Environment, { T3CODE_HOME: "/tmp/server-alias" }),
  ),
);
