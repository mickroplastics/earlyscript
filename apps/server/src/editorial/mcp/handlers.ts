import { checkScript } from "@earlyscript/editorial-script";
import { scriptLanguageInstruction, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { unavailable } from "../../mcp/threadAccess.ts";
import { EditorialProfileService } from "../EditorialProfileService.ts";
import { DossierEvidence } from "../DossierEvidence.ts";
import { EditorialThreadService } from "../EditorialThreadService.ts";
import type { VideoThread } from "../persistence/EditorialModel.ts";
import { videoPathComponents } from "../videoFolderFiles.ts";
import { EditorialVideoWorkspace } from "../VideoWorkspace.ts";
import {
  dossierEvidenceOf,
  dossierPathOf,
  isDossierFileOf,
  videoFolderOf,
} from "../videoWorkspaceFormat.ts";
import { type DossierReadResult, EditorialToolkit, type ScriptCheckResult } from "./tools.ts";

const MAX_DIAGNOSTICS = 200;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The video thread of the calling agent's thread; other threads are refused. */
const callerVideoThread = Effect.fn("EditorialMcp.callerVideoThread")(function* (tool: string) {
  const scope = yield* McpInvocationContext.requireThreadScope(
    yield* McpInvocationContext.McpInvocationContext,
    tool,
  );
  const threads = yield* EditorialThreadService;
  return yield* threads.getVideoThread(scope.thread.threadId).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(invalid(`${tool} works in video threads only.`)),
        onSome: Effect.succeed,
      }),
    ),
  );
});

/**
 * The thread's own dossier file: read without following links, and only when its frontmatter
 * names the thread's dossier and hash. A link to another thread's file, an edited copy or any
 * other file is none.
 */
const readDossierFile = Effect.fn("EditorialMcp.readDossierFile")(function* (thread: VideoThread) {
  const path = dossierPathOf(thread);
  if (path === null) return Option.none<string>();
  const workspace = yield* EditorialVideoWorkspace;
  const file = yield* workspace.readFile({ thread, path });
  return file.ok && isDossierFileOf(file.value, thread)
    ? Option.some(file.value)
    : Option.none<string>();
});

const UNCOMPARED_WARNING = "the dossier of this thread is unavailable; citations were not checked";

const OUTSIDE_FOLDER = "script_check only reads files inside this thread's folder.";

/**
 * The normalized path when it is the thread's registered script or a file inside its video
 * folder (`videos/<folder>/`); null otherwise. `..` is refused by the component check.
 */
const threadFolderPath = (thread: VideoThread, path: string): string | null => {
  const parts = videoPathComponents(path);
  if (parts === null || thread.scriptPath === null) return null;
  const relative = parts.join("/");
  const script = videoPathComponents(thread.scriptPath)?.join("/");
  if (relative === script) return relative;
  return relative.startsWith(`${videoFolderOf(thread.scriptPath)}/`) ? relative : null;
};

const TITLE = /^# (.+)$/m;

export const layer = McpToolAccess.toLayer(EditorialToolkit, {
  dossier_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const thread = yield* callerVideoThread("dossier_read");
      const profiles = yield* Effect.serviceOption(EditorialProfileService);
      const language = Option.isSome(profiles)
        ? (yield* profiles.value.get.pipe(Effect.mapError(unavailable))).language
        : "en";
      const dossierPath = dossierPathOf(thread);
      const contents = yield* readDossierFile(thread);
      const dossier = Option.getOrNull(contents);
      return {
        scriptLanguage: scriptLanguageInstruction(language),
        mode: thread.mode,
        trendTitle: dossier === null ? null : (TITLE.exec(dossier)?.[1]?.trim() ?? null),
        folder: thread.scriptPath === null ? null : videoFolderOf(thread.scriptPath),
        scriptPath: thread.scriptPath,
        dossierPath,
        dossierId: thread.dossierId,
        dossier,
        note:
          dossier !== null
            ? null
            : dossierPath === null
              ? "Este hilo no tiene expediente adjunto: no hay evidencia del motor para citar."
              : "El expediente de este hilo no está disponible. Pide al operador que vuelva a abrir el hilo: al abrirlo, Earlyscript lo escribe de nuevo desde la tendencia.",
      } satisfies DossierReadResult;
    }),
  ),
  script_check: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const thread = yield* callerVideoThread("script_check");
      const workspace = yield* EditorialVideoWorkspace;
      const evidence = yield* DossierEvidence;

      if (input.dossierId !== undefined && input.dossierId !== thread.dossierId) {
        return yield* invalid(
          thread.dossierId === null
            ? "This video thread has no dossier attached."
            : `This video thread's dossier is ${thread.dossierId}.`,
        );
      }
      const path = threadFolderPath(thread, input.path);
      if (path === null) return yield* invalid(OUTSIDE_FOLDER);
      const file = yield* workspace.readFile({ thread, path });
      if (!file.ok) {
        switch (file.reason) {
          case "not-found":
            return yield* invalid(`Script file ${path} does not exist in this thread's folder.`);
          case "too-large":
            return yield* invalid(`Script file ${path} is too large to check.`);
          case "no-workspace":
            return yield* invalid("This video thread has no workspace to read the script from.");
          case "stopped":
            return yield* invalid(`Script file ${path} could not be read.`);
          case "not-a-file":
            return yield* invalid(`Script path ${path} is not a file.`);
          case "outside":
          case "link":
            return yield* invalid(OUTSIDE_FOLDER);
        }
      }
      const dossierId = thread.dossierId;
      // The run's dossier when the read side provides it, else the evidence ids of the dossier
      // file the server wrote into the workspace for this same dossier.
      let dossier: Option.Option<unknown> = Option.none();
      if (dossierId !== null) {
        dossier = yield* evidence.load({
          runId: thread.runId,
          dossierId,
          dossierHash: thread.dossierHash,
        });
        if (Option.isNone(dossier)) {
          dossier = Option.flatMap(yield* readDossierFile(thread), (markdown) =>
            Option.fromNullishOr(dossierEvidenceOf(markdown, thread)),
          );
        }
      }
      const report = yield* Effect.try({
        try: () =>
          checkScript(file.value, Option.isSome(dossier) ? { dossier: dossier.value } : {}),
        // checkScript throws only on a malformed dossier.
        catch: () => invalid("The thread's dossier evidence could not be read."),
      });
      const uncompared = thread.dossierId !== null && Option.isNone(dossier);
      return {
        path,
        ok: report.ok && !uncompared,
        counts: report.counts,
        diagnostics: report.diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          line: diagnostic.line,
          column: diagnostic.column,
        })),
        unknownCitations: report.unknownCitations
          .slice(0, MAX_DIAGNOSTICS)
          .map(({ id, line, column }) => ({ id, line, column })),
        truncated:
          report.diagnostics.length > MAX_DIAGNOSTICS ||
          report.unknownCitations.length > MAX_DIAGNOSTICS,
        dossier:
          thread.dossierId === null
            ? null
            : { dossierId: thread.dossierId, compared: Option.isSome(dossier) },
        warning: uncompared ? UNCOMPARED_WARNING : null,
      } satisfies ScriptCheckResult;
    }),
  ),
});
