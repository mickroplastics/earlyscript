import {
  CommandId,
  EditorialDossierId,
  EditorialRunId,
  ThreadId,
  trendTitle,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId } from "./persistence/support.ts";

/**
 * Words a title model returns when it fills the field without a subject. Compared after
 * lowercasing and dropping quotes, brackets and end punctuation.
 */
const FILLER_TITLES = new Set([
  "placeholder",
  "title",
  "thread title",
  "untitled",
  "untitled thread",
  "new thread",
  "none",
  "null",
  "undefined",
  "n/a",
  "na",
  "todo",
  "tbd",
  "título",
  "sin título",
  "nuevo hilo",
]);

/** True when a title says nothing about the thread: empty or a filler word. */
export const isFillerTitle = (title: string): boolean => {
  const bare = title
    .trim()
    .toLowerCase()
    .replace(/^["'`«“‘<{[(]+|["'`»”’>}\])]+$/g, "")
    .replace(/[.!?…:;,]+$/, "")
    .trim();
  return bare.length === 0 || FILLER_TITLES.has(bare);
};

/** The title an assisted video thread falls back to, from its trend. */
export const fallbackTitle = (trendTitle: string): string => `Guion: ${trendTitle.trim()}`;

interface TitleWatchEntry {
  /** The title while the generation ran: the message seed, or the fallback on the retry. */
  readonly seed: string;
  /** Whether the seed is a title already accepted, so keeping it is not a failure. */
  readonly seedAccepted: boolean;
  readonly retried: boolean;
}

/**
 * The title generations of video threads, followed by T3's `thread.metadata-updated` events:
 * one with `titleRegeneration` set starts a generation, the next without it ends it. Kept in
 * memory; a generation in flight across a restart is not followed.
 */
export class TitleWatch {
  private readonly pending = new Map<string, TitleWatchEntry>();
  private readonly accepted = new Map<string, Set<string>>();

  private accept(threadId: string, title: string) {
    // Every T3 thread passes through here; a long-lived server forgets old ones.
    if (this.accepted.size > 2_000) this.accepted.clear();
    const titles = this.accepted.get(threadId) ?? new Set<string>();
    titles.add(title.trim());
    this.accepted.set(threadId, titles);
  }

  /** A title the thread was created with, or one Earlyscript set. */
  known(threadId: string, title: string): void {
    this.accept(threadId, title);
  }

  /** Marks the next generation of the thread as the one retry. */
  retrying(threadId: string, fallback: string): void {
    this.accept(threadId, fallback);
    this.pending.set(threadId, { seed: fallback, seedAccepted: true, retried: true });
  }

  /**
   * One state of a video thread's title. Returns what to do when a generation ended without a
   * usable title: `retry` once, then keep the fallback.
   */
  observe(input: {
    readonly threadId: string;
    readonly title: string;
    readonly regenerating: boolean;
  }): null | { readonly retry: boolean } {
    const { threadId } = input;
    const title = input.title.trim();
    const entry = this.pending.get(threadId);
    if (input.regenerating) {
      if (entry?.retried === true && entry.seed === title) return null;
      this.pending.set(threadId, {
        seed: title,
        seedAccepted: this.accepted.get(threadId)?.has(title) ?? false,
        retried: entry?.retried ?? false,
      });
      return null;
    }
    if (entry === undefined) return null;
    this.pending.delete(threadId);
    const failed = isFillerTitle(title) || (title === entry.seed && !entry.seedAccepted);
    if (!failed) {
      this.accept(threadId, title);
      return null;
    }
    return { retry: !entry.retried };
  }
}

/** The trend's title as Tendencias shows it, or null without a readable dossier. */
export const readTrendTitle = (
  reader: Option.Option<EditorialReadService["Service"]>,
  runId: string | null,
  dossierId: string | null,
) =>
  Option.isNone(reader) || runId === null || dossierId === null
    ? Effect.succeed(null)
    : reader.value
        .getDossier({
          runId: EditorialRunId.make(runId),
          dossierId: EditorialDossierId.make(dossierId),
          evidenceLimit: 1,
        })
        .pipe(
          Effect.map((dossier) => trendTitle(dossier.trend)),
          Effect.orElseSucceed(() => null),
        );

/**
 * An assisted video thread whose title generation failed, or answered a filler word such as
 * "placeholder", takes "Guion: <trend title>" and asks the model once more; a second failure
 * keeps that title. Ordinary T3 threads and manual ones (no agent) are left alone.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
    if (Option.isNone(threads)) return;
    const sql = yield* EditorialSql;
    const reader = yield* Effect.serviceOption(EditorialReadService);
    const newId = yield* makeNewId;
    const watch = new TitleWatch();

    const assistedThread = (threadId: string) =>
      sql<{ readonly run_id: string | null; readonly dossier_id: string | null }>`
        SELECT run_id, dossier_id FROM editorial_video_threads
        WHERE thread_id = ${threadId} AND mode = 'assisted'
      `.pipe(Effect.map((rows) => rows[0] ?? null));

    const repair = Effect.fn("VideoThreadTitle.repair")(function* (
      threadId: string,
      current: string,
      retry: boolean,
    ) {
      const thread = yield* assistedThread(threadId);
      if (thread === null) return;
      const trendTitle = yield* readTrendTitle(reader, thread.run_id, thread.dossier_id);
      const fallback = trendTitle === null ? null : fallbackTitle(trendTitle);
      if (fallback !== null) watch.known(threadId, fallback);
      if (retry) watch.retrying(threadId, fallback ?? current);
      if (!retry && (fallback === null || fallback === current.trim())) return;
      yield* threads.value.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`editorial:video-title:${yield* newId}`),
        threadId: ThreadId.make(threadId),
        ...(fallback === null ? {} : { title: fallback }),
        ...(retry ? { regenerateTitle: true } : {}),
      });
    });

    yield* threads.value.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type === "thread.created") {
          watch.known(event.threadId, event.payload.title);
          return Effect.void;
        }
        if (event.type !== "thread.metadata-updated") return Effect.void;
        const action = watch.observe({
          threadId: event.threadId,
          title: event.payload.title,
          regenerating: event.payload.titleRegeneration != null,
        });
        if (action === null) return Effect.void;
        return repair(event.threadId, event.payload.title, action.retry).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Editorial: a video thread kept a title without subject", error),
          ),
        );
      }),
      Effect.catch((error) => Effect.logWarning("Editorial: T3 titles not followed", error)),
      Effect.forkScoped,
    );
  }),
);
