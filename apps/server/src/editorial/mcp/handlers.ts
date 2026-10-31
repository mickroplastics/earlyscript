import { checkScript } from "@earlyscript/editorial-script";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { unavailable } from "../../mcp/threadAccess.ts";
import { DossierEvidence } from "../DossierEvidence.ts";
import { EditorialThreadService } from "../EditorialThreadService.ts";
import { ScriptVersionService } from "../ScriptVersionService.ts";
import { EditorialToolkit, type ScriptCheckResult } from "./tools.ts";

const MAX_DIAGNOSTICS = 200;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(EditorialToolkit, {
  script_check: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "script_check",
      );
      const threadId = scope.thread.threadId;
      const threads = yield* EditorialThreadService;
      const scripts = yield* ScriptVersionService;
      const evidence = yield* DossierEvidence;

      const thread = yield* threads.getVideoThread(threadId).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(invalid("script_check works in video threads only.")),
            onSome: Effect.succeed,
          }),
        ),
      );
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
      const dossier =
        thread.dossierId === null
          ? Option.none()
          : yield* evidence.load({
              runId: thread.runId,
              dossierId: thread.dossierId,
              dossierHash: thread.dossierHash,
            });
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
