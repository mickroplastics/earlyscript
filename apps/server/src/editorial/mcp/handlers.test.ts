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

it("the editorial catalog has script_check only, read-only", () => {
  expect(Object.keys(EditorialToolkit.tools)).toEqual(["script_check"]);
});

it.effect("registers script_check alone and refuses tool names it does not register", () =>
  withVideoWorkspace(() =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map((entry) => entry.tool.name)).toEqual(["script_check"]);
      expect(server.tools[0]?.tool.annotations?.readOnlyHint).toBe(true);
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
