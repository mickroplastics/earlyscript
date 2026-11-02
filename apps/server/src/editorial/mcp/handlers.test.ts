// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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

it.effect("refuses script paths outside the workspace, symlinks included", () =>
  withVideoWorkspace(({ workspace, outside, write }) =>
    Effect.gen(function* () {
      yield* write(SCRIPT_PATH, SCRIPT);
      NodeFS.writeFileSync(NodePath.join(outside, "secret.md"), "# Hook\n\nOutside.\n");
      NodeFS.symlinkSync(
        NodePath.join(outside, "secret.md"),
        NodePath.join(workspace, "videos", "link.md"),
      );
      for (const path of [
        NodePath.join(outside, "secret.md"),
        "../outside/secret.md",
        "videos/link.md",
      ]) {
        const text = errorText(yield* callTool("script_check", { path }));
        expect(text).toContain("not inside the thread workspace");
        expect(text).not.toContain("Outside.");
      }
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
const dossierFile = (dossierId = "dossier-1") =>
  `---\nschema: ${DOSSIER_FILE_SCHEMA}\ndossier_id: ${dossierId}\ndossier_hash: sha256:dossier\nrun_id: run-1\ntrend_key: null\n---\n\n# Quantum error correction\n\n## Evidencia (1)\n\n### [itm_hn_1] IBM roadmap\n\n- URL: https://news.ycombinator.com/item?id=1\n`;

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
      expect((result.structuredContent as { note: string }).note).toContain("Crear hilo de video");
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
