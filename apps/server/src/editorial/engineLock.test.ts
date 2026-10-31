// @effect-diagnostics nodeBuiltinImport:off - the tests lay out lock files and start real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { acquireEngineLock, recordEnginePid, releaseEngineLock } from "./engineLock.ts";
import { makeTempDir } from "./persistence/EditorialDatabase.testkit.ts";

const JOB = "job-1";
const OLD = { jobId: JOB, owner: "old", generation: 1 };
const CURRENT = { jobId: JOB, owner: "current", generation: 2 };
const TIMING = { pollMs: 10, startingGraceMs: 100, staleEngineTimeoutMs: 60_000 };

const lockDir = (jobDir: string) => NodePath.join(jobDir, "engine.lock.d");
const fileOf = (jobDir: string, owner: string, generation: number) =>
  NodePath.join(lockDir(jobDir), `${owner}-g${generation}.json`);

/** Moves a file's modification time back, as if written that long ago. */
const age = (file: string, ms: number) => {
  const seconds = (NodeFS.statSync(file).mtimeMs - ms) / 1000;
  NodeFS.utimesSync(file, seconds, seconds);
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A real process, ended when the test ends. */
const spawnProcess = (command: string, args: ReadonlyArray<string>) => {
  const child = NodeChildProcess.spawn(command, args, { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { child, exited, pid: child.pid ?? -1 };
};

const withJobDir = <A, E>(
  body: (jobDir: string) => Effect.Effect<A, E, NodeServices.NodeServices>,
) => {
  const jobDir = makeTempDir();
  return body(jobDir).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(jobDir, { recursive: true, force: true }))),
  );
};

describe("engine lock", () => {
  it.live("a former owner's late pid and late release leave the current owner's file", () =>
    withJobDir((jobDir) =>
      Effect.gen(function* () {
        yield* acquireEngineLock(jobDir, OLD, TIMING);
        // The former owner stalls past its starting grace before naming its child.
        age(fileOf(jobDir, "old", 1), 10_000);
        yield* acquireEngineLock(jobDir, CURRENT, TIMING);
        yield* recordEnginePid(jobDir, CURRENT, 4242);
        const current = NodeFS.readFileSync(fileOf(jobDir, "current", 2), "utf8");
        assert.isFalse(NodeFS.existsSync(fileOf(jobDir, "old", 1)));

        yield* recordEnginePid(jobDir, OLD, 123456);
        assert.strictEqual(NodeFS.readFileSync(fileOf(jobDir, "current", 2), "utf8"), current);
        yield* releaseEngineLock(jobDir, OLD);
        assert.strictEqual(NodeFS.readFileSync(fileOf(jobDir, "current", 2), "utf8"), current);
        assert.deepStrictEqual(NodeFS.readdirSync(lockDir(jobDir)), ["current-g2.json"]);
        assert.deepStrictEqual(JSON.parse(current), {
          owner: "current",
          generation: 2,
          token: "job-1:current:2",
          pid: 4242,
        });
      }),
    ),
  );

  it.live("an empty or truncated foreign file is abandoned once its own age passes the grace", () =>
    withJobDir((jobDir) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(lockDir(jobDir));
        const empty = NodePath.join(lockDir(jobDir), "crashed-g1.json");
        NodeFS.writeFileSync(empty, "");
        const fresh = yield* acquireEngineLock(jobDir, CURRENT, TIMING).pipe(
          Effect.timeoutOption("2 seconds"),
        );
        assert.isTrue(Option.isSome(fresh));
        assert.isFalse(NodeFS.existsSync(empty));

        NodeFS.writeFileSync(empty, '{"owner":"crash');
        age(empty, 10_000);
        const aged = yield* acquireEngineLock(jobDir, CURRENT, {
          ...TIMING,
          startingGraceMs: 5_000,
        }).pipe(Effect.timeoutOption("500 millis"));
        assert.isTrue(Option.isSome(aged));
        assert.isFalse(NodeFS.existsSync(empty));
      }),
    ),
  );

  it.live("a pid that does not carry the job's token is neither waited for nor killed", () =>
    withJobDir((jobDir) =>
      Effect.gen(function* () {
        const stranger = spawnProcess("sleep", ["30"]);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => stranger.child.kill("SIGKILL")).pipe(
            Effect.andThen(Effect.promise(() => stranger.exited)),
          ),
        );
        NodeFS.mkdirSync(lockDir(jobDir));
        NodeFS.writeFileSync(
          fileOf(jobDir, "old", 1),
          JSON.stringify({ owner: "old", generation: 1, token: "job-1:old:1", pid: stranger.pid }),
        );
        const outcome = yield* acquireEngineLock(jobDir, CURRENT, {
          ...TIMING,
          staleEngineTimeoutMs: 0,
        }).pipe(Effect.timeoutOption("2 seconds"));
        assert.deepStrictEqual(outcome, Option.some({ waitedFor: null }));
        assert.isTrue(alive(stranger.pid));
        assert.isFalse(NodeFS.existsSync(fileOf(jobDir, "old", 1)));
      }).pipe(Effect.scoped),
    ),
  );

  it.live("waits for this job's identified engine and kills only it after the timeout", () =>
    withJobDir((jobDir) =>
      Effect.gen(function* () {
        const engine = spawnProcess(process.execPath, [
          "-e",
          "setTimeout(() => {}, 30000)",
          "--",
          "--lock-token",
          "job-1:old:1",
        ]);
        const otherJob = spawnProcess(process.execPath, [
          "-e",
          "setTimeout(() => {}, 30000)",
          "--",
          "--lock-token",
          "job-2:old:1",
        ]);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            engine.child.kill("SIGKILL");
            otherJob.child.kill("SIGKILL");
          }).pipe(
            Effect.andThen(Effect.promise(() => Promise.all([engine.exited, otherJob.exited]))),
          ),
        );
        const outcome = yield* acquireEngineLock(jobDir, CURRENT, {
          ...TIMING,
          staleEngineTimeoutMs: 300,
        });
        yield* Effect.promise(() => engine.exited);
        assert.deepStrictEqual(outcome.waitedFor, {
          pid: engine.pid,
          token: "job-1:old:1",
          killed: true,
        });
        assert.isFalse(alive(engine.pid));
        assert.isTrue(alive(otherJob.pid));
      }).pipe(Effect.scoped),
    ),
  );
});
