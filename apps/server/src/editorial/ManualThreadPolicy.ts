import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import type { VideoThreadMode } from "./persistence/EditorialModel.ts";

/** A thread whose mode is not known yet is asked again after this long. */
const UNREGISTERED_TTL_MS = 2_000;
const MAX_UNREGISTERED_ENTRIES = 2_000;

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
 * Manual video thread guard for the orchestrator and the provider turn start
 * (docs/upstream-divergence.md §10). The default allows everything, so layers
 * without the editorial database keep upstream behavior.
 */
export class ManualThreadPolicy extends Context.Reference<ManualThreadPolicyShape>(
  "t3/editorial/ManualThreadPolicy",
  { defaultValue: () => ({ assertAgentAllowed: () => Effect.void }) },
) {}

/** Planned orchestration work that starts or continues a provider turn. */
const AGENT_EFFECT_TYPES: ReadonlySet<string> = new Set([
  "provider-turn.start",
  "provider-turn.steer",
  "provider-turn.restart",
  "provider-runtime.continue",
]);

interface PlannedWork {
  readonly events: ReadonlyArray<{ readonly type: string; readonly threadId: string }>;
  readonly effects: ReadonlyArray<{
    readonly threadId: string;
    readonly request: { readonly type: string };
  }>;
}

/**
 * Threads in a command plan that would get agent work: a new run (started,
 * queued or deferred) or a provider turn effect. Checking the plan instead of
 * the command type covers every command that can lead to a run, including
 * ones added upstream later.
 */
export const threadsWithAgentWork = (plan: PlannedWork): ReadonlyArray<string> => [
  ...new Set([
    ...plan.events.filter((event) => event.type === "run.created").map((event) => event.threadId),
    ...plan.effects
      .filter((effect) => AGENT_EFFECT_TYPES.has(effect.request.type))
      .map((effect) => effect.threadId),
  ]),
];

/** Refuses the plan when any of its agent work lands on a manual thread. */
export const assertPlanAllowed = (policy: ManualThreadPolicyShape, plan: PlannedWork) =>
  Effect.forEach(threadsWithAgentWork(plan), policy.assertAgentAllowed, { discard: true });

type CachedMode =
  | { readonly kind: "registered"; readonly mode: VideoThreadMode }
  | { readonly kind: "unregistered"; readonly expiresAt: number };

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  // The mode of a registered thread never changes, so it stays cached. A
  // thread that is not registered is asked again shortly: createVideo
  // registers before it launches, so no dispatch precedes the registration.
  const cache = new Map<string, CachedMode>();

  const readMode = Effect.fn("ManualThreadPolicy.readMode")(function* (threadId: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(threadId);
    if (cached?.kind === "registered") return cached.mode;
    if (cached !== undefined && cached.expiresAt > now) return undefined;
    const rows = yield* sql<{ readonly mode: VideoThreadMode }>`
      SELECT mode FROM editorial_video_threads WHERE thread_id = ${threadId}
    `;
    const mode = rows[0]?.mode;
    if (mode === undefined && cache.size >= MAX_UNREGISTERED_ENTRIES) {
      for (const [key, entry] of cache) {
        if (entry.kind === "unregistered" && entry.expiresAt <= now) cache.delete(key);
      }
    }
    cache.set(
      threadId,
      mode === undefined
        ? { kind: "unregistered", expiresAt: now + UNREGISTERED_TTL_MS }
        : { kind: "registered", mode },
    );
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
