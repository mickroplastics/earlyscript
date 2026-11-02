// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { DossierEvidence } from "../DossierEvidence.ts";
import { DOSSIER_FILE_SCHEMA } from "../videoWorkspaceFormat.ts";
import {
  SCRIPT,
  SCRIPT_PATH,
  VIDEO_THREAD_ID,
  withVideoWorkspace,
} from "../videoThread.testkit.ts";
import { EditorialToolkit } from "./tools.ts";

const invocationFor = (threadId: string): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:editorial-mcp"),
  requestNamespace: "provider:editorial-mcp",
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: "provider:editorial-mcp",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "editorial-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "editorial-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerEditorialServer = (dossier: Option.Option<unknown> = Option.none()) =>
  McpHttpServer.layerEditorialToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(DossierEvidence, { load: () => Effect.succeed(dossier) })),
  );

const callTool = (name: string, args: Record<string, unknown>, threadId = VIDEO_THREAD_ID) =>
  McpServer.McpServer.use((server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(threadId)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const errorText = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

it("the editorial catalog has dossier_read and script_check, both read-only", () => {
  expect(Object.keys(EditorialToolkit.tools)).toEqual(["dossier_read", "script_check"]);
});

it.effect("registers its two tools and refuses tool names it does not register", () =>
  withVideoWorkspace(() =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map((entry) => entry.tool.name)).toEqual([
        "dossier_read",
        "script_check",
      ]);
      for (const entry of server.tools) expect(entry.tool.annotations?.readOnlyHint).toBe(true);
      for (const name of ["script_write", "editorial_decide", "trend_score"]) {
        const error = yield* Effect.flip(callTool(name, { path: SCRIPT_PATH }));
        expect(error).toMatchObject({ _tag: "InvalidParams", message: `Tool '${name}' not found` });
      }
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);

it.effect("checks the thread's script and reports uncited claims", () =>
  withVideoWorkspace(({ write }) =>
    Effect.gen(function* () {
      yield* write(SCRIPT_PATH, `${SCRIPT.replace(" [gh:2]", "")}`);
      const result = yield* callTool("script_check", { path: SCRIPT_PATH });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        path: SCRIPT_PATH,
        ok: false,
        counts: { claims: 3, cited: 1, uncited: 2 },
        unknownCitations: [],
        truncated: false,
        dossier: { dossierId: "dossier-1", compared: false },
      });
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);

it.effect("compares citations with the dossier evidence when it is available", () =>
  withVideoWorkspace(({ write }) =>
    Effect.gen(function* () {
      yield* write(SCRIPT_PATH, SCRIPT);
      const result = yield* callTool("script_check", { path: SCRIPT_PATH, dossierId: "dossier-1" });
      expect(result.structuredContent).toMatchObject({
        unknownCitations: [{ id: "itm_gh_2" }],
        dossier: { dossierId: "dossier-1", compared: true },
      });
      const other = yield* callTool("script_check", { path: SCRIPT_PATH, dossierId: "dossier-2" });
      expect(errorText(other)).toContain("dossier is dossier-1");
    }).pipe(
      Effect.provide(layerEditorialServer(Option.some({ evidence: [{ item_id: "itm_hn_1" }] }))),
    ),
  ),
);

it.effect("reads only files of the thread's folder, never through a link", () =>
  withVideoWorkspace(({ workspace, outside, write }) =>
    Effect.gen(function* () {
      yield* write(SCRIPT_PATH, SCRIPT);
      NodeFS.writeFileSync(NodePath.join(outside, "secret.md"), "# Hook\n\nOutside.\n");
      NodeFS.symlinkSync(
        NodePath.join(outside, "secret.md"),
        NodePath.join(workspace, "videos", "link.md"),
      );
      // Sol's adversarial-mcp.mjs: `arbitrary` and `other`.
      yield* write("outside-video.md", "# Hook\n\nA claim [itm_hn_999].\n\n# Close\n");
      yield* write("videos/other/expediente.md", "# OTHER THREAD PRIVATE DOSSIER\n");
      yield* write("videos/quantum/notes.md", "# Hook\n\nNotes of this video.\n");
      NodeFS.symlinkSync(
        NodePath.join(outside, "secret.md"),
        NodePath.join(workspace, "videos", "quantum", "linked.md"),
      );
      for (const path of [
        NodePath.join(outside, "secret.md"),
        "../outside/secret.md",
        "videos/link.md",
        "outside-video.md",
        "videos/other/expediente.md",
        "videos/quantum/../other/expediente.md",
        "videos/quantum/linked.md",
      ]) {
        const text = errorText(yield* callTool("script_check", { path }));
        expect(text, path).toContain("script_check only reads files inside this thread's folder.");
        expect(text).not.toContain("Outside.");
        expect(text).not.toContain("OTHER THREAD");
      }
      // A file inside the folder is read.
      const notes = yield* callTool("script_check", { path: "videos/quantum/notes.md" });
      expect(notes.structuredContent).toMatchObject({ path: "videos/quantum/notes.md" });
      expect(
        errorText(yield* callTool("script_check", { path: "videos/quantum/missing.md" })),
      ).toContain("does not exist in this thread's folder");
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);

it.effect("works in video threads only", () =>
  withVideoWorkspace(() =>
    Effect.gen(function* () {
      const result = yield* callTool("script_check", { path: SCRIPT_PATH }, "thread-upstream");
      expect(errorText(result)).toContain("video threads only");
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);

/** A dossier file as the server writes it, for the thread's `dossier-1`. */
const DOSSIER_PATH = "videos/quantum/expediente.md";
const DOSSIER_BODY =
  "\n# Quantum error correction\n\n## Evidencia (1)\n\n### [itm_hn_1] IBM roadmap\n\n- URL: https://news.ycombinator.com/item?id=1\n";
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const dossierFile = (dossierId = "dossier-1", body = DOSSIER_BODY) =>
  `---\nschema: ${DOSSIER_FILE_SCHEMA}\ndossier_id: ${dossierId}\ndossier_hash: sha256:dossier\nrun_id: run-1\ntrend_key: null\nbody_hash: ${sha256(body)}\n---\n${body}`;

it.effect("dossier_read gives the thread's trend, folder, script and dossier file", () =>
  withVideoWorkspace(({ write }) =>
    Effect.gen(function* () {
      yield* write(DOSSIER_PATH, dossierFile());
      const result = yield* callTool("dossier_read", {});
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        mode: "assisted",
        trendTitle: "Quantum error correction",
        folder: "videos/quantum",
        scriptPath: SCRIPT_PATH,
        dossierPath: DOSSIER_PATH,
        dossierId: "dossier-1",
        dossier: dossierFile(),
        note: null,
      });
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);

it.effect("dossier_read says what to do when the dossier file is not written yet", () =>
  withVideoWorkspace(() =>
    Effect.gen(function* () {
      const result = yield* callTool("dossier_read", {});
      expect(result.structuredContent).toMatchObject({ dossier: null, dossierPath: DOSSIER_PATH });
      expect((result.structuredContent as { note: string }).note).toContain(
        "El expediente de este hilo no está disponible",
      );
      expect(errorText(yield* callTool("dossier_read", {}, "thread-upstream"))).toContain(
        "video threads only",
      );
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);

it.effect("script_check compares with the dossier file when the run is not readable", () =>
  withVideoWorkspace(({ write }) =>
    Effect.gen(function* () {
      yield* write(SCRIPT_PATH, SCRIPT);
      yield* write(DOSSIER_PATH, dossierFile());
      const result = yield* callTool("script_check", { path: SCRIPT_PATH });
      expect(result.structuredContent).toMatchObject({
        unknownCitations: [{ id: "itm_gh_2" }],
        dossier: { dossierId: "dossier-1", compared: true },
      });
      // A dossier file of another dossier is not this thread's evidence.
      yield* write(DOSSIER_PATH, dossierFile("dossier-9"));
      expect(
        (yield* callTool("script_check", { path: SCRIPT_PATH })).structuredContent,
      ).toMatchObject({
        unknownCitations: [],
        dossier: { dossierId: "dossier-1", compared: false },
      });
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);

it.effect(
  "dossier_read gives nothing for a link to another thread's dossier or an edited one",
  () =>
    withVideoWorkspace(({ workspace, write }) =>
      Effect.gen(function* () {
        // Sol's adversarial-mcp.mjs: `symlink`.
        yield* write("videos/other/expediente.md", dossierFile());
        NodeFS.mkdirSync(NodePath.join(workspace, "videos", "quantum"), { recursive: true });
        NodeFS.symlinkSync(
          NodePath.join(workspace, "videos", "other", "expediente.md"),
          NodePath.join(workspace, DOSSIER_PATH),
        );
        const linked = (yield* callTool("dossier_read", {})).structuredContent;
        expect(linked).toMatchObject({ dossier: null, trendTitle: null, dossierId: "dossier-1" });
        expect((linked as { note: string }).note).toContain("no está disponible");

        // The same file at the right place, with another hash or dossier in its frontmatter.
        NodeFS.rmSync(NodePath.join(workspace, DOSSIER_PATH));
        for (const forged of [
          dossierFile().replace("dossier_hash: sha256:dossier", "dossier_hash: sha256:other"),
          dossierFile("dossier-9"),
          "# Quantum error correction\n\nNo frontmatter.\n",
          // Right id and hashes in the frontmatter, another body: Sol's adversarial-extra.mjs.
          dossierFile().replace("[itm_hn_1] IBM roadmap", "[itm_hn_777] Invented item"),
          dossierFile().replace(/\nbody_hash: [0-9a-f]+/, ""),
        ]) {
          yield* write(DOSSIER_PATH, forged);
          const result = (yield* callTool("dossier_read", {})).structuredContent;
          expect(result).toMatchObject({ dossier: null, trendTitle: null });
          // script_check does not take its evidence from such a file either.
          yield* write(SCRIPT_PATH, SCRIPT);
          expect(
            (yield* callTool("script_check", { path: SCRIPT_PATH })).structuredContent,
          ).toMatchObject({ dossier: { dossierId: "dossier-1", compared: false } });
        }
      }).pipe(Effect.provide(layerEditorialServer())),
    ),
);

it.effect("dossier_read answers at once when the dossier file is a FIFO", () =>
  withVideoWorkspace(({ workspace }) =>
    Effect.gen(function* () {
      // Windows has no FIFOs.
      if (HostProcess.Platform.defaultValue() === "win32") return;
      NodeFS.mkdirSync(NodePath.join(workspace, "videos", "quantum"), { recursive: true });
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(workspace, DOSSIER_PATH)]);
      const result = (yield* callTool("dossier_read", {})).structuredContent;
      expect(result).toMatchObject({ dossier: null });
    }).pipe(Effect.provide(layerEditorialServer())),
  ),
);
