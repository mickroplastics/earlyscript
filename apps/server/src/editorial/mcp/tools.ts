import { NonNegativeInt, OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as EditorialThreadService from "../EditorialThreadService.ts";
import * as VideoWorkspace from "../VideoWorkspace.ts";

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
      description:
        "Script file relative to this thread's workspace, inside its video folder, e.g. videos/quantum-1a2b3c4d/guion.md.",
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
    VideoWorkspace.EditorialVideoWorkspace,
  ],
})
  .annotate(Tool.Title, "Check the video script")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

export const DossierReadResult = Schema.Struct({
  mode: Schema.Literals(["assisted", "manual"]),
  /** The dossier file's title: the trend's assistant title, else the engine label. */
  trendTitle: Schema.NullOr(Schema.String),
  /** The video's folder, where the agent writes; relative to the thread's workspace. */
  folder: Schema.NullOr(Schema.String),
  scriptPath: Schema.NullOr(Schema.String),
  dossierPath: Schema.NullOr(Schema.String),
  dossierId: Schema.NullOr(Schema.String),
  /** The dossier file as Markdown; null when the thread has none or it is not written yet. */
  dossier: Schema.NullOr(Schema.String),
  /** Why `dossier` is null, in Spanish, for the agent to tell the operator. */
  note: Schema.NullOr(Schema.String),
});
export type DossierReadResult = typeof DossierReadResult.Type;

const DossierReadTool = Tool.make("dossier_read", {
  description:
    "Read this video thread's context: the trend it works on, the video folder, the script path and the read-only dossier (expediente.md) with every piece of evidence, its id and URL. Call it first in a video thread; the dossier is the only source of facts for the script.",
  // No `parameters`: the thread is the caller's, and there is no other dossier to ask for.
  success: DossierReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    EditorialThreadService.EditorialThreadService,
    VideoWorkspace.EditorialVideoWorkspace,
  ],
})
  .annotate(Tool.Title, "Read the video dossier")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

/** Earlyscript's editorial tools. Read-only by design: none decides, scores, reorders or writes. */
export const EditorialToolkit = Toolkit.make(DossierReadTool, ScriptCheckTool);
