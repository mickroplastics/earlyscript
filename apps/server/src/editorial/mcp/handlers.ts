import { checkScript } from "@earlyscript/editorial-script";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { unavailable } from "../../mcp/threadAccess.ts";
import { DossierEvidence } from "../DossierEvidence.ts";
import { EditorialThreadService } from "../EditorialThreadService.ts";
import type { VideoThread } from "../persistence/EditorialModel.ts";
import { ScriptVersionService } from "../ScriptVersionService.ts";
import { dossierEvidenceOf, dossierPathOf, videoFolderOf } from "../videoWorkspaceFormat.ts";
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

/** The thread's dossier file as the server wrote it; none when it is missing or unreadable. */
const readDossierFile = Effect.fn("EditorialMcp.readDossierFile")(function* (thread: VideoThread) {
  const path = dossierPathOf(thread);
  if (path === null) return Option.none<string>();
  const scripts = yield* ScriptVersionService;
  return yield* scripts.readScript({ threadId: thread.threadId, path }).pipe(
    Effect.map((file) => Option.some(file.contents)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});

const TITLE = /^# (.+)$/m;

export const layer = McpToolAccess.toLayer(EditorialToolkit, {
  dossier_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const thread = yield* callerVideoThread("dossier_read");
      const dossierPath = dossierPathOf(thread);
      const contents = yield* readDossierFile(thread);
      const dossier = Option.getOrNull(contents);
      return {
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
              : `El expediente todavía no está en ${dossierPath}. Pide al operador que vuelva a pulsar «Crear hilo de video» en la tendencia; eso lo escribe sin crear otro hilo.`,
      } satisfies DossierReadResult;
    }),
  ),
  script_check: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const thread = yield* callerVideoThread("script_check");
      const threadId = thread.threadId;
      const scripts = yield* ScriptVersionService;
      const evidence = yield* DossierEvidence;

      if (input.dossierId !== undefined && input.dossierId !== thread.dossierId) {
        return yield* invalid(
          thread.dossierId === null
            ? "This video thread has no dossier attached."
            : `This video thread's dossier is ${thread.dossierId}.`,
        );
      }
      const file = yield* scripts
        .readScript({ threadId, path: input.path })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ScriptFileError" ? invalid(error.message) : unavailable(),
          ),
        );
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
            Option.fromNullishOr(dossierEvidenceOf(markdown, dossierId)),
          );
        }
      }
      const report = yield* Effect.try({
        try: () =>
          checkScript(file.contents, Option.isSome(dossier) ? { dossier: dossier.value } : {}),
        // checkScript throws only on a malformed dossier.
        catch: () => invalid("The thread's dossier evidence could not be read."),
      });
      return {
        path: file.relativePath,
        ok: report.ok,
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
      } satisfies ScriptCheckResult;
    }),
  ),
});
