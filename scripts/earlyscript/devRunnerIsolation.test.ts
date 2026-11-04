// @effect-diagnostics nodeBuiltinImport:off - builds a fake worktree on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { adoptEarlyscriptEnvironment } from "@t3tools/shared/earlyscriptEnv";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { createDevRunnerEnv, runDevRunnerWithInput } from "../dev-runner.ts";

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

const idleProcess = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1),
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  unref: Effect.succeed(Effect.void),
  stdin: Sink.drain,
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
});

describe("dev-runner environment (Earlyscript)", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("passes no T3 Code variable to the server and hands it its own settings", () =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "es-devrunner-"));
        try {
          // A checkout that is not a linked worktree, like ~/tesis/earlyscript.
          NodeFS.mkdirSync(NodePath.join(root, ".git"));
          // What a T3 Code agent inherits, adopted as the dev runner's entry point does.
          const hostEnvironment: NodeJS.ProcessEnv = {
            PATH: process.env.PATH,
            T3CODE_HOME: NodePath.join(root, "home", ".t3"),
            T3CODE_THREAD_ID: "thread:delegated-task:abc",
            T3_BOOT_SERVICE_UNIT: "t3code.service",
            T3_SERVICE_LAUNCHER_CONTEXT: "{}",
            T3CODE_CLI_PATH: "/home/miguel/.local/bin/t3",
            T3CODE_DEV_SEED: "0",
            ELECTRON_RUN_AS_NODE: "1",
          };
          adoptEarlyscriptEnvironment(hostEnvironment, {
            transitional: true,
            dropElectronRunAsNode: true,
          });

          let captured: NodeJS.ProcessEnv | undefined;
          const spawner = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured ??= (command as { readonly options?: { readonly env?: NodeJS.ProcessEnv } })
                .options?.env;
              return Effect.succeed(idleProcess);
            }),
          );
          const net = Layer.succeed(NetService.NetService, {
            canListenOnHost: () => Effect.succeed(true),
            isPortAvailableOnLoopback: () => Effect.succeed(true),
            hasListenerOnHost: () => Effect.succeed(false),
            reserveLoopbackPort: () => Effect.succeed(49_152),
            findAvailablePort: (port) => Effect.succeed(port),
          });
          yield* runDevRunnerWithInput({
            mode: "dev:server",
            t3Home: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: false,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
            dryRun: false,
            share: false,
            built: false,
            seed: false,
            runArgs: [],
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
                net,
                spawner,
              ),
            ),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.WorkingDirectory, root),
            Effect.provideService(HostProcess.HomeDirectory, NodePath.join(root, "home")),
            Effect.provideService(HostProcess.Environment, hostEnvironment),
          );

          const child = captured!;
          for (const name of Object.keys(child)) {
            assert.notMatch(name, /^T3_/u);
          }
          assert.isUndefined(child.T3CODE_THREAD_ID);
          assert.isUndefined(child.T3CODE_CLI_PATH);
          assert.isUndefined(child.ELECTRON_RUN_AS_NODE);
          assert.notInclude(String(child.T3CODE_HOME), ".t3");

          // The server child adopts its environment again and reads the same settings back.
          const inServer: NodeJS.ProcessEnv = { ...child };
          adoptEarlyscriptEnvironment(inServer, {
            transitional: true,
            dropElectronRunAsNode: false,
          });
          assert.equal(inServer.T3CODE_PORT, child.T3CODE_PORT);
          assert.equal(inServer.T3CODE_HOME, child.T3CODE_HOME);
          assert.equal(inServer.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
    );
  });
});
