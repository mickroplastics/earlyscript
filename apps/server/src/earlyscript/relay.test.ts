// Earlyscript-only: the `relay` hook on the server's relay URL. The setup file turns every flag on
// for upstream suites, so this file replaces the flags with their real defaults.
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { makeRelayUrlConfig, relayUrlConfig } from "../cloud/publicConfig.ts";
import { RELAY_DISABLED_MESSAGE } from "./relay.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

describe("Earlyscript relay with the relay flag at its default", () => {
  it.effect("never resolves a relay URL, so the server cannot link to the relay", () =>
    Effect.gen(function* () {
      const env = { T3CODE_RELAY_URL: "https://relay.example.test" };
      // Upstream's config still reads the variable; the hooked one the server uses does not.
      expect(yield* makeRelayUrlConfig().pipe(provideEnv(env))).toBe("https://relay.example.test");
      const error = yield* relayUrlConfig.pipe(provideEnv(env), Effect.flip);
      expect(error.message).toContain(RELAY_DISABLED_MESSAGE);
    }),
  );
});
