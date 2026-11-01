import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Upstream's `ThreadLaunchService` over a `ThreadManagementService` that skips only
 * `assertProviderInstanceEnabled`: a manual thread never runs its provider. Clone, project,
 * Scratch folder and workspace checks stay upstream's; `dispatch` keeps the real check.
 */
export class ManualThreadLauncher extends Context.Service<
  ManualThreadLauncher,
  { readonly launch: ThreadLaunch.ThreadLaunchService["Service"]["launch"] }
>()("t3/editorial/ManualThreadLauncher") {}

export const layer = Layer.effect(
  ManualThreadLauncher,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const withoutProviderCheck = ThreadManagement.ThreadManagementService.of({
      ...threads,
      assertProviderInstanceEnabled: Effect.fn(
        "ManualThreadLauncher.assertProviderInstanceEnabled",
      )(() => Effect.void),
    });
    // Fresh: the layer is memoized by reference, and the build would return upstream's own.
    const launcher = yield* Layer.build(
      Layer.fresh(ThreadLaunch.layer).pipe(
        // Upstream provides these two inside the orchestration runtime; both are stateless.
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ThreadManagement.ThreadManagementService, withoutProviderCheck),
            CommandReceiptStore.layerFromApplicationReceipts,
            IdAllocator.layer,
          ),
        ),
      ),
    ).pipe(Effect.map((context) => Context.get(context, ThreadLaunch.ThreadLaunchService)));
    return ManualThreadLauncher.of({ launch: launcher.launch });
  }),
);
