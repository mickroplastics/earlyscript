import { RegistryContext } from "@effect/atom-react";
import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  EnvironmentId,
  type EditorialInbox,
  type EditorialJob,
  type EditorialJobActivity,
  type EditorialJobsList,
  type EditorialNightlySettings,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { EMPTY_JOB, NIGHTLY_OFF } from "./firstRun.fixture";
import type { EditorialInboxView } from "./state";
import { TrendInbox } from "./TrendInbox";

const state = vi.hoisted(() => ({ refetches: [] as Array<string> }));

// The read and the subscription as plain atoms, so the test drives what each one holds.
const readAtom = Atom.make<AsyncResult.AsyncResult<EditorialInbox>>(AsyncResult.initial());
const liveAtom = Atom.make<AsyncResult.AsyncResult<EditorialInboxView>>(AsyncResult.initial());
const activityAtom = Atom.make<AsyncResult.AsyncResult<EditorialJobActivity>>(
  AsyncResult.success({ active: null }),
);
const settingsAtom = Atom.make<AsyncResult.AsyncResult<EditorialNightlySettings>>(
  AsyncResult.success(NIGHTLY_OFF),
);
const listAtom = Atom.make<AsyncResult.AsyncResult<EditorialJobsList>>(
  AsyncResult.success({ jobs: [] }),
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
    refreshEditorialInbox: (_registry: unknown, environmentId: string) => {
      state.refetches.push(environmentId);
    },
  };
});
vi.mock("./jobsState", async () => {
  const actual = await vi.importActual<typeof import("./jobsState")>("./jobsState");
  const Effect = await vi.importActual<typeof import("effect/Effect")>("effect/Effect");
  return {
    ...actual,
    editorialJobsEnvironment: {
      ...actual.editorialJobsEnvironment,
      activity: () => activityAtom,
      settings: () => settingsAtom,
      list: () => listAtom,
    },
    refreshJobsList: () => Effect.void,
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

const PHASES = ["collect", "run", "check", "import", "presentations"] as const;

/** A nightly job past its capture and embedding its third thousand texts. */
const embeddingJob = (): EditorialJob => ({
  jobId: "job-1",
  kind: "daily",
  profileHash: "sha256:profile",
  cutoffAt: "2026-10-31T00:00:00.000Z",
  configHash: "sha256:config",
  timezone: "America/Guayaquil",
  scheduledFor: "2026-10-31T08:00:00.000Z",
  startedAt: "2026-10-31T08:00:00.000Z",
  finishedAt: null,
  attempt: 1,
  status: "running",
  error: null,
  artifacts: {
    jobDir: "/state/editorial-jobs/job-1",
    corpusDir: "/data/live",
    runsDir: "/data/runs",
    sources: { collect: ["hn", "github"], rank: ["hn", "github"] },
    phases: PHASES.map((phase, index) => ({
      phase,
      status: index === 0 ? "done" : index === 1 ? "running" : "pending",
      startedAt: index < 2 ? "2026-10-31T08:00:00.000Z" : null,
      finishedAt: index === 0 ? "2026-10-31T08:00:40.000Z" : null,
      note: null,
      log: null,
    })),
    collect: null,
    runId: null,
    runDir: null,
    dossiers: null,
    presentations: null,
    notes: [],
    notices: [],
    failure: null,
    progress: { phase: "run", done: 3072, total: 11913 },
  },
});

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

  it("shows the nightly job in the header while it runs and refetches the inbox when it ends", async () => {
    setup();
    const registry = AtomRegistry.make();
    const run19 = inboxOf("19", ["alpha"]);
    registry.set(readAtom, AsyncResult.success(run19));
    registry.set(liveAtom, AsyncResult.success({ seq: 1, inbox: run19 }));
    registry.set(activityAtom, AsyncResult.success({ active: embeddingJob() }));
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <SidebarProvider defaultOpen>
          <TrendInbox environmentId={ENVIRONMENT_ID} activeDossierId={null} />
        </SidebarProvider>
      </RegistryContext.Provider>,
    );
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Corriendo: motor 2/5 · 3072 de 11.913 textos…");
    expect(state.refetches).toEqual([]);

    await act(() => registry.set(activityAtom, AsyncResult.success({ active: null })));
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    expect(state.refetches).toEqual([ENVIRONMENT_ID]);
  });

  it("names the first review in the header while it runs, and leaves its phases to the page", async () => {
    setup();
    const registry = AtomRegistry.make();
    const none: EditorialInbox = { ...inboxOf("19", []), run: null };
    registry.set(readAtom, AsyncResult.success(none));
    registry.set(liveAtom, AsyncResult.success({ seq: 1, inbox: none }));
    registry.set(activityAtom, AsyncResult.success({ active: null }));
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <SidebarProvider defaultOpen>
          <TrendInbox environmentId={ENVIRONMENT_ID} activeDossierId={null} />
        </SidebarProvider>
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText("Tendencias", { exact: true })).toBeVisible();
    expect(screen.getByRole("button").elements()).toHaveLength(0);

    await act(() => registry.set(activityAtom, AsyncResult.success({ active: embeddingJob() })));
    await expect.element(screen.getByText("Primera revisión")).toBeVisible();
    await expect.element(screen.getByText("Buscando tendencias…")).toBeVisible();
    expect(screen.getByRole("list", { name: "Fases de la revisión" }).elements()).toHaveLength(0);
    registry.set(activityAtom, AsyncResult.success({ active: null }));
  });

  it.each([
    [
      { code: "presentations_provider_disabled", ready: 0, total: 2 } as const,
      "Tendencias sin redactar: el proveedor de modelos está desactivado.",
      "Abrir Ajustes › Proveedores",
      "/settings/providers",
    ],
    [
      { code: "presentations_budget", ready: 0, total: 2, used: 600, limit: 600 } as const,
      "Tope mensual alcanzado: 2 tendencias sin redactar.",
      "Abrir Ajustes › Editorial › Redacción",
      "/settings/editorial#editorial-drafting",
    ],
    [
      { code: "presentations_pending", ready: 0, total: 2 } as const,
      "Tendencias sin redactar: el proveedor de modelos no respondió.",
      "Abrir Ajustes › Proveedores",
      "/settings/providers",
    ],
  ])(
    "says over the list why the run's trends were left undrafted (%o)",
    async (notice, text, link, href) => {
      setup();
      const registry = AtomRegistry.make();
      const run02 = inboxOf("02", ["alpha", "beta"]);
      registry.set(readAtom, AsyncResult.success(run02));
      registry.set(liveAtom, AsyncResult.success({ seq: 1, inbox: run02 }));
      registry.set(activityAtom, AsyncResult.success({ active: null }));
      registry.set(
        listAtom,
        AsyncResult.success({
          jobs: [
            {
              ...EMPTY_JOB,
              artifacts: {
                ...EMPTY_JOB.artifacts,
                runId: run02.run!.runId,
                dossiers: 2,
                presentations: null,
                notices: [notice],
              },
            },
          ],
        }),
      );
      await using screen = await render(
        <RegistryContext.Provider value={registry}>
          <SidebarProvider defaultOpen>
            <TrendInbox environmentId={ENVIRONMENT_ID} activeDossierId={null} />
          </SidebarProvider>
        </RegistryContext.Provider>,
      );
      await expect.element(screen.getByTestId("drafting-notice")).toBeVisible();
      await expect.element(screen.getByText(text)).toBeVisible();
      await expect.element(screen.getByRole("link", { name: link })).toHaveAttribute("href", href);
      registry.set(listAtom, AsyncResult.success({ jobs: [] }));
    },
  );
});
