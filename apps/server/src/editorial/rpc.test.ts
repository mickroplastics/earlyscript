// @effect-diagnostics nodeBuiltinImport:off -- the boundary test reads the server sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ProviderInstanceId,
  EDITORIAL_RPC_REQUIRED_SCOPES,
  EDITORIAL_WRITE_METHODS,
  EDITORIAL_WS_METHODS,
  EditorialDossierId,
  EditorialRpcGroup,
  EditorialRunId,
  EditorialTrendKey,
  RpcScopeAuthorization,
  type EditorialReadError,
  type EditorialStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialInboxCommands } from "./EditorialInboxCommands.ts";
import { withEditorial } from "./editorialLayer.testkit.ts";
import { subscribeInbox, SUBSCRIBE_MAX_REPLAY } from "./inboxStream.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { EditorialRpcHandlers } from "./rpc.ts";

const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");
const QUANTUM = EditorialDossierId.make("dos_bbb80d57481e");
const QUANTUM_KEY = EditorialTrendKey.make("sig_69a4b83dd577");
const CHINA_KEY = EditorialTrendKey.make("sig_833479e1f4de");
const JUDGE_KEY = EditorialTrendKey.make("sig_7c382e796d60");
const SESSION = { sessionId: "session-operator" };

const group = EditorialRpcGroup.middleware(RpcScopeAuthorization);
/** An mtime in seconds after the fixture copy's. */
const LATER = Date.UTC(2030, 0, 1) / 1000;

/** A typed in-memory client over the editorial group, behind the server's scope middleware. */
const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const handlers = (yield* EditorialRpcHandlers).forSession(SESSION);
    return yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(group.toLayer(handlers), RpcAuthorization.layer(scopes))),
    );
  });

const VIDEO_INPUT = {
  trendKey: QUANTUM_KEY,
  runId: RUN_ID,
  dossierId: QUANTUM,
  projectId: ProjectId.make("project:studio"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
};

/** Records each launch input and answers as ThreadLaunchService does. */
const makeLaunchDouble = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
  const layer = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.update(calls, (current) => [...current, input]).pipe(
        Effect.as({
          threadId: input.threadId as ThreadId,
          projection: {} as ThreadLaunch.ThreadLaunchResult["projection"],
          resumed: false,
        }),
      ),
  });
  return { calls, layer };
});

const events = Effect.gen(function* () {
  return yield* (yield* EditorialEventLog).readSince(0);
});

describe("editorial RPC authorization", () => {
  it("reads with orchestration:read and writes only with orchestration:operate", () => {
    for (const method of [
      EDITORIAL_WS_METHODS.listRuns,
      EDITORIAL_WS_METHODS.getInbox,
      EDITORIAL_WS_METHODS.getDossier,
      EDITORIAL_WS_METHODS.subscribe,
    ]) {
      assert.strictEqual(EDITORIAL_RPC_REQUIRED_SCOPES[method], AuthOrchestrationReadScope);
      assert.strictEqual(RpcAuthorization.requiredScopeForRpcMethod(method), "orchestration:read");
    }
    for (const method of EDITORIAL_WRITE_METHODS) {
      assert.strictEqual(EDITORIAL_RPC_REQUIRED_SCOPES[method], AuthOrchestrationOperateScope);
      assert.strictEqual(
        RpcAuthorization.requiredScopeForRpcMethod(method),
        AuthOrchestrationOperateScope,
      );
    }
  });

  it.effect("rejects a write from a read-only session before its handler runs", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        yield* (yield* EditorialImportService).sync;
        const client = yield* clientWith([AuthOrchestrationReadScope]);
        const inbox = yield* client[EDITORIAL_WS_METHODS.getInbox]({});
        assert.strictEqual(inbox.total, 3);
        for (const attempt of [
          client[EDITORIAL_WS_METHODS.dismiss]({ trendKey: QUANTUM_KEY, reason: "No" }),
          client[EDITORIAL_WS_METHODS.markRead]({
            trendKey: QUANTUM_KEY,
            runId: RUN_ID,
            dossierId: QUANTUM,
          }),
          client[EDITORIAL_WS_METHODS.snooze]({ trendKey: QUANTUM_KEY }),
          client[EDITORIAL_WS_METHODS.unsnooze]({ trendKey: QUANTUM_KEY }),
          client[EDITORIAL_WS_METHODS.reopen]({ trendKey: QUANTUM_KEY }),
          client[EDITORIAL_WS_METHODS.createVideo](VIDEO_INPUT),
        ]) {
          const error = yield* attempt.pipe(Effect.flip);
          assert.strictEqual(error._tag, "EnvironmentAuthorizationError");
          assert.strictEqual(
            "requiredPermission" in error ? error.requiredPermission : undefined,
            AuthOrchestrationOperateScope,
          );
        }
        // Only the import wrote an event.
        assert.deepStrictEqual(
          (yield* events).map((event) => event.type),
          ["run.imported"],
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("takes the actor from the session and ignores one sent in the payload", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        yield* (yield* EditorialImportService).sync;
        const client = yield* clientWith([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        const forged = {
          trendKey: QUANTUM_KEY,
          reason: "Off topic",
          actor: "system",
          actorSessionId: "session-forged",
        } as unknown as { readonly trendKey: EditorialTrendKey; readonly reason: string };
        const result = yield* client[EDITORIAL_WS_METHODS.dismiss](forged);
        assert.deepStrictEqual(result.state.dismissed?.reason, "Off topic");

        const dismissed = (yield* events).find((event) => event.type === "trend.dismissed");
        assert.strictEqual(dismissed?.actor, "operator");
        assert.strictEqual(dismissed?.actorSessionId, SESSION.sessionId);
        assert.deepStrictEqual(dismissed?.payload, { reason: "Off topic" });

        const read = yield* client[EDITORIAL_WS_METHODS.markRead]({
          trendKey: CHINA_KEY,
          runId: RUN_ID,
          dossierId: QUANTUM,
        }).pipe(Effect.flip);
        // The dossier belongs to another trend: nothing is written.
        assert.strictEqual(read._tag, "EditorialCommandError");
        assert.strictEqual(
          (yield* events).filter((event) => event.type === "trend.read").length,
          0,
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("creates one video thread per trend and answers a second click with it", () =>
    Effect.gen(function* () {
      const launch = yield* makeLaunchDouble;
      yield* withEditorial(
        () =>
          Effect.gen(function* () {
            yield* (yield* EditorialImportService).sync;
            const client = yield* clientWith([
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]);
            const live = yield* Stream.toQueue(yield* subscribeInbox({}), { capacity: 8 });
            assert.strictEqual((yield* Queue.take(live))._tag, "snapshot");
            const first = yield* client[EDITORIAL_WS_METHODS.createVideo](VIDEO_INPUT);
            assert.isTrue(first.created);
            assert.strictEqual(first.state.production?.threadId, first.threadId);
            // Open inboxes learn of the production link without a refetch.
            const linked = yield* Queue.take(live);
            assert.ok(linked._tag === "trend");
            assert.strictEqual(linked.trendKey, QUANTUM_KEY);
            assert.strictEqual(linked.state.production?.threadId, first.threadId);

            const [call] = yield* Ref.get(launch.calls);
            assert.strictEqual(call?.threadId, first.threadId);
            assert.strictEqual(call?.projectId, VIDEO_INPUT.projectId);
            assert.isUndefined(call?.initialMessage);
            assert.match(call?.title ?? "", /^Video: /);

            const second = yield* client[EDITORIAL_WS_METHODS.createVideo](VIDEO_INPUT);
            assert.isFalse(second.created);
            assert.strictEqual(second.threadId, first.threadId);
            assert.strictEqual((yield* Ref.get(launch.calls)).length, 1);

            const registered = (yield* events).find(
              (event) => event.type === "video-thread.registered",
            );
            assert.deepStrictEqual(registered?.payload, {
              environmentId: "environment:editorial-test",
              mode: "assisted",
              trendKey: QUANTUM_KEY,
              runId: RUN_ID,
              dossierId: QUANTUM,
            });

            // A dossier of another trend never attaches to this one.
            const mismatch = yield* client[EDITORIAL_WS_METHODS.createVideo]({
              ...VIDEO_INPUT,
              trendKey: CHINA_KEY,
            }).pipe(Effect.flip);
            assert.ok(mismatch._tag === "EditorialCommandError");
            assert.strictEqual(mismatch.reason, "not-found");
          }).pipe(Effect.scoped),
        { launch: launch.layer },
      );
    }),
  );

  it("exposes no editorial write to MCP tools or orchestration commands", () => {
    // Structural check: the modules an agent reaches (MCP toolkits, orchestration, provider
    // turns) neither import the editorial command services nor name the write methods.
    const serverSrc = NodePath.resolve(import.meta.dirname, "..");
    const contractsSrc = NodePath.resolve(serverSrc, "../../../packages/contracts/src");
    const roots = [
      NodePath.join(serverSrc, "mcp"),
      NodePath.join(serverSrc, "editorial", "mcp"),
      NodePath.join(serverSrc, "orchestration-v2"),
      NodePath.join(serverSrc, "provider"),
      NodePath.join(contractsSrc, "orchestrationV2.ts"),
    ];
    const files = roots.flatMap((root) => {
      if (!NodeFS.existsSync(root)) return [];
      if (NodeFS.statSync(root).isFile()) return [root];
      return (NodeFS.readdirSync(root, { recursive: true }) as Array<string>)
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) => NodePath.join(root, file));
    });
    assert.ok(files.length > 50);
    const forbidden = [
      "EditorialCommandService",
      "EditorialInboxCommands",
      "EditorialRpcHandlers",
      ...EDITORIAL_WRITE_METHODS,
    ];
    const offenders = files.flatMap((file) => {
      const text = NodeFS.readFileSync(file, "utf8");
      return forbidden
        .filter((name) => text.includes(name))
        .map((name) => `${NodePath.relative(serverSrc, file)}: ${name}`);
    });
    assert.deepStrictEqual(offenders, []);
  });
});

describe("editorial.subscribe", () => {
  const take = (stream: Stream.Stream<EditorialStreamItem, EditorialReadError>, count: number) =>
    stream.pipe(
      Stream.take(count),
      Stream.runCollect,
      Effect.map((items) => [...items]),
    );

  it.effect("starts with a snapshot and its sequence, then sends the state of each change", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        yield* (yield* EditorialImportService).sync;
        const inbox = yield* EditorialInboxCommands;
        const stream = yield* subscribeInbox({});
        const collecting = yield* take(stream, 3).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* inbox.dismiss(SESSION, { trendKey: QUANTUM_KEY, reason: "Covered" });
        yield* inbox.snooze(SESSION, { trendKey: CHINA_KEY });
        const [snapshot, dismissed, snoozed] = yield* Fiber.join(collecting);

        assert.strictEqual(snapshot?._tag, "snapshot");
        assert.ok(snapshot?._tag === "snapshot");
        assert.strictEqual(snapshot.seq, 1);
        assert.strictEqual(snapshot.inbox.newCount, 3);
        assert.deepStrictEqual(dismissed, {
          _tag: "trend",
          seq: 2,
          trendKey: QUANTUM_KEY,
          state: {
            isNew: false,
            seenRunId: null,
            seenAt: null,
            snoozed: null,
            dismissed: { at: "1970-01-01T00:00:00.000Z", reason: "Covered" },
            production: null,
          },
          newCount: 2,
        });
        assert.ok(snoozed?._tag === "trend");
        assert.strictEqual(snoozed.seq, 3);
        assert.strictEqual(snoozed.newCount, 1);
        assert.notStrictEqual(snoozed.state.snoozed, null);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("replays what a reconnecting client missed, without a snapshot", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        yield* (yield* EditorialImportService).sync;
        const inbox = yield* EditorialInboxCommands;
        yield* inbox.dismiss(SESSION, { trendKey: QUANTUM_KEY, reason: "Covered" });
        // The client saw seq 2 and dropped; three changes happen while it is away.
        yield* inbox.snooze(SESSION, { trendKey: CHINA_KEY });
        yield* inbox.reopen(SESSION, { trendKey: QUANTUM_KEY });
        yield* inbox.snooze(SESSION, { trendKey: JUDGE_KEY });

        const stream = yield* subscribeInbox({ since: 2 });
        const collecting = yield* take(stream, 4).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* inbox.unsnooze(SESSION, { trendKey: JUDGE_KEY });
        const items = yield* Fiber.join(collecting);
        assert.deepStrictEqual(
          items.map((item) => [item._tag, item.seq, item._tag === "trend" ? item.trendKey : null]),
          [
            ["trend", 3, CHINA_KEY],
            ["trend", 4, QUANTUM_KEY],
            ["trend", 5, JUDGE_KEY],
            ["trend", 6, JUDGE_KEY],
          ],
        );
        const reopened = items[1];
        assert.ok(reopened?._tag === "trend");
        assert.strictEqual(reopened.state.dismissed, null);
        assert.strictEqual(reopened.state.isNew, true);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("sends a snapshot for each content change of a run, a revert to A included", () =>
    withEditorial(({ runDir }) =>
      Effect.gen(function* () {
        const importer = yield* EditorialImportService;
        const fs = yield* FileSystem.FileSystem;
        const file = `${runDir}/dossiers/13-dos_bbb80d57481e.json`;
        const original = yield* fs.readFileString(file);
        const labelIn = (item: EditorialStreamItem | undefined) =>
          item?._tag === "snapshot"
            ? item.inbox.trends.find((trend) => trend.trendKey === QUANTUM_KEY)?.label
            : undefined;

        // Subscribed before the first import: an empty snapshot, then one per run event. Each
        // snapshot carries the state when it is read, so take it before the next change.
        const queue = yield* Stream.toQueue(yield* subscribeInbox({}), { capacity: 8 });
        const items = [yield* Queue.take(queue)];
        yield* importer.sync;
        items.push(yield* Queue.take(queue));
        const edited = JSON.parse(original);
        edited.signal.label = "quantum B";
        yield* fs.writeFileString(file, JSON.stringify(edited));
        yield* fs.utimes(file, LATER, LATER);
        yield* importer.sync;
        items.push(yield* Queue.take(queue));
        yield* fs.writeFileString(file, original);
        yield* fs.utimes(file, LATER + 1, LATER + 1);
        yield* importer.sync;
        items.push(yield* Queue.take(queue));

        assert.deepStrictEqual(
          items.map((item) => [item._tag, item.seq]),
          [
            ["snapshot", 0],
            ["snapshot", 1],
            ["snapshot", 2],
            ["snapshot", 3],
          ],
        );
        const labelA = JSON.parse(original).signal.label;
        assert.deepStrictEqual(items.slice(1).map(labelIn), [labelA, "quantum B", labelA]);
        assert.deepStrictEqual(
          (yield* events).map((event) => event.type),
          ["run.imported", "run.updated", "run.updated"],
        );

        // A client that saw B (seq 2) and dropped gets the restored content, not a replay.
        const reconnected = yield* take(yield* subscribeInbox({ since: 2 }), 1);
        assert.deepStrictEqual(
          reconnected.map((item) => [item._tag, item.seq]),
          [["snapshot", 3]],
        );
        assert.strictEqual(labelIn(reconnected[0]), labelA);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("replaces the snapshot when the gap is too large, ahead of the log or has a run", () =>
    withEditorial(({ runDir }) =>
      Effect.gen(function* () {
        const importer = yield* EditorialImportService;
        yield* importer.sync;
        const inbox = yield* EditorialInboxCommands;

        // Ahead of the log: the database was reset under the client.
        const ahead = yield* take(yield* subscribeInbox({ since: 99 }), 1);
        assert.deepStrictEqual(
          ahead.map((item) => [item._tag, item.seq]),
          [["snapshot", 1]],
        );

        // A run import inside the gap changes every row: start over.
        const fs = yield* FileSystem.FileSystem;
        const file = `${runDir}/dossiers/13-dos_bbb80d57481e.json`;
        const edited = JSON.parse(yield* fs.readFileString(file));
        edited.signal.label = "quantum edited";
        yield* fs.writeFileString(file, JSON.stringify(edited));
        yield* fs.utimes(file, LATER, LATER);
        yield* importer.sync;
        const afterRun = yield* take(yield* subscribeInbox({ since: 1 }), 1);
        assert.deepStrictEqual(
          afterRun.map((item) => [item._tag, item.seq]),
          [["snapshot", 2]],
        );
        assert.ok(afterRun[0]?._tag === "snapshot");
        assert.strictEqual(
          afterRun[0].inbox.trends.find((trend) => trend.trendKey === QUANTUM_KEY)?.label,
          "quantum edited",
        );

        // More than SUBSCRIBE_MAX_REPLAY events since the client's sequence.
        for (let index = 0; index <= SUBSCRIBE_MAX_REPLAY; index++) {
          yield* inbox.snooze(SESSION, {
            trendKey: CHINA_KEY,
            until: `2099-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
          });
        }
        const latest = yield* (yield* EditorialEventLog).latestSeq;
        const tooFar = yield* take(yield* subscribeInbox({ since: 2 }), 1);
        assert.deepStrictEqual(
          tooFar.map((item) => [item._tag, item.seq]),
          [["snapshot", latest]],
        );
      }).pipe(Effect.scoped),
    ),
  );
});

describe("editorial layer", () => {
  it.effect("is built once: two sessions share the run directory cache", () => {
    const dossierReads: Array<string> = [];
    const countingFs = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return {
          ...fs,
          readFileString: (path: string, encoding?: string) => {
            if (path.includes(`${NodePath.sep}dossiers${NodePath.sep}`)) dossierReads.push(path);
            return fs.readFileString(path, encoding);
          },
        };
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    return withEditorial(
      () =>
        Effect.gen(function* () {
          const handlers = yield* EditorialRpcHandlers;
          const first = handlers.forSession({ sessionId: "session-a" });
          const second = handlers.forSession({ sessionId: "session-b" });
          const a = yield* first[EDITORIAL_WS_METHODS.getInbox]({});
          const b = yield* second[EDITORIAL_WS_METHODS.getInbox]({});
          assert.strictEqual(a.total, 3);
          assert.deepStrictEqual(a, b);
          // The importer and both sessions read each dossier file once.
          assert.strictEqual(dossierReads.length, 3);
        }),
      { fs: countingFs },
    );
  });

  it.effect("answers unavailable when the editorial layer is not mounted", () =>
    Effect.gen(function* () {
      const handlers = (yield* EditorialRpcHandlers).forSession(SESSION);
      const error = yield* handlers[EDITORIAL_WS_METHODS.getInbox]({}).pipe(Effect.flip);
      assert.ok(error._tag === "EditorialReadError");
      assert.strictEqual(error.reason, "unavailable");
      const write = yield* handlers[EDITORIAL_WS_METHODS.dismiss]({
        trendKey: QUANTUM_KEY,
        reason: "x",
      }).pipe(Effect.flip);
      assert.ok(write._tag === "EditorialCommandError");
      assert.strictEqual(write.reason, "unavailable");
    }),
  );
});
