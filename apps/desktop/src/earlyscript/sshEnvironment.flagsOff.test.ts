// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hook is wired.
// Earlyscript-only: the `remoteAccess` hook on desktop SSH environments. The setup file turns every
// flag on for upstream suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import * as UpstreamSsh from "../ipc/methods/sshEnvironment.ts";
import * as EarlyscriptSsh from "./sshEnvironment.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const SSH_METHODS = [
  "discoverSshHosts",
  "resolveSshHost",
  "ensureSshEnvironment",
  "disconnectSshEnvironment",
  "fetchSshEnvironmentDescriptor",
  "bootstrapSshBearerSession",
  "fetchSshSessionState",
  "resolveSshPasswordPrompt",
] as const;

describe("Desktop SSH environments with the remoteAccess flag at its default", () => {
  it.effect("answers every SSH channel with the Earlyscript error and never reaches SSH", () =>
    Effect.gen(function* () {
      for (const name of SSH_METHODS) {
        const method = EarlyscriptSsh[name];
        assert.notStrictEqual(method, UpstreamSsh[name]);
        assert.equal(method.channel, UpstreamSsh[name].channel);
        // With the flag off the handler needs no services and fails only with the Earlyscript error.
        // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
        const handled = method.handler(undefined) as Effect.Effect<
          never,
          EarlyscriptSsh.SshEnvironmentsDisabledError
        >;
        const error = yield* Effect.flip(handled);
        assert.instanceOf(error, EarlyscriptSsh.SshEnvironmentsDisabledError);
        assert.equal(
          error.message,
          "SSH environments are turned off in Earlyscript (remoteAccess flag).",
        );
      }
    }),
  );

  it("is what the desktop IPC handlers register", () => {
    const handlers = NodeFS.readFileSync(
      new URL("../ipc/DesktopIpcHandlers.ts", import.meta.url),
      "utf8",
    );
    assert.include(handlers, '} from "../earlyscript/sshEnvironment.ts";');
    assert.notInclude(handlers, '} from "./methods/sshEnvironment.ts";');
  });
});
