import { NonNegativeInt, OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as EditorialThreadService from "../EditorialThreadService.ts";
import * as ScriptVersionService from "../ScriptVersionService.ts";

const Position = { line: Schema.Int, column: Schema.Int };

export const ScriptCheckResult = Schema.Struct({
  path: Schema.String,
  ok: Schema.Boolean,
  counts: Schema.Struct({ claims: NonNegativeInt, cited: NonNegativeInt, uncited: NonNegativeInt }),
  diagnostics: Schema.Array(
    Schema.Struct({ code: Schema.String, message: Schema.String, ...Position }),
  ),
  unknownCitations: Schema.Array(Schema.Struct({ id: Schema.String, ...Position })),
  /** True when diagnostics were cut to the first ones. */
  truncated: Schema.Boolean,
  /** The thread's dossier, and whether its evidence ids were compared. */
  dossier: Schema.NullOr(Schema.Struct({ dossierId: Schema.String, compared: Schema.Boolean })),
});
export type ScriptCheckResult = typeof ScriptCheckResult.Type;

const ScriptCheckTool = Tool.make("script_check", {
  description:
    "Check this video thread's script file without changing it: Hook, numbered Blocks, Close and optional Sources headings, claims without a citation, and citations missing from the thread's dossier evidence. It counts detectable citations; it does not verify that a source supports a claim.",
  parameters: Schema.Struct({
    path: TrimmedNonEmptyString.annotate({
      description: "Script file relative to this thread's workspace, e.g. videos/quantum.md.",
    }),
    dossierId: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "The dossier attached to this thread. Omit to use it; there is no other.",
      }),
    ),
  }),
  success: ScriptCheckResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    EditorialThreadService.EditorialThreadService,
    ScriptVersionService.ScriptVersionService,
  ],
})
  .annotate(Tool.Title, "Check the video script")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

/** Earlyscript's editorial tools. Read-only by design: none decides, scores, reorders or writes. */
export const EditorialToolkit = Toolkit.make(ScriptCheckTool);
