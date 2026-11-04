import { SCRIPT_TEMPLATE } from "@earlyscript/editorial-script";
import {
  scriptLanguageInstruction,
  EditorialDossierId,
  EditorialRunId,
  type EditorialGetDossierInput,
  type EditorialReadError,
  type EditorialTrendDossier,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { EditorialProfileService } from "./EditorialProfileService.ts";
import type { VideoThread } from "./persistence/EditorialModel.ts";
import { threadWorkspaceRoot } from "./threadWorkspace.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import {
  createVideoFileIfMissing,
  type MayWrite,
  readVideoFile,
  type VideoFileOutcome,
  type VideoFileRefusal,
  videoFileExists,
  writeReadOnlyVideoFile,
} from "./videoFolderFiles.ts";
import { dossierPathOf, isDossierFileOf, renderDossierMarkdown } from "./videoWorkspaceFormat.ts";

/** What preparing a thread's folder did, for the log and the tests. */
export interface VideoWorkspaceResult {
  /** Null when the thread has no workspace the server can find. */
  readonly workspaceRoot: string | null;
  readonly dossier: "written" | "unchanged" | "none";
  readonly script: "created" | "exists" | "none";
}

/** A file of a thread's workspace, or why it was not read. */
export type VideoFileRead = VideoFileOutcome<string> | { ok: false; reason: "no-workspace" };

type DossierLoader = (
  input: EditorialGetDossierInput,
) => Effect.Effect<EditorialTrendDossier, EditorialReadError>;

/**
 * A video thread's folder: the read-only dossier (`videos/<slug>/expediente.md`) and the
 * script from the template. No read or write follows a link below the workspace root
 * (`videoFolderFiles.ts`). Never fails; "Abrir guion" still creates the script.
 */
export class EditorialVideoWorkspace extends Context.Service<
  EditorialVideoWorkspace,
  {
    /**
     * `dossier` is the whole dossier the thread is attached to (`readWholeDossier`); null
     * writes no dossier file, as for a manual thread. The dossier file is rewritten only when
     * its content changes; the script is created only when it does not exist.
     */
    readonly prepare: (input: {
      readonly thread: VideoThread;
      readonly dossier: EditorialTrendDossier | null;
    }) => Effect.Effect<VideoWorkspaceResult>;
    /**
     * Prepares the folder of a thread opened again when its script is missing, or when it has
     * a dossier and its dossier file is missing or is not this thread's (`isDossierFileOf`).
     * Threads created before dossier files get theirs this way. Null when nothing was needed.
     */
    readonly prepareIfNeeded: (input: {
      readonly thread: VideoThread;
      readonly getDossier: DossierLoader | null;
    }) => Effect.Effect<VideoWorkspaceResult | null>;
    /** A workspace-relative text file of the thread, read without following links. */
    readonly readFile: (input: {
      readonly thread: VideoThread;
      readonly path: string;
    }) => Effect.Effect<VideoFileRead>;
  }
>()("t3/editorial/VideoWorkspace/EditorialVideoWorkspace") {}

/** More evidence than any dossier carries; the file says when it was cut. */
const MAX_DOSSIER_EVIDENCE = 200;
/** The read service's page limit (`EDITORIAL_EVIDENCE_PAGE_LIMIT`). */
const EVIDENCE_PAGE = 50;

/** A dossier with all its evidence, read page by page through the read service. */
export const readWholeDossier = Effect.fn("EditorialVideoWorkspace.readWholeDossier")(function* (
  getDossier: (
    input: EditorialGetDossierInput,
  ) => Effect.Effect<EditorialTrendDossier, EditorialReadError>,
  ids: { readonly runId: string; readonly dossierId: string },
) {
  const base = {
    runId: EditorialRunId.make(ids.runId),
    dossierId: EditorialDossierId.make(ids.dossierId),
  };
  const first = yield* getDossier({ ...base, evidenceLimit: EVIDENCE_PAGE });
  const evidence = [...first.evidence];
  const total = Math.min(first.evidenceTotal, MAX_DOSSIER_EVIDENCE);
  while (evidence.length < total) {
    const page = yield* getDossier({
      ...base,
      evidenceOffset: evidence.length,
      evidenceLimit: Math.min(EVIDENCE_PAGE, total - evidence.length),
    });
    if (page.evidence.length === 0) break;
    evidence.push(...page.evidence);
  }
  return { ...first, evidence, evidenceOffset: 0 } satisfies EditorialTrendDossier;
});

/** The whole dossier of an assisted thread, or null when it has none or the run is unreadable. */
export const loadThreadDossier = (getDossier: DossierLoader | null, thread: VideoThread) =>
  getDossier === null ||
  thread.mode !== "assisted" ||
  thread.runId === null ||
  thread.dossierId === null
    ? Effect.succeed(null)
    : readWholeDossier(getDossier, { runId: thread.runId, dossierId: thread.dossierId }).pipe(
        Effect.orElseSucceed(() => null),
      );

const scriptOutcome = (outcome: VideoFileOutcome<"created" | "exists">) =>
  outcome.ok ? outcome.value : "none";

const make = Effect.gen(function* () {
  const rootOf = threadWorkspaceRoot(
    yield* ThreadManagement.ThreadManagementService,
    yield* ProjectService.ProjectService,
  );
  const workspaceRootOf = (thread: VideoThread) =>
    rootOf(thread.threadId).pipe(Effect.orElseSucceed(() => null));
  // Absent in tests that mount no editorial storage; their threads are never decided.
  const sql = yield* Effect.serviceOption(EditorialSql);
  const profiles = yield* Effect.serviceOption(EditorialProfileService);
  const language = Option.isSome(profiles)
    ? profiles.value.get.pipe(
        Effect.map((profile) => profile.language),
        Effect.tapError((error) =>
          Effect.logWarning("Cannot read the channel language", { error }),
        ),
        Effect.orElseSucceed(() => null),
      )
    : Effect.succeed("en");
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  /**
   * Asked before every write of the folder: a decided thread is never written, even by a
   * preparation its caller stopped waiting for. One SELECT, so it sees a decision whole or not
   * at all; a failed read stops the write.
   */
  const undecided = (threadId: string): MayWrite =>
    Option.isNone(sql)
      ? async () => true
      : () =>
          runPromise(
            sql.value<{ readonly decided: number }>`
              SELECT EXISTS (
                SELECT 1 FROM editorial_decisions WHERE thread_id = ${threadId}
              ) AS decided
            `.pipe(
              Effect.map((rows) => rows[0]?.decided === 0),
              Effect.orElseSucceed(() => false),
            ),
          );

  const prepare: EditorialVideoWorkspace["Service"]["prepare"] = Effect.fn(
    "EditorialVideoWorkspace.prepare",
  )(function* ({ thread, dossier }) {
    const none: VideoWorkspaceResult = { workspaceRoot: null, dossier: "none", script: "none" };
    const scriptPath = thread.scriptPath;
    const root = yield* workspaceRootOf(thread);
    if (root === null || scriptPath === null) return none;
    const channelLanguage = yield* language;
    if (channelLanguage === null) return none;
    const dossierPath = dossierPathOf(thread);
    const contents =
      dossier === null || dossierPath === null
        ? null
        : renderDossierMarkdown({
            language: channelLanguage,
            dossier,
            dossierHash: thread.dossierHash,
            trendKey: thread.trendKey,
          });
    const mayWrite = undecided(thread.threadId);
    return yield* Effect.tryPromise(async (): Promise<VideoWorkspaceResult> => {
      const script = scriptOutcome(
        await createVideoFileIfMissing(root, scriptPath, SCRIPT_TEMPLATE, mayWrite),
      );
      let written: VideoWorkspaceResult["dossier"] = "none";
      if (contents !== null && dossierPath !== null) {
        const outcome = await writeReadOnlyVideoFile(root, dossierPath, contents, mayWrite);
        if (outcome.ok) written = outcome.value;
      }
      return { workspaceRoot: root, dossier: written, script };
    }).pipe(
      Effect.tap((result) =>
        Effect.logDebug("Video thread folder prepared", { threadId: thread.threadId, ...result }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Cannot prepare the video thread folder", {
          threadId: thread.threadId,
          error,
        }).pipe(Effect.as({ ...none, workspaceRoot: root })),
      ),
    );
  });

  const readFile: EditorialVideoWorkspace["Service"]["readFile"] = Effect.fn(
    "EditorialVideoWorkspace.readFile",
  )(function* ({ thread, path }) {
    const root = yield* workspaceRootOf(thread);
    if (root === null) return { ok: false, reason: "no-workspace" } as const;
    return yield* Effect.tryPromise(() => readVideoFile(root, path)).pipe(
      Effect.orElseSucceed(
        () => ({ ok: false, reason: "not-a-file" as VideoFileRefusal }) as const,
      ),
    );
  });

  /** Whether opening the thread should write its folder again. */
  const needsPreparation = Effect.fn("EditorialVideoWorkspace.needsPreparation")(function* (
    thread: VideoThread,
  ) {
    const root = yield* workspaceRootOf(thread);
    if (root === null || thread.scriptPath === null) return false;
    const scriptPath = thread.scriptPath;
    if (!(yield* Effect.promise(() => videoFileExists(root, scriptPath).catch(() => true)))) {
      return true;
    }
    const channelLanguage = yield* language;
    if (channelLanguage === null) return false;
    const dossierPath = dossierPathOf(thread);
    if (thread.mode !== "assisted" || dossierPath === null) return false;
    const dossier = yield* readFile({ thread, path: dossierPath });
    return (
      !dossier.ok ||
      !isDossierFileOf(dossier.value, thread) ||
      !dossier.value.includes(scriptLanguageInstruction(channelLanguage))
    );
  });

  const prepareIfNeeded: EditorialVideoWorkspace["Service"]["prepareIfNeeded"] = Effect.fn(
    "EditorialVideoWorkspace.prepareIfNeeded",
  )(function* ({ thread, getDossier }) {
    if (!(yield* needsPreparation(thread))) return null;
    return yield* prepare({ thread, dossier: yield* loadThreadDossier(getDossier, thread) });
  });

  return EditorialVideoWorkspace.of({ prepare, prepareIfNeeded, readFile });
});

export const layer = Layer.effect(EditorialVideoWorkspace, make);
