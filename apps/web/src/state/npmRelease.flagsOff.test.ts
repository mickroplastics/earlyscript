// Earlyscript-only: the `updateChecks` hook. The setup file turns every flag on for upstream
// suites, so this file replaces the flags with their real defaults.
import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

import { npmReleaseAtom, npmReleaseChecksDisabled } from "./npmRelease";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ version: "1.0.0" }));
vi.stubGlobal("fetch", fetchMock);

describe("npmReleaseAtom with the updateChecks flag at its default", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("never asks npm and reports the check as disabled, not the release as missing", async () => {
    const atom = npmReleaseAtom("1.0.0");
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);
    try {
      await vi.waitFor(() => {
        const result = registry.get(atom);
        expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
      });
      expect(AsyncResult.getOrElse(registry.get(atom), () => undefined)).toBeNull();
    } finally {
      unmount();
      registry.dispose();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(npmReleaseChecksDisabled).toBe(true);
  });
});
