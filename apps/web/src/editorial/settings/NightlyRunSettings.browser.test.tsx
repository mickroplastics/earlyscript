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
import { nightlyState } from "./editorialStatus.logic";
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
  engineConfigs: ["engine.v1.json", "engine.v2.json", "engine.v3-sel.json", "engine.v3.json"],
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

/** 31 oct 2026, 18:00 in Guayaquil: after the night of the 31st ran. */
const NOW = Date.parse("2026-10-31T23:00:00.000Z");

const renderView = (props: Partial<NightlyRunSettingsViewProps>) => {
  const onChange = vi.fn();
  const onRunNow = vi.fn();
  const settings = props.settings ?? SETTINGS;
  const jobs = props.jobs ?? [];
  const active = props.active ?? null;
  return render(
    <NightlyRunSettingsView
      environmentId={ENVIRONMENT_ID}
      settings={settings}
      jobs={jobs}
      active={active}
      state={nightlyState({ settings, jobs, active, now: NOW })}
      sources={null}
      model={null}
      now={NOW}
      starting={false}
      onChange={onChange}
      onRunNow={onRunNow}
      {...props}
    />,
  ).then((screen) => ({ screen, onChange, onRunNow }));
};

const ENABLED: EditorialNightlySettings = {
  ...SETTINGS,
  enabled: true,
  nextRunAt: "2026-11-01T08:00:00.000Z",
};

describe("NightlyRunSettings", () => {
  it("turns the nightly review on, and offers to review now while none has run", async () => {
    const { screen, onChange, onRunNow } = await renderView({});
    await using _screen = screen;
    await userEvent.click(screen.getByRole("switch", { name: "Revisar cada noche" }));
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Revisar ahora" }));
    expect(onRunNow).toHaveBeenCalledOnce();
  });

  it("says the review is current and still offers «Revisar ahora»", async () => {
    const { screen } = await renderView({ settings: ENABLED, jobs: [job({})] });
    await using _screen = screen;
    await expect.element(screen.getByText("Al día")).toBeVisible();
    await expect
      .element(screen.getByText(/^Hoy a las 03:10 encontró 15 tendencias · tardó 10 min/))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Ver tendencias" }))
      .toHaveAttribute("href", "/editorial/env-1/trends");
    // A new method or profile makes `runNow` start another job, so the button stays.
    await expect.element(screen.getByRole("button", { name: "Revisar ahora" })).toBeVisible();
    await expect
      .element(
        screen.getByText("Próxima: mañana a las 03:00, hora de Guayaquil.", { exact: false }),
      )
      .toBeVisible();
  });

  it("offers «Reintentar» after a failure and says from which step it goes on", async () => {
    const failed = job({
      jobId: "job-2",
      cutoffAt: "2026-10-31T00:00:00.000Z",
      status: "failed",
      attempt: 3,
      error: "engine run exited with 1: ENOENT /home/mick/.t3/userdata/run.log",
      artifacts: {
        ...job({}).artifacts,
        runId: null,
        phases: phases((index) => (index === 0 ? "done" : index === 1 ? "failed" : "pending")),
        failure: { code: "engine_failed", phase: "run" },
      },
    });
    const yesterday = job({
      jobId: "job-1",
      cutoffAt: "2026-10-30T00:00:00.000Z",
      startedAt: "2026-10-30T08:00:00.000Z",
      finishedAt: "2026-10-30T08:10:00.000Z",
      artifacts: { ...job({}).artifacts, dossiers: 11 },
    });
    const { screen, onRunNow } = await renderView({ settings: ENABLED, jobs: [failed, yesterday] });
    await using _screen = screen;
    await expect.element(screen.getByText("La revisión de hoy falló")).toBeVisible();
    await expect
      .element(screen.getByText("Siguen disponibles las 11 tendencias de ayer."))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Falló al agrupar las publicaciones. «Reintentar» sigue desde ahí; lo capturado no se repite.",
        ),
      )
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRunNow).toHaveBeenCalledOnce();
    const shown = screen.container.textContent ?? "";
    for (const raw of ["ENOENT", "/home/", "motor", "corrida", "corte"]) {
      expect(shown).not.toContain(raw);
    }
  });

  it("shows the review in flight step by step, with no way to start another", async () => {
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
    const { screen } = await renderView({ settings: ENABLED, jobs: [running], active: running });
    await using _screen = screen;
    await expect.element(screen.getByText("Revisando…")).toBeVisible();
    await expect.element(screen.getByText("1.024 de 11.913")).toBeVisible();
    await expect.element(screen.getByText("En curso")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Revisar ahora|Reintentar/ }))
      .not.toBeInTheDocument();
  });

  it("opens the method dialog on the evaluated method and changes it only when confirmed", async () => {
    const { screen, onChange } = await renderView({
      settings: {
        ...ENABLED,
        engineConfig: "engine.v3-sel.json",
        engineConfigChosenAt: "2026-11-09T08:13:00.000Z",
      },
    });
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: /Avanzado/ }));
    await expect
      .element(screen.getByText(/^El método evaluado \(v3\), fijado el 9 nov 2026, 03:13\./))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cambiar…" }));
    await expect.element(screen.getByRole("radio", { name: /Método evaluado/ })).toBeChecked();
    const confirm = screen.getByRole("button", { name: "Cambiar", exact: true });
    await expect.element(confirm).toBeDisabled();
    // Only v3 and v1 by name; the rest of the installed files wait behind «Otras instaladas».
    await expect
      .element(screen.getByRole("radio", { name: /engine\.v2\.json/ }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Otras instaladas (2)" }));
    await expect.element(screen.getByRole("radio", { name: /engine\.v2\.json/ })).toBeVisible();
    await userEvent.click(screen.getByRole("radio", { name: /Método original/ }));
    await expect
      .element(screen.getByRole("alertdialog"))
      .toMatchTextContent("si hoy queda una revisión pendiente, se rehace con él");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(confirm);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ engineConfig: "engine.v1.json" });
    // Opening it again starts on the evaluated method, whatever was picked before.
    await userEvent.click(screen.getByRole("button", { name: "Cambiar…" }));
    await expect.element(screen.getByRole("radio", { name: /Método evaluado/ })).toBeChecked();
  });
});
