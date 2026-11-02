import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../project/ProjectService.ts";

/**
 * The folder a thread's files live in, as the file surface reads them: its worktree, else its
 * project's checkout. Null for a deleted or unknown thread, or one whose project is gone.
 */
export const threadWorkspaceRoot = (
  threadManagement: ThreadManagement.ThreadManagementService["Service"],
  projects: ProjectService.ProjectService["Service"],
) =>
  Effect.fn("EditorialThreadWorkspace.root")(function* (threadId: string) {
    const shell = yield* threadManagement.getThreadShell(ThreadId.make(threadId));
    if (shell === null || shell.deletedAt !== null) return null;
    if (shell.worktreePath !== null) return shell.worktreePath;
    const project = yield* projects.getById(shell.projectId);
    return Option.isNone(project) ? null : project.value.workspaceRoot;
  });
