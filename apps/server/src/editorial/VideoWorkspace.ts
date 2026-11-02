// @effect-diagnostics nodeBuiltinImport:off - writes the read-only dossier file with its mode.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { SCRIPT_TEMPLATE } from "@earlyscript/editorial-script";
import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialGetDossierInput,
  type EditorialReadError,
  type EditorialTrendDossier,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { VideoThread } from "./persistence/EditorialModel.ts";
import { threadWorkspaceRoot } from "./threadWorkspace.ts";
import { dossierPathOf, renderDossierMarkdown } from "./videoWorkspaceFormat.ts";

/** What preparing a thread's folder did, for the log and the tests. */
export interface VideoWorkspaceResult {
  /** Null when the thread has no workspace the server can find. */
  readonly workspaceRoot: string | null;
  readonly dossier: "written" | "unchanged" | "none";
  readonly script: "created" | "exists" | "none";
}

/**
 * Prepares the folder of a video thread in its workspace: the dossier as read-only Markdown
 * (`videos/<slug>/expediente.md`) and the script from the template, so the agent and the
 * operator start from the same files. Never fails: the thread is already created, and a folder
 * that cannot be written leaves "Abrir guion" to create the script as before.
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

/** Workspace-relative and inside it, by syntax; symlinks are checked when writing. */
const isInside = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * The real folder of `relativeFile`'s parent, created if missing, or null when it leaves the
 * workspace (an absolute path, `..`, or a symlinked folder pointing out).
 */
const folderInside = async (root: string, relativeFile: string): Promise<string | null> => {
  if (NodePath.isAbsolute(relativeFile) || relativeFile.includes("\0")) return null;
  const target = NodePath.resolve(root, relativeFile);
  if (!isInside(root, target)) return null;
  const folder = NodePath.dirname(target);
  await NodeFSP.mkdir(folder, { recursive: true });
  const [realRoot, realFolder] = await Promise.all([
    NodeFSP.realpath(root),
    NodeFSP.realpath(folder),
  ]);
  return realFolder === realRoot || isInside(realRoot, realFolder) ? realFolder : null;
};

/** Written through a temporary file and a rename, so a reader never sees half a dossier. */
const writeReadOnly = async (folder: string, name: string, contents: string) => {
  const target = NodePath.join(folder, name);
  const current = await NodeFSP.readFile(target, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (current === contents) {
    await NodeFSP.chmod(target, 0o444);
    return "unchanged" as const;
  }
  const temporary = NodePath.join(folder, `.${name}.${process.pid}.tmp`);
  await NodeFSP.rm(temporary, { force: true });
  await NodeFSP.writeFile(temporary, contents, { flag: "wx", mode: 0o444 });
  await NodeFSP.rename(temporary, target);
  return "written" as const;
};

/** `wx`: a script that exists, written by the agent or the operator, is never replaced. */
const createIfMissing = async (folder: string, name: string, contents: string) =>
  NodeFSP.writeFile(NodePath.join(folder, name), contents, { flag: "wx" }).then(
    () => "created" as const,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return "exists" as const;
      throw error;
    },
  );

const make = Effect.gen(function* () {
  const rootOf = threadWorkspaceRoot(
    yield* ThreadManagement.ThreadManagementService,
    yield* ProjectService.ProjectService,
  );

  const prepare: EditorialVideoWorkspace["Service"]["prepare"] = Effect.fn(
    "EditorialVideoWorkspace.prepare",
  )(function* ({ thread, dossier }) {
    const none: VideoWorkspaceResult = { workspaceRoot: null, dossier: "none", script: "none" };
    const scriptPath = thread.scriptPath;
    const root = yield* rootOf(thread.threadId).pipe(Effect.orElseSucceed(() => null));
    if (root === null || scriptPath === null) return none;
    const dossierPath = dossierPathOf(thread);
    const contents =
      dossier === null || dossierPath === null
        ? null
        : renderDossierMarkdown({
            dossier,
            dossierHash: thread.dossierHash,
            trendKey: thread.trendKey,
          });
    return yield* Effect.tryPromise(async (): Promise<VideoWorkspaceResult> => {
      const scriptFolder = await folderInside(root, scriptPath);
      const script =
        scriptFolder === null
          ? "none"
          : await createIfMissing(scriptFolder, NodePath.basename(scriptPath), SCRIPT_TEMPLATE);
      let written: VideoWorkspaceResult["dossier"] = "none";
      if (contents !== null && dossierPath !== null) {
        const dossierFolder = await folderInside(root, dossierPath);
        if (dossierFolder !== null) {
          written = await writeReadOnly(dossierFolder, NodePath.basename(dossierPath), contents);
        }
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

  return EditorialVideoWorkspace.of({ prepare });
});

export const layer = Layer.effect(EditorialVideoWorkspace, make);
