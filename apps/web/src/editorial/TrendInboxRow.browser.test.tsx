import { EditorialDossierId, EditorialRunId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { SidebarMenu, SidebarProvider } from "../components/ui/sidebar";
import { TrendInboxRow, TrendSparkline } from "./TrendInboxRow";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");

const QUANTUM = {
  dossierId: EditorialDossierId.make("dos_bbb80d57481e"),
  runId: RUN_ID,
  label: "quantum computing ibm open",
  terms: ["quantum", "computing"],
  subtitle: "Designing more efficient quantum circuits with Claude",
  stage: "growing",
  corroboration: "single_source",
  items7d: 11,
  items28d: 38,
  authors7d: 11,
  volumeRank: 2,
  scoreRank: 13,
  score: 1.026179,
  growth: 0.69,
  affinity: 0.608747,
  sourceCount: 1,
  sources: ["hn"],
  sparkline: [2, 2, 1, 0, 0, 0, 0, 2, 0, 1, 5, 2, 0, 1],
  isNew: true,
};

describe("TrendSparkline", () => {
  it("draws a day without capture apart from a quiet day", async () => {
    await using screen = await render(<TrendSparkline values={[0, null, 4]} />, {
      // A plain SVG needs no router.
      router: false,
    });
    const [quiet, missing, busy] = Array.from(screen.container.querySelectorAll("rect"));
    expect(quiet?.getAttribute("height")).toBe("1");
    expect(missing?.getAttribute("height")).toBe("12");
    expect(missing?.getAttribute("class")).not.toBe(quiet?.getAttribute("class"));
    expect(busy?.getAttribute("height")).toBe("12");
  });
});

describe("TrendInboxRow", () => {
  it("links to the dossier of its run and marks the open one like a selected thread", async () => {
    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarMenu>
          <TrendInboxRow environmentId={ENVIRONMENT_ID} trend={QUANTUM} isActive />
        </SidebarMenu>
      </SidebarProvider>,
    );
    const link = screen.getByRole("link", { name: /quantum computing ibm open/ });
    await expect.element(link).toHaveAttribute("aria-current", "page");
    await expect
      .element(link)
      .toHaveAttribute("href", `/editorial/env-1/trends/dos_bbb80d57481e?run=${RUN_ID}`);
    expect(link.element().textContent).toContain("11 publ. · 11 autores · puntaje #13");
  });

  it("shows the assistant's title in place of the engine label and keeps the terms reachable", async () => {
    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarMenu>
          <TrendInboxRow
            environmentId={ENVIRONMENT_ID}
            trend={{
              ...QUANTUM,
              presentation: {
                title: "IBM abre su pila de computación cuántica",
                summary: { whatHappened: "a", whyItMatters: "b", videoAngle: "c" },
                citedItemIds: [],
                provider: "claudeAgent",
                model: "claude-haiku-5-5",
                promptVersion: "trend-presentation.v2",
                generatedAt: "2026-10-31T12:00:00.000Z",
              },
            }}
            isActive={false}
          />
        </SidebarMenu>
      </SidebarProvider>,
    );
    const title = screen.container.querySelector("[data-presentation-title]");
    expect(title?.textContent).toBe("IBM abre su pila de computación cuántica");
    const link = screen.getByRole("link", { name: /IBM abre su pila/ });
    // Screen readers get the engine's words too; sighted users get them on hover.
    expect(link.element().textContent).toContain("Términos del motor: quantum computing ibm open.");
    await userEvent.hover(title as HTMLElement);
    await expect
      .element(
        screen.getByText(
          "Redactado por el asistente · términos del motor: quantum computing ibm open",
        ),
      )
      .toBeVisible();
  });
});
