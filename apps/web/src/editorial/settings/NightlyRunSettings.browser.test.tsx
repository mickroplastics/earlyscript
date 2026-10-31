import {
  EnvironmentId,
  type EditorialJob,
  type EditorialJobPhase,
  type EditorialNightlySettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NightlyRunSettingsView, type NightlyRunSettingsViewProps } from "./NightlyRunSettings";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const PHASES = ["collect", "run", "check", "import", "presentations"] as const;

const SETTINGS: EditorialNightlySettings = {
  enabled: false,
  timeOfDay: "03:00",
  timezone: "America/Guayaquil",
  workers: 2,
  nextRunAt: null,
};

const phases = (
  status: (index: number) => EditorialJobPhase["status"],
): ReadonlyArray<EditorialJobPhase> =>
  PHASES.map((phase, index) => ({
    phase,
    status: status(index),
    startedAt: status(index) === "pending" ? null : "2026-10-31T08:00:00.000Z",
    finishedAt: ["running", "pending"].includes(status(index)) ? null : "2026-10-31T08:02:00.000Z",
    note: null,
    log: null,
  }));

const job = (overrides: Partial<EditorialJob>): EditorialJob => ({
  jobId: "job-1",
  kind: "daily",
  profileHash: "sha256:profile",
  cutoffAt: "2026-10-31T00:00:00.000Z",
  configHash: "sha256:config",
  timezone: "America/Guayaquil",
  scheduledFor: "2026-10-31T08:00:00.000Z",
  startedAt: "2026-10-31T08:00:00.000Z",
  finishedAt: "2026-10-31T08:10:00.000Z",
  attempt: 1,
  status: "done",
  error: null,
  ...overrides,
  artifacts: {
    jobDir: "/state/editorial-jobs/job-1",
    corpusDir: "/data/live",
    runsDir: "/data/runs",
    sources: { collect: ["hn", "github"], rank: ["hn", "github"] },
    phases: phases(() => "done"),
    collect: null,
    runId: "run_20261031_20261031T080000_abcdef",
    runDir: null,
    dossiers: 15,
    presentations: { ready: 15, failed: 0, total: 15 },
    notes: [],
    progress: null,
    ...overrides.artifacts,
  },
});

const renderView = (props: Partial<NightlyRunSettingsViewProps>) => {
  const onChange = vi.fn();
  const onRunNow = vi.fn();
  return render(
    <NightlyRunSettingsView
      environmentId={ENVIRONMENT_ID}
      settings={SETTINGS}
      jobs={[]}
      active={null}
      starting={false}
      onChange={onChange}
      onRunNow={onRunNow}
      {...props}
    />,
  ).then((screen) => ({ screen, onChange, onRunNow }));
};

describe("NightlyRunSettings", () => {
  it("turns the nightly run on and runs today's job on demand", async () => {
    const { screen, onChange, onRunNow } = await renderView({});
    await using _screen = screen;
    await userEvent.click(screen.getByRole("switch", { name: "Corrida nocturna" }));
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Ejecutar ahora" }));
    expect(onRunNow).toHaveBeenCalledOnce();
  });

  it("holds Ejecutar ahora while a job runs and lists phases, errors and the run", async () => {
    const running = job({
      jobId: "job-2",
      status: "running",
      finishedAt: null,
      artifacts: {
        ...job({}).artifacts,
        phases: phases((index) => (index === 0 ? "done" : index === 1 ? "running" : "pending")),
        runId: null,
        progress: { phase: "run", done: 1024, total: 11913 },
      },
    });
    const failed = job({
      jobId: "job-0",
      cutoffAt: "2026-10-29T00:00:00.000Z",
      status: "failed",
      attempt: 3,
      error: "engine check did not reproduce run_x",
      artifacts: {
        ...job({}).artifacts,
        phases: phases((index) => (index < 2 ? "done" : index === 2 ? "failed" : "pending")),
      },
    });
    const { screen, onRunNow } = await renderView({
      jobs: [running, job({}), failed],
      active: running,
    });
    await using _screen = screen;
    const runNow = screen.getByRole("button", { name: "Ejecutar ahora" });
    await expect.element(runNow).toBeDisabled();
    expect(onRunNow).not.toHaveBeenCalled();
    await expect
      .element(screen.getByText("Corriendo: motor 2/5 · 1024 de 11.913 textos.").first())
      .toBeVisible();
    await expect.element(screen.getByText("engine check did not reproduce run_x")).toBeVisible();
    // Only the finished job links to its run in Tendencias.
    const links = screen.getByRole("link", { name: "Ver en Tendencias" });
    await expect.element(links).toHaveAttribute("href", "/editorial/env-1/trends");
    expect(links.elements()).toHaveLength(1);
  });
});
