// Saving the studio profile through the app's own atoms: the profile command, the inbox and
// dossier queries and Settings are the real ones; only the wire is replaced by a fake server
// that marks drafts stale once the profile version changes, as `inputHash` does on the server.
import { EnvironmentId, type EditorialProfileVersion } from "@t3tools/contracts";
import type * as EffectTypes from "effect/Effect";
import type { Atom as AtomTypes } from "effect/reactivity";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { useEnvironmentQuery } from "../../state/query";
import { ChannelProfileSettings } from "../settings/ChannelSettings";
import { editorialEnvironment } from "../state";

const ENVIRONMENT_ID = EnvironmentId.make("environment-profile-save");

const server = vi.hoisted(() => ({
  version: 1,
  canOperate: true,
  /** Each test reads fresh query atoms. */
  epoch: 0,
  calls: [] as Array<string>,
}));

const V1: EditorialProfileVersion = {
  version: 1,
  language: "en",
  name: "SingulariDev",
  audience: "Solo founders and developers building products with AI agents",
  include: ["AI coding agents", "local language models"],
  exclude: ["cryptocurrency prices"],
  hash: "sha256:db510e303cb7f3cff7099230a00d36b1918f28a0e6aa6b8be01727649b8bb80d",
  createdAt: "2026-11-02T18:00:00.000Z",
  origin: "earlywindow",
  active: true,
};

vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => ENVIRONMENT_ID,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (original) => {
  const actual = await original<typeof import("@t3tools/client-runtime/state/runtime")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  type AnyAtom = AtomTypes.Atom<unknown>;

  const active = () => ({
    ...V1,
    version: server.version,
    origin: server.version === 1 ? "earlywindow" : "operator",
    hash: `sha256:${String(server.version).repeat(64)}`,
  });
  const status = () => (server.version === 1 ? "ready" : "stale");
  const answers: Record<string, (input: never) => unknown> = {
    "editorial.profile.get": () => ({ active: active(), scoring: null }),
    "editorial.profile.history": () => ({ versions: [active()] }),
    "editorial.profile.update": () => {
      server.version += 1;
      return { active: active(), changed: true };
    },
    "editorial.getDossier": () => ({ trend: { presentation: { status: status() } } }),
    "editorial.getInbox": () => ({ trends: [{ presentation: { status: status() } }] }),
  };
  const answer = (tag: string, input: unknown) => {
    server.calls.push(tag);
    return answers[tag]!(input as never);
  };

  // Kept alive like the real queries' cache: only their refresh trigger makes them read again.
  const createEnvironmentRpcQueryAtomFamily: typeof actual.createEnvironmentRpcQueryAtomFamily = (
    runtime,
    options,
  ) => {
    if (!Object.hasOwn(answers, options.tag)) {
      return actual.createEnvironmentRpcQueryAtomFamily(runtime, options);
    }
    const atoms = new Map<string, AnyAtom>();
    return ((target: { readonly environmentId: EnvironmentId; readonly input: unknown }) => {
      const key = `${server.epoch}:${JSON.stringify(target)}`;
      const cached = atoms.get(key);
      if (cached !== undefined) return cached;
      const atom: AnyAtom = Atom.make((get) => {
        const trigger = options.refreshTrigger?.(target as never);
        if (trigger !== undefined) get(trigger);
        return AsyncResult.success(answer(options.tag, target.input));
      }).pipe(Atom.keepAlive);
      atoms.set(key, atom);
      return atom;
    }) as never;
  };

  const permissions = new Map<boolean, AtomTypes.Atom<boolean>>();
  const fakeRuntime = Atom.runtime(Layer.empty);
  const createEnvironmentRpcCommand: typeof actual.createEnvironmentRpcCommand = (
    runtime,
    options,
  ) => {
    if (!Object.hasOwn(answers, options.tag)) {
      return actual.createEnvironmentRpcCommand(runtime, options);
    }
    type Target = { readonly environmentId: EnvironmentId; readonly input: unknown };
    const command = actual.createRuntimeCommand(fakeRuntime, {
      label: options.label,
      execute: (target: Target, registry) =>
        Effect.sync(() => answer(options.tag, target.input)).pipe(
          Effect.tap(
            (result) =>
              (options.onSuccess?.(target as never, registry, result as never) as
                | EffectTypes.Effect<void>
                | undefined) ?? Effect.void,
          ),
        ),
    });
    return {
      ...command,
      requiredScopes: () => [],
      permissionAtom: () => {
        const cached = permissions.get(server.canOperate);
        if (cached !== undefined) return cached;
        const atom = Atom.make(server.canOperate);
        permissions.set(server.canOperate, atom);
        return atom;
      },
    } as never;
  };

  return { ...actual, createEnvironmentRpcQueryAtomFamily, createEnvironmentRpcCommand };
});

const DOSSIER_INPUT = {
  runId: "run_20261101_20261101T215418_ecf454",
  dossierId: "dos_0ebf5250bb86",
  evidenceLimit: 10,
} as never;

const statusText = (status: string | undefined) =>
  status === "stale" ? "Desactualizado" : "Redacción vigente";

/** The dossier and the inbox row as the trends space reads them. */
function DossierProbe() {
  const dossier = useEnvironmentQuery(
    editorialEnvironment.dossier({ environmentId: ENVIRONMENT_ID, input: DOSSIER_INPUT }),
  );
  const inbox = useEnvironmentQuery(
    editorialEnvironment.inbox({ environmentId: ENVIRONMENT_ID, input: {} as never }),
  );
  return (
    <div>
      <p data-testid="dossier-status">{statusText(dossier.data?.trend.presentation?.status)}</p>
      <p data-testid="inbox-status">{statusText(inbox.data?.trends[0]?.presentation?.status)}</p>
    </div>
  );
}

function App() {
  const [space, setSpace] = useState<"dossier" | "settings">("dossier");
  return (
    <div className="min-h-screen bg-background p-4 text-foreground">
      <button type="button" onClick={() => setSpace(space === "dossier" ? "settings" : "dossier")}>
        {space === "dossier" ? "Abrir Ajustes" : "Volver al expediente"}
      </button>
      {space === "dossier" ? <DossierProbe /> : <ChannelProfileSettings />}
    </div>
  );
}

const reset = (canOperate: boolean) => {
  server.version = 1;
  server.epoch += 1;
  server.canOperate = canOperate;
  server.calls = [];
};

describe("saving the studio profile", () => {
  it("marks a dossier read before the save as out of date, without reloading", async () => {
    reset(true);
    await page.viewport(1280, 800);
    await using _screen = await render(<App />, { router: false });
    await expect.element(page.getByTestId("dossier-status")).toHaveTextContent("Redacción vigente");
    await expect.element(page.getByTestId("inbox-status")).toHaveTextContent("Redacción vigente");

    await userEvent.click(page.getByRole("button", { name: "Abrir Ajustes" }));
    await userEvent.fill(page.getByLabelText("Nombre del canal"), "SingulariDev prueba caché");
    await userEvent.click(page.getByRole("button", { name: "Guardar versión 2" }));
    // Saved: the bar goes away and the page shows the new version.
    await expect
      .element(page.getByRole("region", { name: "Cambios sin guardar" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Versión 2", { exact: true })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Volver al expediente" }));
    await expect.element(page.getByTestId("dossier-status")).toHaveTextContent("Desactualizado");
    await expect.element(page.getByTestId("inbox-status")).toHaveTextContent("Desactualizado");
    expect(server.calls.filter((tag) => tag === "editorial.getDossier")).toHaveLength(2);
  });

  it("keeps a session without orchestration:operate from editing", async () => {
    reset(false);
    await page.viewport(1280, 800);
    await using _screen = await render(<App />, { router: false });
    await userEvent.click(page.getByRole("button", { name: "Abrir Ajustes" }));
    await expect
      .element(page.getByText("Solo lectura: tu sesión no puede cambiar el perfil."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Nombre del canal")).toBeDisabled();
    await expect.element(page.getByLabelText("Temas que cubre: tema nuevo")).toBeDisabled();
    // Nothing to save from a read-only session: the save bar never shows.
    await expect
      .element(page.getByRole("button", { name: "Guardar versión 2" }))
      .not.toBeInTheDocument();
    expect(server.calls).not.toContain("editorial.profile.update");
  });
});
