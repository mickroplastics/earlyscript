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
  engineConfig: "engine.v1.json",
  engineConfigChosenAt: null,
  engineConfigs: ["engine.v1.json", "engine.v2.json", "engine.v3.json"],
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
    notices: [],
    failure: null,
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

  it("changes the engine configuration only after the operator confirms it (B1)", async () => {
    const { screen, onChange } = await renderView({});
    await using _screen = screen;
    await expect
      .element(screen.getByText("engine.v1.json, la predeterminada; nunca se cambió."))
      .toBeVisible();
    await userEvent.click(screen.getByRole("combobox", { name: "Configuración del motor" }));
    await userEvent.click(screen.getByRole("option", { name: "engine.v3.json" }));
    // Choosing opens the confirmation; nothing is saved yet.
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("combobox", { name: "Configuración del motor" }));
    await userEvent.click(screen.getByRole("option", { name: "engine.v3.json" }));
    await userEvent.click(screen.getByRole("button", { name: "Sí, usar engine.v3.json" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ engineConfig: "engine.v3.json" });
  });

  it("shows when the operator chose the configuration", async () => {
    const { screen } = await renderView({
      settings: {
        ...SETTINGS,
        engineConfig: "engine.v3.json",
        engineConfigChosenAt: "2026-11-09T05:00:00.000Z",
      },
    });
    await using _screen = screen;
    await expect
      .element(
        screen.getByText("engine.v3.json, elegida el 9 nov 2026, 00:00 (America/Guayaquil)."),
      )
      .toBeVisible();
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
        failure: { code: "check_failed" },
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
    await expect
      .element(screen.getByText("La comprobación no reprodujo la corrida."))
      .toBeVisible();
    // Only the finished job links to its run in Tendencias.
    const links = screen.getByRole("link", { name: "Ver en Tendencias" });
    await expect.element(links).toHaveAttribute("href", "/editorial/env-1/trends");
    expect(links.elements()).toHaveLength(1);
  });

  it("words failures and notices in Spanish and never shows the engine's own error", async () => {
    const engineError =
      "engine run exited with 1: ENOENT /home/mick/.t3/userdata/editorial-jobs/x/run.g2.log";
    const { screen } = await renderView({
      jobs: [
        job({
          jobId: "job-failed",
          status: "pending",
          error: engineError,
          artifacts: {
            ...job({}).artifacts,
            runId: null,
            notes: ["Backfill: 2026-10-28, 2026-10-29 had no run; captured now."],
            notices: [{ code: "missed_days", days: ["2026-10-28", "2026-10-29"] }],
            failure: { code: "engine_failed", phase: "run" },
          },
        }),
        job({
          jobId: "job-replaced",
          status: "skipped",
          artifacts: {
            ...job({}).artifacts,
            runId: null,
            notes: ["The engine configuration changed; replaced."],
            notices: [{ code: "config_changed" }],
          },
        }),
        job({
          jobId: "job-undrafted",
          artifacts: {
            ...job({}).artifacts,
            notes: ["Presentations pending: the run could not be drafted."],
            notices: [{ code: "presentations_unavailable" }],
          },
        }),
      ],
    });
    await using _screen = screen;
    for (const text of [
      "El motor de tendencias terminó con error al agrupar las publicaciones. Se reintentará más tarde.",
      "Sin corrida los días 28 oct, 29 oct: se capturaron ahora y cuentan desde este corte.",
      "Las fuentes del motor cambiaron antes de correr; la reemplaza una corrida con la configuración nueva.",
      "Redacción pendiente: no hay un modelo de texto disponible. Las tendencias se ven con sus términos.",
    ]) {
      await expect.element(screen.getByText(text)).toBeVisible();
    }
    const shown = screen.container.textContent ?? "";
    for (const raw of [engineError, "Backfill:", "replaced.", "Presentations pending", "/home/"]) {
      expect(shown).not.toContain(raw);
    }
  });
});
