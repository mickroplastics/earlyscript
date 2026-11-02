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
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { RUNNING_JOB } from "./firstRun.fixture";
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
  it("points to the first run in the inbox and opens a hidden sidebar", async () => {
    const { registry, screen: pending } = renderPage(NO_RUN, false);
    await using screen = await pending;
    await expect.element(screen.getByText("Todavía no hay corridas")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Abrir la bandeja" })).toBeVisible();

    registry.set(activityAtom, AsyncResult.success({ active: RUNNING_JOB }));
    await expect.element(screen.getByText("Corrida en curso")).toBeVisible();
    registry.set(activityAtom, AsyncResult.success({ active: null }));
  });

  it("offers no button while the inbox is already on screen", async () => {
    await page.viewport(1280, 900);
    const { screen: pending } = renderPage(NO_RUN, true);
    await using screen = await pending;
    await expect.element(screen.getByText("Todavía no hay corridas")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Abrir la bandeja" }))
      .not.toBeInTheDocument();
  });

  it("asks to choose a trend once a run has some", async () => {
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
    await expect.element(screen.getByText("Elige una tendencia")).toBeVisible();
  });
});
