import { RegistryContext } from "@effect/atom-react";
import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  EnvironmentId,
  type EditorialInbox,
  type EditorialJobActivity,
} from "@t3tools/contracts";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import type { EditorialInboxView } from "./state";
import { TrendsEmptyPage } from "./TrendDossierPage";

const readAtom = Atom.make<AsyncResult.AsyncResult<EditorialInbox>>(AsyncResult.initial());
const liveAtom = Atom.make<AsyncResult.AsyncResult<EditorialInboxView>>(AsyncResult.initial());
const activityAtom = Atom.make<AsyncResult.AsyncResult<EditorialJobActivity>>(
  AsyncResult.success({ active: null }),
);

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    editorialEnvironment: {
      ...actual.editorialEnvironment,
      inbox: () => readAtom,
      liveInbox: () => liveAtom,
    },
    refreshEditorialInbox: () => {},
  };
});
vi.mock("./FirstRunCard", async () => ({
  ...(await vi.importActual<typeof import("./FirstRunCard")>("./FirstRunCard")),
  FirstRunPage: ({ emptyRun }: { readonly emptyRun: boolean }) => (
    <p>{emptyRun ? "Revisión sin tendencias" : "Primera revisión"}</p>
  ),
  FirstTrendsIntro: () => null,
}));
vi.mock("./jobsState", async () => {
  const actual = await vi.importActual<typeof import("./jobsState")>("./jobsState");
  const Effect = await vi.importActual<typeof import("effect/Effect")>("effect/Effect");
  return {
    ...actual,
    editorialJobsEnvironment: { ...actual.editorialJobsEnvironment, activity: () => activityAtom },
    refreshJobsList: () => Effect.void,
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("env-1");

const NO_RUN: EditorialInbox = {
  run: null,
  sort: "new-first-growth",
  trends: [],
  total: 0,
  newCount: 0,
  snoozedCount: 0,
  dismissedCount: 0,
};

const renderPage = (inbox: EditorialInbox, sidebarOpen: boolean) => {
  const registry = AtomRegistry.make();
  registry.set(readAtom, AsyncResult.success(inbox));
  registry.set(liveAtom, AsyncResult.success({ seq: 1, inbox }));
  return {
    registry,
    screen: render(
      <RegistryContext.Provider value={registry}>
        <SidebarProvider defaultOpen={sidebarOpen}>
          <TrendsEmptyPage environmentId={ENVIRONMENT_ID} />
        </SidebarProvider>
      </RegistryContext.Provider>,
    ),
  };
};

describe("TrendsEmptyPage", () => {
  it("hands an inbox without trends to the first-run page", async () => {
    const { screen: pending } = renderPage(NO_RUN, true);
    await using screen = await pending;
    await expect.element(screen.getByText("Primera revisión")).toBeVisible();
  });

  it("lists the run's cards once it has trends", async () => {
    const run: EditorialInbox = {
      ...NO_RUN,
      run: {
        runId: EditorialRunId.make("run_20261102"),
        cutoffAt: "2026-11-02T00:00:00.000Z",
        finishedAt: null,
        status: "ok",
        configVersion: null,
        sources: ["hn"],
        dossierCount: 1,
      },
      trends: [
        {
          dossierId: EditorialDossierId.make("dos_alpha"),
          runId: EditorialRunId.make("run_20261102"),
          label: "alpha trend",
          terms: ["alpha"],
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
          trendKey: EditorialTrendKey.make("sig_alpha"),
          inbox: {
            isNew: true,
            seenRunId: null,
            seenAt: null,
            snoozed: null,
            dismissed: null,
            production: null,
          },
        },
      ],
    };
    const { screen: pending } = renderPage(run, true);
    await using screen = await pending;
    // An older run has no sections: one list, each trend a card that opens its dossier.
    await expect
      .element(screen.getByRole("heading", { name: "Tendencias", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("link", { name: "alpha trend" })).toBeVisible();
  });
});
