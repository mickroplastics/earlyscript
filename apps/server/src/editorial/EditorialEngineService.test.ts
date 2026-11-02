// @effect-diagnostics nodeBuiltinImport:off - writes a stand-in engine CLI to a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { EditorialModelState } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as EditorialEngineService from "./EditorialEngineService.ts";
import { EngineNotFound } from "./engineProcess.ts";

const MiB = 1024 * 1024;

/**
 * An engine CLI that answers `model status` from `status.json` and, for `model prepare`,
 * counts the call, prints progress until `release` exists, then prints the line in
 * `outcome.json` and, on success, makes the model ready.
 */
const FAKE_CLI = `
import * as fs from "node:fs";
import * as path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname);
const [, , command, sub, ...rest] = process.argv;
const modelsAt = rest.indexOf("--models");
const modelPath = modelsAt >= 0 ? rest[modelsAt + 1] : path.join(dir, "home", "earlyscript-data", "models", "c25a394d");
const status = (s) => JSON.stringify({ status: s, revision: "c25a394d", path: modelPath, bytesPresent: s === "ready" ? ${600 * MiB} : 0, bytesExpected: ${600 * MiB} });
if (command === "model" && sub === "status") {
  console.log(status(fs.existsSync(path.join(dir, "ready")) ? "ready" : "missing"));
} else if (command === "model" && sub === "prepare") {
  fs.appendFileSync(path.join(dir, "calls"), "prepare\\n");
  fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  let done = 0;
  const step = () => {
    if (fs.existsSync(path.join(dir, "release"))) {
      const outcome = JSON.parse(fs.readFileSync(path.join(dir, "outcome.json"), "utf8"));
      if (outcome.done) fs.writeFileSync(path.join(dir, "ready"), "");
      console.log(JSON.stringify(outcome));
      process.exit(outcome.done ? 0 : 1);
    }
    done = Math.min(done + ${8 * MiB}, ${600 * MiB});
    console.log(JSON.stringify({ file: "onnx/model_quantized.onnx", bytesDone: done, bytesTotal: ${600 * MiB} }));
    setTimeout(step, 100);
  };
  step();
} else {
  process.exit(64);
}
`;

function fakeEngine(outcome: unknown) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-model-"));
  const cli = NodePath.join(dir, "cli.mjs");
  NodeFS.writeFileSync(cli, FAKE_CLI);
  NodeFS.writeFileSync(NodePath.join(dir, "outcome.json"), JSON.stringify(outcome));
  return {
    dir,
    options: {
      engine: Result.succeed({ cli, defaultConfig: NodePath.join(dir, "engine.v1.json") }),
      modelsDir: null,
      logDir: NodePath.join(dir, "logs"),
      homeDir: NodePath.join(dir, "home"),
    } satisfies EditorialEngineService.EditorialEngineOptions,
    calls: () =>
      NodeFS.existsSync(NodePath.join(dir, "calls"))
        ? NodeFS.readFileSync(NodePath.join(dir, "calls"), "utf8").trim().split("\n").length
        : 0,
    release: () => NodeFS.writeFileSync(NodePath.join(dir, "release"), ""),
  };
}

const alive = (pid: number) => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const firstState = (
  engine: EditorialEngineService.EditorialEngineServiceShape,
  predicate: (state: EditorialModelState) => boolean,
) =>
  engine.watchModel.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout("20 seconds"),
  );

const withService = <A, E>(
  options: EditorialEngineService.EditorialEngineOptions,
  body: (engine: EditorialEngineService.EditorialEngineServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* EditorialEngineService.EditorialEngineService);
  }).pipe(
    Effect.provide(
      EditorialEngineService.layerWith(options).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

describe("EditorialEngineService", () => {
  it.live("reads the model state from the engine, with the home written ~", () => {
    const fake = fakeEngine({ done: true, path: "" });
    return withService(fake.options, (engine) =>
      Effect.gen(function* () {
        const state = yield* engine.modelStatus;
        assert.deepStrictEqual(state, {
          status: "missing",
          revision: "c25a394d",
          path: NodePath.join(fake.dir, "home", "earlyscript-data", "models", "c25a394d"),
          location: "~/earlyscript-data/models",
          bytesPresent: 0,
          bytesExpected: 600 * MiB,
          download: null,
          error: null,
        });
      }),
    );
  });

  it.live("starts one download however often it is asked, and reports its progress", () => {
    const fake = fakeEngine({ done: true, path: "" });
    return withService(fake.options, (engine) =>
      Effect.gen(function* () {
        yield* engine.modelStatus;
        const [first, second] = yield* Effect.all([engine.prepareModel, engine.prepareModel], {
          concurrency: "unbounded",
        });
        assert.isNotNull(first.download);
        assert.isNotNull(second.download);
        const moving = yield* firstState(
          engine,
          (state) => state.download !== null && state.download.bytesPerSecond !== null,
        );
        assert.isAbove(moving.download!.bytesDone, 0);
        assert.strictEqual(moving.download!.bytesTotal, 600 * MiB);
        assert.strictEqual(moving.download!.file, "onnx/model_quantized.onnx");
        // Asked again while it runs: still the same download.
        yield* engine.prepareModel;
        fake.release();
        const ready = yield* firstState(
          engine,
          (state) => state.download === null && state.status === "ready",
        );
        assert.strictEqual(ready.bytesPresent, 600 * MiB);
        assert.isNull(ready.error);
        assert.strictEqual(fake.calls(), 1);
      }),
    );
  });

  it.live("keeps the engine's error and lets a new download start after it", () => {
    const fake = fakeEngine({
      error: { code: "network", message: "fetch failed: other side closed" },
    });
    return withService(fake.options, (engine) =>
      Effect.gen(function* () {
        yield* engine.modelStatus;
        yield* engine.prepareModel;
        fake.release();
        const failed = yield* firstState(
          engine,
          (state) => state.download === null && state.error !== null,
        );
        assert.deepStrictEqual(failed.error, {
          code: "network",
          message: "fetch failed: other side closed",
        });
        assert.strictEqual(failed.status, "missing");
        // A retry clears the error and runs the engine again.
        const retry = yield* engine.prepareModel;
        assert.isNull(retry.error);
        assert.isNotNull(retry.download);
        yield* firstState(engine, (state) => state.download === null);
        assert.strictEqual(fake.calls(), 2);
      }),
    );
  });

  it.live("says the engine is missing instead of failing the call", () =>
    withService(
      {
        engine: Result.fail(new EngineNotFound({ message: "No trend engine CLI at /nowhere" })),
        modelsDir: null,
        logDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-model-")),
        homeDir: NodeOS.homedir(),
      },
      (engine) =>
        Effect.gen(function* () {
          const state = yield* engine.prepareModel;
          assert.strictEqual(state.status, "unknown");
          assert.deepStrictEqual(state.error, {
            code: "engine_missing",
            message: "No trend engine CLI at /nowhere",
          });
          assert.isNull(state.download);
        }),
    ),
  );

  it.live("passes the configured model directory to the engine", () => {
    const fake = fakeEngine({ done: true, path: "" });
    const modelsDir = NodePath.join(fake.dir, "elsewhere", "c25a394d");
    return withService({ ...fake.options, modelsDir }, (engine) =>
      Effect.gen(function* () {
        const state = yield* engine.modelStatus;
        assert.strictEqual(state.path, modelsDir);
        assert.strictEqual(state.location, NodePath.join(fake.dir, "elsewhere"));
      }),
    );
  });

  it.live("interrupting the service kills the download it started", () => {
    const fake = fakeEngine({ done: true, path: "" });
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* withService(fake.options, (engine) =>
        Effect.gen(function* () {
          yield* engine.prepareModel;
          yield* firstState(engine, (state) => state.download?.file !== null);
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const pid = Number(NodeFS.readFileSync(NodePath.join(fake.dir, "pid"), "utf8"));
      assert.isTrue(alive(pid));
      // Closing the service's scope waits for the child to exit.
      yield* Fiber.interrupt(fiber);
      assert.isFalse(alive(pid));
      assert.strictEqual(fake.calls(), 1);
    });
  });
});

describe("parsePrepareLine", () => {
  it("reads progress and errors and ignores the rest", () => {
    assert.deepStrictEqual(
      EditorialEngineService.parsePrepareLine('{"file":"a","bytesDone":1,"bytesTotal":2}'),
      { _tag: "progress", file: "a", bytesDone: 1, bytesTotal: 2 },
    );
    assert.deepStrictEqual(
      EditorialEngineService.parsePrepareLine('{"error":{"code":"weird","message":"m"}}'),
      { _tag: "error", error: { code: "other", message: "m" } },
    );
    assert.isNull(EditorialEngineService.parsePrepareLine('{"done":true,"path":"/m"}'));
    assert.isNull(EditorialEngineService.parsePrepareLine("not json"));
  });

  it("measures speed over the window, not before a second has passed", () => {
    assert.isNull(EditorialEngineService.windowSpeed([{ at: 0, bytes: 0 }]));
    assert.isNull(
      EditorialEngineService.windowSpeed([
        { at: 0, bytes: 0 },
        { at: 500, bytes: 10 },
      ]),
    );
    assert.strictEqual(
      EditorialEngineService.windowSpeed([
        { at: 0, bytes: 0 },
        { at: 2_000, bytes: 8 * MiB },
      ]),
      4 * MiB,
    );
  });
});
