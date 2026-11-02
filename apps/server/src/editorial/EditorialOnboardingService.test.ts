import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EDITORIAL_ONBOARDING_MAX_PAYLOAD_BYTES,
  EDITORIAL_ONBOARDING_WS_METHODS,
  EditorialOnboardingRpcGroup,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import type * as Scope from "effect/Scope";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as EditorialOnboardingService from "./EditorialOnboardingService.ts";
import * as EditorialOnboardingRpc from "./onboardingRpc.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";

const group = EditorialOnboardingRpcGroup.middleware(RpcScopeAuthorization);

const withOnboarding = <A, E>(
  body: Effect.Effect<A, E, EditorialOnboardingService.EditorialOnboardingService | Scope.Scope>,
) => {
  const handlers = Layer.effect(
    EditorialOnboardingRpc.EditorialOnboardingRpcHandlers,
    EditorialOnboardingRpc.makeHandlers,
  ).pipe(Layer.provideMerge(EditorialOnboardingService.layerWithVersion("9.9.9-test")));
  return withEditorialDatabase(
    body.pipe(Effect.provide(handlers.pipe(Layer.provide(NodeServices.layer)))),
  );
};

const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const handlers = yield* EditorialOnboardingRpc.EditorialOnboardingRpcHandlers;
    return yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(group.toLayer(handlers), RpcAuthorization.layer(scopes))),
    );
  });

const NEVER = [
  { step: "datos", lastAcceptedAt: null },
  { step: "proveedores", lastAcceptedAt: null },
  { step: "estudio", lastAcceptedAt: null },
  { step: "motor", lastAcceptedAt: null },
] as const;

const operator = clientWith([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
const reader = clientWith([AuthOrchestrationReadScope]);

describe("editorial onboarding RPC", () => {
  it("reads with orchestration:read and writes with orchestration:operate", () => {
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_ONBOARDING_WS_METHODS.list),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_ONBOARDING_WS_METHODS.status),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_ONBOARDING_WS_METHODS.record),
      AuthOrchestrationOperateScope,
    );
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_ONBOARDING_WS_METHODS.complete),
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("starts empty and never finished", () =>
    withOnboarding(
      Effect.gen(function* () {
        const client = yield* operator;
        const view = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.list]({});
        assert.deepStrictEqual(view, { acceptances: [] });
        const status = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.status]({});
        assert.deepStrictEqual(status, { steps: NEVER, completedAt: null });
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("stores each acceptance with its date, payload and version, oldest first", () =>
    withOnboarding(
      Effect.gen(function* () {
        const client = yield* operator;
        const first = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.record]({
          step: "datos",
          payload: { terms: "v1", sources: ["hn", "github"], retentionDays: 90 },
        });
        assert.strictEqual(first.step, "datos");
        assert.strictEqual(first.appVersion, "9.9.9-test");
        assert.isFalse(Number.isNaN(Date.parse(first.acceptedAt)));
        yield* client[EDITORIAL_ONBOARDING_WS_METHODS.record]({
          step: "proveedores",
          payload: { provider: "codex", capUsd: 30 },
        });
        // Going back and accepting again keeps both decisions.
        yield* client[EDITORIAL_ONBOARDING_WS_METHODS.record]({
          step: "datos",
          payload: { terms: "v2" },
        });
        const view = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.list]({});
        assert.deepStrictEqual(
          view.acceptances.map((acceptance) => [acceptance.step, acceptance.payload]),
          [
            ["datos", { terms: "v1", sources: ["hn", "github"], retentionDays: 90 }],
            ["proveedores", { provider: "codex", capUsd: 30 }],
            ["datos", { terms: "v2" }],
          ],
        );
        assert.strictEqual(view.acceptances[0]!.id, first.id);
        const status = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.status]({});
        assert.strictEqual(status.completedAt, null);
        assert.deepStrictEqual(
          status.steps.map((entry) => [entry.step, entry.lastAcceptedAt !== null]),
          [
            ["datos", true],
            ["proveedores", true],
            ["estudio", false],
            ["motor", false],
          ],
        );
        assert.strictEqual(status.steps[0]!.lastAcceptedAt, view.acceptances[2]!.acceptedAt);
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("marks the wizard finished and keeps the acceptances when it is reopened", () =>
    withOnboarding(
      Effect.gen(function* () {
        const client = yield* operator;
        yield* client[EDITORIAL_ONBOARDING_WS_METHODS.record]({ step: "motor", payload: {} });
        const done = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.complete]({});
        assert.isNotNull(done.completedAt);
        yield* client[EDITORIAL_ONBOARDING_WS_METHODS.record]({
          step: "datos",
          payload: { again: true },
        });
        const again = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.complete]({});
        assert.isTrue(again.completedAt! >= done.completedAt!);
        const view = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.list]({});
        assert.deepStrictEqual(
          view.acceptances.map((acceptance) => acceptance.step),
          ["motor", "datos"],
        );
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("refuses an oversized acceptance without storing it", () =>
    withOnboarding(
      Effect.gen(function* () {
        const client = yield* operator;
        const error = yield* Effect.flip(
          client[EDITORIAL_ONBOARDING_WS_METHODS.record]({
            step: "estudio",
            payload: { text: "x".repeat(EDITORIAL_ONBOARDING_MAX_PAYLOAD_BYTES) },
          }),
        );
        assert.strictEqual(error._tag, "EditorialOnboardingError");
        assert.strictEqual("reason" in error ? error.reason : null, "invalid-payload");
        const view = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.list]({});
        assert.strictEqual(view.acceptances.length, 0);
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("refuses writes from a read-only session", () =>
    withOnboarding(
      Effect.gen(function* () {
        const client = yield* reader;
        const recordError = yield* Effect.flip(
          client[EDITORIAL_ONBOARDING_WS_METHODS.record]({ step: "datos", payload: {} }),
        );
        assert.strictEqual(recordError._tag, "EnvironmentAuthorizationError");
        const completeError = yield* Effect.flip(
          client[EDITORIAL_ONBOARDING_WS_METHODS.complete]({}),
        );
        assert.strictEqual(completeError._tag, "EnvironmentAuthorizationError");
        const view = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.list]({});
        assert.deepStrictEqual(view, { acceptances: [] });
        const status = yield* client[EDITORIAL_ONBOARDING_WS_METHODS.status]({});
        assert.strictEqual(status.completedAt, null);
      }),
    ).pipe(Effect.scoped),
  );
});
