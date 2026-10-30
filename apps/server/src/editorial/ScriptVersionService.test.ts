// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { ScriptVersionService } from "./ScriptVersionService.ts";
import { SCRIPT, SCRIPT_PATH, VIDEO_THREAD_ID, withVideoWorkspace } from "./videoThread.testkit.ts";

const sha256 = (content: string) => NodeCrypto.createHash("sha256").update(content).digest("hex");

const readFailure = (path: string) =>
  ScriptVersionService.use((scripts) =>
    Effect.flip(scripts.readScript({ threadId: VIDEO_THREAD_ID, path })),
  ).pipe(Effect.map((error) => (error._tag === "ScriptFileError" ? error.reason : error._tag)));

describe("ScriptVersionService", () => {
  it.effect("reads the registered script path and snapshots it by content hash", () =>
    withVideoWorkspace(({ workspace, write }) =>
      Effect.gen(function* () {
        const scripts = yield* ScriptVersionService;
        yield* write(SCRIPT_PATH, SCRIPT);

        const file = yield* scripts.readScript({ threadId: VIDEO_THREAD_ID });
        assert.strictEqual(file.relativePath, SCRIPT_PATH);
        assert.strictEqual(file.workspaceRoot, workspace);
        assert.strictEqual(file.contents, SCRIPT);

        const version = yield* scripts.snapshot(VIDEO_THREAD_ID);
        assert.strictEqual(version.contentHash, sha256(SCRIPT));
        assert.strictEqual(version.scriptPath, SCRIPT_PATH);
        // Unchanged on disk: the same version, no second event.
        const again = yield* scripts.snapshot(VIDEO_THREAD_ID);
        assert.strictEqual(again.versionId, version.versionId);
        const log = yield* EditorialEventLog;
        assert.deepStrictEqual(
          (yield* log.readSince(0)).map((event) => event.type),
          ["video-thread.registered", "script.version-saved"],
        );
      }),
    ),
  );

  it.effect("refuses absolute paths, parent segments and symlinks out of the workspace", () =>
    withVideoWorkspace(({ workspace, outside, write }) =>
      Effect.gen(function* () {
        yield* write(SCRIPT_PATH, SCRIPT);
        NodeFS.writeFileSync(NodePath.join(outside, "secret.md"), "outside");
        NodeFS.symlinkSync(
          NodePath.join(outside, "secret.md"),
          NodePath.join(workspace, "videos", "link.md"),
        );
        NodeFS.symlinkSync(outside, NodePath.join(workspace, "linked-dir"));

        assert.strictEqual(
          yield* readFailure(NodePath.join(workspace, SCRIPT_PATH)),
          "outside-workspace",
        );
        assert.strictEqual(yield* readFailure("/etc/hostname"), "outside-workspace");
        assert.strictEqual(yield* readFailure("~/notes.md"), "outside-workspace");
        assert.strictEqual(yield* readFailure("../outside/secret.md"), "outside-workspace");
        assert.strictEqual(
          yield* readFailure("videos/../../outside/secret.md"),
          "outside-workspace",
        );
        assert.strictEqual(yield* readFailure("videos/link.md"), "outside-workspace");
        assert.strictEqual(yield* readFailure("linked-dir/secret.md"), "outside-workspace");
        assert.strictEqual(yield* readFailure("videos"), "not-a-file");
        assert.strictEqual(yield* readFailure("videos/missing.md"), "not-found");
      }),
    ),
  );

  it.effect("follows a symlink that stays inside the workspace", () =>
    withVideoWorkspace(({ workspace, write }) =>
      Effect.gen(function* () {
        yield* write(SCRIPT_PATH, SCRIPT);
        NodeFS.symlinkSync(
          NodePath.join(workspace, SCRIPT_PATH),
          NodePath.join(workspace, "current.md"),
        );
        const file = yield* ScriptVersionService.use((scripts) =>
          scripts.readScript({ threadId: VIDEO_THREAD_ID, path: "current.md" }),
        );
        assert.strictEqual(file.contents, SCRIPT);
      }),
    ),
  );

  it.effect("only reads files of registered video threads", () =>
    withVideoWorkspace(() =>
      Effect.gen(function* () {
        const error = yield* ScriptVersionService.use((scripts) =>
          Effect.flip(scripts.readScript({ threadId: "thread-upstream", path: SCRIPT_PATH })),
        );
        assert.strictEqual(error._tag, "EditorialNotFoundError");
      }),
    ),
  );

  it.effect("decides on the script as it is on disk and refuses an outdated hash", () =>
    withVideoWorkspace(({ write }) =>
      Effect.gen(function* () {
        const scripts = yield* ScriptVersionService;
        const commands = yield* EditorialCommandService;
        yield* write(SCRIPT_PATH, SCRIPT);
        const shown = yield* scripts.snapshot(VIDEO_THREAD_ID);

        // The script changes after the client showed it.
        const edited = `${SCRIPT}\nOne more line.\n`;
        yield* write(SCRIPT_PATH, edited);
        const conflict = yield* Effect.flip(
          scripts.decide({
            threadId: VIDEO_THREAD_ID,
            action: "accept",
            utility: 4,
            scriptVersionHash: shown.contentHash,
          }),
        );
        assert.strictEqual(conflict._tag, "EditorialConflictError");

        const decision = yield* scripts.decide({
          threadId: VIDEO_THREAD_ID,
          action: "accept",
          utility: 4,
          scriptVersionHash: sha256(edited),
          operationId: "op-decide",
        });
        assert.strictEqual(decision.scriptVersionHash, sha256(edited));

        // Restoring the earlier text makes that snapshot the head again.
        yield* write(SCRIPT_PATH, SCRIPT);
        const restored = yield* scripts.snapshot(VIDEO_THREAD_ID);
        assert.strictEqual(restored.versionId, shown.versionId);
        const stale = yield* Effect.flip(
          commands.recordDecision({
            threadId: VIDEO_THREAD_ID,
            action: "edit",
            utility: 3,
            reason: "tighter hook",
            scriptVersionHash: sha256(edited),
          }),
        );
        assert.strictEqual(stale._tag, "EditorialConflictError");
      }),
    ),
  );

  it.effect("decides without a version when the thread never wrote its script", () =>
    withVideoWorkspace(() =>
      Effect.gen(function* () {
        const decision = yield* ScriptVersionService.use((scripts) =>
          scripts.decide({
            threadId: VIDEO_THREAD_ID,
            action: "reject",
            utility: 1,
            reason: "no angle",
          }),
        );
        assert.isNull(decision.scriptVersionHash);
      }),
    ),
  );
});
