import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { EditorialSidebar } from "./EditorialSidebar";
import { useSpaceStore } from "./spaceStore";

// Each list as a marker; upstream's thread sidebar carries the shared footer, as the real one.
vi.mock(import("../components/sidebar/SidebarChrome"), async () => {
  const { SidebarMenu } = await import("../components/ui/sidebar");
  const { ResultsSidebarButton } = await import("./results/ResultsSidebarButton");
  return {
    SidebarChromeHeader: () => null,
    SidebarChromeFooter: () => (
      <SidebarMenu>
        <ResultsSidebarButton />
      </SidebarMenu>
    ),
  } as never;
});

vi.mock(import("../components/Sidebar"), async () => {
  const { SidebarChromeFooter } = await import("../components/sidebar/SidebarChrome");
  return {
    default: () => (
      <>
        <p>Lista de hilos</p>
        <SidebarChromeFooter />
      </>
    ),
  } as never;
});

vi.mock(import("./TrendInbox"), async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    TrendInbox: () => <p>Lista de tendencias</p>,
    useTrendInbox: () => AsyncResult.initial(),
  } as never;
});

vi.mock(import("./NewManualThreadButton"), () => ({ NewManualThreadButton: () => <></> }));
vi.mock(import("./FinishSetupEntry"), () => ({ FinishSetupEntry: () => <></> }) as never);
vi.mock(import("./locale/ShellLocale"), () => ({ useSidebarLocale: () => {} }) as never);
vi.mock(
  import("../state/environments"),
  () =>
    ({
      usePrimaryEnvironmentId: () => "env-1",
      readPrimaryEnvironmentId: () => "env-1",
    }) as never,
);

const STORAGE_KEY = "earlyscript:space:v1";
const THREAD = "/env-1/thread-1";
const RESULTS = "/editorial/env-1/results";

/** The app's route ids under `_chat`, so the sidebar reads the space the real routes give. */
function sidebarRouter(path: string) {
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <EditorialSidebar routeReveal={null as never} />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const page = (routePath: string) =>
    createRoute({ getParentRoute: () => chat, path: routePath, component: () => null });
  return createRouter({
    routeTree: root.addChildren([
      chat.addChildren([
        page("$environmentId/$threadId"),
        page("editorial/$environmentId/trends"),
        page("editorial/$environmentId/results"),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

async function renderSidebar(path: string) {
  const router = sidebarRouter(path);
  // The sidebar needs the app's route ids, which the shared test router does not have.
  const screen = await render(<RouterProvider router={router} />, { router: false });
  return Object.assign(screen, { router });
}

function setup(stored: unknown) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  return useSpaceStore.persist.rehydrate();
}

describe("EditorialSidebar", () => {
  it("keeps the open list on Results, marks Results below, and its tab leads back", async () => {
    await setup({
      state: { byEnvironment: { "env-1": { space: "trends", trend: null } }, threadsHref: THREAD },
      version: 2,
    });
    await using screen = await renderSidebar(RESULTS);
    const results = screen.getByRole("link", { name: "Resultados" });
    await expect.element(results).toHaveAttribute("aria-current", "page");
    expect(
      screen
        .getByRole("button")
        .elements()
        .map((tab) => tab.textContent),
    ).toEqual(["Hilos", "Tendencias"]);
    await expect
      .element(screen.getByRole("button", { name: "Tendencias" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Lista de tendencias")).toBeVisible();

    // The tab of the list on screen still leaves Results for its space.
    await userEvent.click(screen.getByRole("button", { name: "Tendencias" }));
    await vi.waitFor(() =>
      expect(screen.router.state.location.pathname).toBe("/editorial/env-1/trends"),
    );
    await expect.element(results).not.toHaveAttribute("aria-current");
    await expect.element(screen.getByText("Lista de tendencias")).toBeVisible();
  });

  it("shows the Threads list for a Results space stored by an earlier version", async () => {
    await setup({
      state: { byEnvironment: { "env-1": { space: "results", trend: null } }, threadsHref: THREAD },
      version: 1,
    });
    expect(useSpaceStore.getState().byEnvironment["env-1"]?.space).toBe("threads");
    await using screen = await renderSidebar(RESULTS);
    await expect.element(screen.getByText("Lista de hilos")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Hilos" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("link", { name: "Resultados" }))
      .toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: "Hilos" }));
    await vi.waitFor(() => expect(screen.router.state.location.pathname).toBe(THREAD));
    await expect
      .element(screen.getByRole("link", { name: "Resultados" }))
      .not.toHaveAttribute("aria-current");
  });
});
