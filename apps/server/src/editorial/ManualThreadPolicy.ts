import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { OrchestrationEffectRequestV2 } from "../orchestration-v2/EffectOutbox.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import type { VideoThreadMode } from "./persistence/EditorialModel.ts";

export class ManualThreadAgentBlockedError extends Schema.TaggedError<ManualThreadAgentBlockedError>()(
  "ManualThreadAgentBlockedError",
  {
    threadId: Schema.String,
    reason: Schema.Literals(["manual-thread", "policy-unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "manual-thread"
      ? `Thread ${this.threadId} is a manual video thread: no agent runs in it.`
      : `Thread ${this.threadId} was not checked against the editorial database, so no agent starts in it.`;
  }
}

export interface ManualThreadPolicyShape {
  /** Fails when `threadId` is a manual video thread, or when its mode cannot be read. */
  readonly assertAgentAllowed: (
    threadId: string,
  ) => Effect.Effect<void, ManualThreadAgentBlockedError>;
}

/**
 * Manual video thread guard for the orchestrator, the effect worker and the
 * provider turn start (docs/upstream-divergence.md §10). Required, so a layer
 * that forgets it fails to build instead of letting agents through; tests
 * without the editorial database provide `allowAll`.
 */
export class ManualThreadPolicy extends Context.Service<
  ManualThreadPolicy,
  ManualThreadPolicyShape
>()("t3/editorial/ManualThreadPolicy") {}

/** Upstream behavior, for tests that build the orchestration layers without the editorial database. */
export const allowAll = Layer.succeed(
  ManualThreadPolicy,
  ManualThreadPolicy.of({
    assertAgentAllowed: Effect.fn("ManualThreadPolicy.allowAll")(function* () {}),
  }),
);

type EffectType = OrchestrationEffectRequestV2["type"];

/**
 * Every orchestration effect, by whether it starts, continues or unblocks
 * provider work ("agent") or only stops, cleans up or snapshots ("safe").
 * A new upstream effect type fails the typecheck until it is classified here.
 */
export const EFFECT_WORK = {
  // Continues a run restarted by the provider.
  "provider-runtime.continue": "agent",
  // Tears a session down; it never makes the provider produce output.
  "provider-session.detach": "safe",
  "provider-turn.start": "agent",
  // Stops a turn.
  "provider-turn.interrupt": "safe",
  // Sends a message into a running turn.
  "provider-turn.steer": "agent",
  // Starts a replacement turn.
  "provider-turn.restart": "agent",
  // An approval or an answer lets a waiting provider turn go on.
  "runtime-request.respond": "agent",
  // Rewinds the provider thread and, at most, restores files to a checkpoint; no model call.
  "provider-thread.rollback": "safe",
  // Snapshots the workspace with the VCS; no model call.
  "checkpoint.capture": "safe",
  // Release resources the thread holds.
  "scheduled-tasks.cleanup": "safe",
  "terminal.cleanup": "safe",
  "preview.cleanup": "safe",
  "attachment.cleanup": "safe",
  // Sends the thread's messages to a text generation model.
  "thread-title.generate": "agent",
  // Stops delegated tasks.
  "delegated-tasks.stop": "safe",
} as const satisfies Record<EffectType, "agent" | "safe">;

const isAgentEffect = (type: EffectType) => EFFECT_WORK[type] === "agent";

interface PlannedWork {
  readonly events: ReadonlyArray<{ readonly type: string; readonly threadId: string }>;
  readonly effects: ReadonlyArray<{
    readonly threadId: string;
    readonly request: { readonly type: EffectType };
  }>;
}

/**
 * Threads in a command plan that would get agent work: a new run (started,
 * queued or deferred) or an agent effect. Checking the plan instead of the
 * command type covers every command that can lead to a run, including ones
 * added upstream later.
 */
export const threadsWithAgentWork = (plan: PlannedWork): ReadonlyArray<string> => [
  ...new Set([
    ...plan.events.filter((event) => event.type === "run.created").map((event) => event.threadId),
    ...plan.effects
      .filter((effect) => isAgentEffect(effect.request.type))
      .map((effect) => effect.threadId),
  ]),
];

/** Refuses the plan when any of its agent work lands on a manual thread. */
export const assertPlanAllowed = (policy: ManualThreadPolicyShape, plan: PlannedWork) =>
  Effect.forEach(threadsWithAgentWork(plan), policy.assertAgentAllowed, { discard: true });

/**
 * Checks an outbox effect right before it runs, which covers effects enqueued
 * before the thread was registered and replay-safe effects requeued after a
 * restart. `provider-turn.start` is left to the provider turn start, which
 * settles the run visibly.
 */
export const assertEffectAllowed = (
  policy: ManualThreadPolicyShape,
  effect: { readonly threadId: string; readonly request: { readonly type: EffectType } },
) =>
  effect.request.type !== "provider-turn.start" && isAgentEffect(effect.request.type)
    ? policy.assertAgentAllowed(effect.threadId)
    : Effect.void;

const isBlockedError = Schema.is(ManualThreadAgentBlockedError);

/** A refusal because the thread is manual; it never changes, so retrying is pointless. */
export const isManualThreadRefusal = (error: unknown): boolean =>
  isBlockedError(error) && error.reason === "manual-thread";

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  // The mode of a registered thread never changes, so it stays cached. An
  // unregistered thread is asked every time: caching "not registered" let an
  // agent in right after registerVideoThread or createVideo committed.
  const registered = new Map<string, VideoThreadMode>();

  const readMode = Effect.fn("ManualThreadPolicy.readMode")(function* (threadId: string) {
    const cached = registered.get(threadId);
    if (cached !== undefined) return cached;
    const rows = yield* sql<{ readonly mode: VideoThreadMode }>`
      SELECT mode FROM editorial_video_threads WHERE thread_id = ${threadId}
    `;
    const mode = rows[0]?.mode;
    if (mode !== undefined) registered.set(threadId, mode);
    return mode;
  });

  const assertAgentAllowed: ManualThreadPolicyShape["assertAgentAllowed"] = (threadId) =>
    readMode(threadId).pipe(
      // Fail closed: an unreadable database must not let an agent into a manual thread.
      Effect.mapError(
        (cause) =>
          new ManualThreadAgentBlockedError({ threadId, reason: "policy-unavailable", cause }),
      ),
      Effect.flatMap((mode) =>
        mode === "manual"
          ? Effect.fail(new ManualThreadAgentBlockedError({ threadId, reason: "manual-thread" }))
          : Effect.void,
      ),
    );

  return ManualThreadPolicy.of({ assertAgentAllowed });
});

export const layer = Layer.effect(ManualThreadPolicy, make);
