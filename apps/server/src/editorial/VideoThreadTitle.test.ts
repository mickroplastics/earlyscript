import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";
import * as VideoThreadTitle from "./VideoThreadTitle.ts";
import { fallbackTitle, isFillerTitle, TitleWatch } from "./VideoThreadTitle.ts";

describe("isFillerTitle", () => {
  it("knows empty titles and filler words, in any case or wrapping", () => {
    for (const title of ["", "  ", "placeholder", "Placeholder.", '"placeholder"', "<title>"]) {
      assert.isTrue(isFillerTitle(title), title);
    }
    for (const title of ["Untitled", "New thread", "Sin título", "TBD"]) {
      assert.isTrue(isFillerTitle(title), title);
    }
    for (const title of ["Guion: calidad del código con IA", "Placeholder images in React"]) {
      assert.isFalse(isFillerTitle(title), title);
    }
  });
});

describe("TitleWatch", () => {
  const T = "thread-1";
  const seed = "Lee videos/x/expediente.md y propón un primer borrador…";

  it("accepts a generated title", () => {
    const watch = new TitleWatch();
    assert.isNull(watch.observe({ threadId: T, title: seed, regenerating: true }));
    assert.isNull(
      watch.observe({ threadId: T, title: "Guion sobre agentes", regenerating: false }),
    );
  });

  it("asks for one retry on a filler word or a failed generation, then keeps the fallback", () => {
    const watch = new TitleWatch();
    watch.observe({ threadId: T, title: seed, regenerating: true });
    assert.deepStrictEqual(
      watch.observe({ threadId: T, title: "placeholder", regenerating: false }),
      {
        retry: true,
      },
    );
    watch.retrying(T, "Guion: Qwen");
    // The retry's own start, with the fallback as its title.
    assert.isNull(watch.observe({ threadId: T, title: "Guion: Qwen", regenerating: true }));
    assert.deepStrictEqual(
      watch.observe({ threadId: T, title: "placeholder", regenerating: false }),
      {
        retry: false,
      },
    );

    // A generation that failed leaves the message seed as the title.
    const failed = new TitleWatch();
    failed.observe({ threadId: T, title: seed, regenerating: true });
    assert.deepStrictEqual(failed.observe({ threadId: T, title: seed, regenerating: false }), {
      retry: true,
    });
  });

  it("keeps a known title when a regeneration leaves it unchanged", () => {
    const watch = new TitleWatch();
    watch.known(T, "Video: Qwen");
    watch.observe({ threadId: T, title: "Video: Qwen", regenerating: true });
    assert.isNull(watch.observe({ threadId: T, title: "Video: Qwen", regenerating: false }));
    // And ignores updates that are not the end of a generation it saw start.
    assert.isNull(watch.observe({ threadId: T, title: "Otro", regenerating: false }));
  });
});

type T3Event = {
  readonly type: string;
  readonly threadId: string;
  readonly payload: { readonly title: string; readonly titleRegeneration: unknown };
};

describe("VideoThreadTitle.layer", () => {
  it.effect("titles an assisted thread after its trend and asks the model once more", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        // A queue keeps what is published before the follower's fiber starts reading.
        const events = yield* Queue.unbounded<T3Event>();
        const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
        const mocks = Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            streamDomainEvents: Stream.fromQueue(events) as never,
            dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
          }),
          Layer.mock(EditorialReadService)({
            getDossier: () =>
              Effect.succeed({
                trend: { label: "qwen", presentation: { title: "Qwen y un archivo a Pekín" } },
              } as never),
          }),
        );
        yield* EditorialThreadService.use((threads) =>
          threads.registerVideoThread({
            operationId: "op-assisted",
            environmentId: "env-1",
            threadId: "assisted",
            mode: "assisted",
            runId: "run-1",
            dossierId: "dos-1",
          }),
        );
        const publish = (title: string, regenerating: boolean) =>
          Queue.offer(events, {
            type: "thread.metadata-updated",
            threadId: "assisted",
            payload: { title, titleRegeneration: regenerating ? { requestId: "r" } : null },
          });
        const next = Queue.take(dispatched);

        yield* Effect.gen(function* () {
          yield* publish("Lee el expediente y propón un borrador", true);
          yield* publish("placeholder", false);
          const retry = yield* next;
          assert.deepInclude(retry, {
            type: "thread.metadata.update",
            title: fallbackTitle("Qwen y un archivo a Pekín"),
            regenerateTitle: true,
          });
          yield* publish("Guion: Qwen y un archivo a Pekín", true);
          yield* publish("placeholder", false);
          const kept = yield* next;
          assert.deepInclude(kept, { title: "Guion: Qwen y un archivo a Pekín" });
          assert.notProperty(kept, "regenerateTitle");
        }).pipe(
          Effect.provide(
            VideoThreadTitle.layer.pipe(Layer.provide(mocks), Layer.provide(NodeServices.layer)),
          ),
          Effect.scoped,
        );
      }),
    ),
  );
});
