import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  getFiletypeFromFileName,
  type FileContents,
  type PostRenderPhase,
} from "@pierre/diffs";
import { Editor, type EditorChangeEvent, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer, useWorkerPool } from "@pierre/diffs/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { CodeIcon, EyeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { projectFileCacheKey } from "../components/files/fileContentRevision";
import { FileMarkdownPreview } from "../components/files/FileMarkdownPreview";
import { changeFileSaveSession, useFileSaveSession } from "../components/files/fileSaveSessions";
import {
  getProjectFileContents,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "../components/files/projectFilesQueryState";
import { ScrollArea } from "../components/ui/scroll-area";
import { Spinner } from "../components/ui/spinner";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";

const createEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) =>
  new Editor(editorType, options, editStateKey);

/** The editor keeps its own lease on the save session; nothing here reacts to pending writes. */
const ignorePending = () => {};

function editorFile(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): FileContents {
  return {
    name: relativePath,
    contents,
    cacheKey: `script-editor:${environmentId}:${projectFileCacheKey(cwd, relativePath, contents)}`,
  };
}

function needsWorkerHighlight(workerPool: WorkerPoolManager | undefined, file: FileContents) {
  if (workerPool?.isWorkingPool() !== true) return false;
  if ((file.lang ?? getFiletypeFromFileName(file.name)) === "text") return false;
  return file.contents.split("\n").length <= DEFAULT_TOKENIZE_MAX_LENGTH;
}

/** As the file surface does: edit only once the worker's highlight rendered, or failed. */
function useEditableAfterHighlight(file: FileContents) {
  const workerPool = useWorkerPool();
  const [highlighted, setHighlighted] = useState<FileContents | null>(null);
  const ready = !needsWorkerHighlight(workerPool, file) || highlighted === file;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- primes the worker pool's highlight cache for this file and falls back to plain text if it fails
  useEffect(() => {
    if (ready || workerPool === undefined) return;
    workerPool.primeFileHighlightCache(file).catch(() => setHighlighted(file));
  }, [file, ready, workerPool]);
  const onPostRender = (rendered: FileContents | undefined, phase: PostRenderPhase) => {
    if (ready || phase === "unmount" || rendered?.cacheKey !== file.cacheKey) return;
    if (workerPool?.getFileResultCache(file) !== undefined) setHighlighted(file);
  };
  return { ready, onPostRender };
}

function ScriptSource({
  environmentId,
  cwd,
  relativePath,
  contents,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly readOnly: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const saveTarget = { environmentId, cwd, relativePath };
  useFileSaveSession(saveTarget, ignorePending);
  // The editor's own echo keeps its file; only a change from elsewhere replaces the draft.
  const [externalFile, setExternalFile] = useState(() =>
    editorFile(environmentId, cwd, relativePath, contents),
  );
  const [edited, setEdited] = useState<string | null>(null);
  if (contents !== (edited ?? externalFile.contents)) {
    setExternalFile(editorFile(environmentId, cwd, relativePath, contents));
    setEdited(null);
  }
  const { ready, onPostRender } = useEditableAfterHighlight(externalFile);
  const handleEditChange = ({ file }: EditorChangeEvent<"file", undefined, undefined>) => {
    if (file.contents === getProjectFileContents(environmentId, cwd, relativePath)) return;
    setEdited(file.contents);
    setProjectFileQueryData(environmentId, cwd, relativePath, file.contents);
    changeFileSaveSession(saveTarget, file.contents);
  };
  return (
    <EditProvider createEditor={createEditor}>
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={externalFile}
          edit={ready && !readOnly}
          onEditChange={handleEditChange}
          options={{
            disableFileHeader: true,
            overflow: "wrap",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            onPostRender: (_container, instance, phase) => onPostRender(instance.file, phase),
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </EditProvider>
  );
}

/**
 * The manual thread's script: the workspace file, edited with the same editor and save
 * sessions as the file surface, so the header clock versions it as it saves. A Markdown view
 * beside it. No review comments, no composer, no completion: nothing here talks to an agent.
 */
export function ScriptEditor({
  threadRef,
  workspaceRoot,
  scriptPath,
  readOnly,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly scriptPath: string;
  readonly readOnly: boolean;
}) {
  const { environmentId } = threadRef;
  const file = useProjectFileQuery(environmentId, workspaceRoot, scriptPath);
  const [view, setView] = useState<"source" | "preview">("source");
  const contents = file.data?.contents ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="manual-script-editor">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <code className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{scriptPath}</code>
        <ToggleGroup
          aria-label="Vista del guion"
          size="compact"
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "source" || next === "preview") setView(next);
          }}
        >
          <Toggle value="source" aria-label="Editar">
            <CodeIcon aria-hidden />
            Editar
          </Toggle>
          <Toggle value="preview" aria-label="Vista previa">
            <EyeIcon aria-hidden />
            Vista previa
          </Toggle>
        </ToggleGroup>
      </div>
      {contents === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
          {file.error === null ? <Spinner /> : file.error}
        </div>
      ) : view === "preview" ? (
        <ScrollArea className="min-h-0 flex-1">
          <FileMarkdownPreview
            cwd={workspaceRoot}
            relativePath={scriptPath}
            text={contents}
            threadRef={threadRef}
            workspaceMutationId={null}
          />
        </ScrollArea>
      ) : (
        <DiffWorkerPoolProvider>
          <ScriptSource
            environmentId={environmentId}
            cwd={workspaceRoot}
            relativePath={scriptPath}
            contents={contents}
            readOnly={readOnly}
          />
        </DiffWorkerPoolProvider>
      )}
    </div>
  );
}
