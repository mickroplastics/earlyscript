import { RegistryContext } from "@effect/atom-react";
import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  EnvironmentId,
  type EditorialInbox,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import type { EditorialInboxView } from "./state";
import { TrendInbox } from "./TrendInbox";

const state = vi.hoisted(() => ({ refetches: [] as Array<string> }));

// The read and the subscription as plain atoms, so the test drives what each one holds.
const readAtom = Atom.make<AsyncResult.AsyncResult<EditorialInbox>>(AsyncResult.initial());
const liveAtom = Atom.make<AsyncResult.AsyncResult<EditorialInboxView>>(AsyncResult.initial());

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    editorialEnvironment: {
      ...actual.editorialEnvironment,
      inbox: () => readAtom,
      liveInbox: () => liveAtom,
    },
    refreshEditorialInbox: (_registry: unknown, environmentId: string) => {
      state.refetches.push(environmentId);
    },
  };
});
vi.mock("./TrendPresentationRunButton", () => ({ TrendPresentationRunButton: () => null }));

function setup() {
  state.refetches = [];
}

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const NEW = {
  isNew: true,
  seenRunId: null,
  seenAt: null,
  snoozed: null,
  dismissed: null,
  production: null,
};

const trend = (runId: EditorialRunId, key: string): EditorialTrendSummary => ({
  dossierId: EditorialDossierId.make(`dos_${key}`),
  runId,
  label: `${key} trend`,
  terms: [key],
  subtitle: null,
  stage: "growing",
  corroboration: "single_source",
  items7d: 3,
  items28d: 3,
  authors7d: 3,
  volumeRank: 1,
  scoreRank: 1,
  score: 1,
  growth: 0.5,
  affinity: 0.7,
  sourceCount: 1,
  sources: ["hn"],
  sparkline: [],
  isNew: true,
  trendKey: EditorialTrendKey.make(`sig_${key}`),
  inbox: NEW,
});

const inboxOf = (day: string, keys: ReadonlyArray<string>): EditorialInbox => {
  const runId = EditorialRunId.make(`run_202610${day}`);
  return {
    run: {
      runId,
      cutoffAt: `2026-10-${day}T00:00:00.000Z`,
      finishedAt: null,
      status: "ok",
      configVersion: null,
      sources: ["hn"],
      dossierCount: keys.length,
    },
    sort: "new-first-growth",
    trends: keys.map((key) => trend(runId, key)),
    total: keys.length,
    newCount: keys.length,
    snoozedCount: 0,
    dismissedCount: 0,
  };
};

describe("TrendInbox", () => {
  it("adopts a run the subscription imports and keeps the order when a trend is read", async () => {
    setup();
    const registry = AtomRegistry.make();
    const run19 = inboxOf("19", ["alpha", "beta"]);
    registry.set(readAtom, AsyncResult.success(run19));
    registry.set(liveAtom, AsyncResult.success({ seq: 1, inbox: run19 }));
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <SidebarProvider defaultOpen>
          <TrendInbox environmentId={ENVIRONMENT_ID} activeDossierId={null} />
        </SidebarProvider>
      </RegistryContext.Provider>,
    );
    const titles = () =>
      Array.from(screen.container.querySelectorAll('a[data-sidebar="menu-button"]')).map((row) =>
        row.textContent?.includes("alpha trend") ? "alpha" : "beta",
      );
    await expect.element(screen.getByText("Más reciente · corrida 19 oct")).toBeVisible();

    // Read on the server: the subscription moves alpha's state; the row stays first.
    await act(() =>
      registry.set(
        liveAtom,
        AsyncResult.success({
          seq: 2,
          inbox: {
            ...run19,
            trends: [
              { ...run19.trends[0]!, isNew: false, inbox: { ...NEW, isNew: false } },
              run19.trends[1]!,
            ],
            newCount: 1,
          },
        }),
      ),
    );
    expect(titles()).toEqual(["alpha", "beta"]);
    expect(state.refetches).toEqual([]);

    // The importer brings the 20 October run: it shows at once and the read refetches once.
    await act(() =>
      registry.set(liveAtom, AsyncResult.success({ seq: 3, inbox: inboxOf("20", ["gamma"]) })),
    );
    await expect.element(screen.getByText("Más reciente · corrida 20 oct")).toBeVisible();
    await expect.element(screen.getByText("gamma trend")).toBeVisible();
    expect(state.refetches).toEqual([ENVIRONMENT_ID]);
  });

  it("keeps a snoozed or dismissed open dossier folded away, with only its count", async () => {
    setup();
    const run19 = inboxOf("19", ["alpha", "beta", "gamma"]);
    const AT = "2026-10-31T08:00:00.000Z";
    const settled: EditorialInbox = {
      ...run19,
      trends: [
        run19.trends[0]!,
        {
          ...run19.trends[1]!,
          isNew: false,
          inbox: { ...NEW, isNew: false, snoozed: { at: AT, until: null, returnWhen: null } },
        },
        {
          ...run19.trends[2]!,
          isNew: false,
          inbox: { ...NEW, isNew: false, dismissed: { at: AT, reason: "Ya cubierto" } },
        },
      ],
    };
    for (const active of ["dos_beta", "dos_gamma"]) {
      const registry = AtomRegistry.make();
      registry.set(readAtom, AsyncResult.success(settled));
      registry.set(liveAtom, AsyncResult.success({ seq: 1, inbox: settled }));
      await using screen = await render(
        <RegistryContext.Provider value={registry}>
          <SidebarProvider defaultOpen>
            <TrendInbox
              environmentId={ENVIRONMENT_ID}
              activeDossierId={EditorialDossierId.make(active)}
            />
          </SidebarProvider>
        </RegistryContext.Provider>,
      );
      await expect
        .element(screen.getByRole("button", { name: "En observación (1)" }))
        .toHaveAttribute("aria-expanded", "false");
      await expect
        .element(screen.getByRole("button", { name: "Descartadas (1)" }))
        .toHaveAttribute("aria-expanded", "false");
      expect(screen.container.querySelectorAll('a[data-sidebar="menu-button"]')).toHaveLength(1);
    }
  });
});
