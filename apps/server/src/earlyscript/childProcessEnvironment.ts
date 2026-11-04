// Earlyscript-only module: every process the server starts through Effect's spawner (ACP agents,
// Codex, OpenCode, Pi, git, provider probes) gets `earlyscriptChildEnvironment`, so the server's
// internal `T3CODE_*` aliases never reach agents or the tools they run.
import { earlyscriptChildEnvironment } from "@t3tools/shared/earlyscriptEnv";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** `command` with its full environment resolved now (as the spawner would) and filtered. */
export function withEarlyscriptChildEnvironment(
  command: ChildProcess.Command,
  serverEnv: NodeJS.ProcessEnv,
): ChildProcess.Command {
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(
      withEarlyscriptChildEnvironment(command.left, serverEnv),
      withEarlyscriptChildEnvironment(command.right, serverEnv),
      command.options,
    );
  }
  const { env, extendEnv } = command.options;
  const full = extendEnv === true || env === undefined ? { ...serverEnv, ...env } : env;
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    env: earlyscriptChildEnvironment(full, serverEnv),
    extendEnv: false,
  });
}

/** Wraps the platform spawner below it; provide it over `NodeServices.layer`. */
export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverEnv = yield* HostProcess.Environment;
    return ChildProcessSpawner.make((command) =>
      spawner.spawn(withEarlyscriptChildEnvironment(command, serverEnv)),
    );
  }),
);

/** The filtering spawner over the platform one. */
export const layerSpawner = layer.pipe(Layer.provide(NodeServices.layer));

/**
 * `NodeServices.layer` with the filtering spawner in place of the plain one. A layer that
 * re-exports `NodeServices` (`NodeHttpServer.layer`) shadows it for the layers it feeds: merge
 * `layerSpawner` after it, as server.ts does.
 */
export const layerNodeServices = Layer.merge(NodeServices.layer, layerSpawner);
