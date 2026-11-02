import { describe, expect, it } from "vite-plus/test";

import {
  DONE_JOB,
  EMPTY_JOB,
  FAILED_JOB,
  RUNNING_JOB,
  makeJob,
  phasesWith,
} from "./firstRun.fixture";
import {
  IMPORTED_EMPTY_TEXT,
  draftingProblem,
  firstRunPhaseRows,
  firstRunView,
  minuteClockMs,
  phaseRowName,
} from "./firstRun.logic";

describe("firstRunView", () => {
  it("offers the first run when no job exists", () => {
    expect(firstRunView({ active: null, latest: null, emptyRun: false })).toEqual({
      kind: "idle",
    });
  });

  it("follows the job in flight over the newest of the list", () => {
    expect(firstRunView({ active: RUNNING_JOB, latest: FAILED_JOB, emptyRun: false })).toEqual({
      kind: "running",
      job: RUNNING_JOB,
    });
  });

  it("treats a due job without a failure as running, and one waiting to retry as failed", () => {
    const due = makeJob({ status: "pending", startedAt: null });
    expect(firstRunView({ active: null, latest: due, emptyRun: false }).kind).toBe("running");
    const retry = makeJob({
      status: "pending",
      artifacts: { failure: { code: "collect_locked" } },
    });
    const view = firstRunView({ active: null, latest: retry, emptyRun: false });
    expect(view).toMatchObject({ kind: "failed" });
    expect(view.kind === "failed" && view.messages).toEqual([
      "Otra captura estaba usando el corpus. Se reintentará más tarde.",
    ]);
  });

  it("leaves the missed days to the nightly history", () => {
    const first = makeJob({
      status: "failed",
      artifacts: {
        failure: { code: "check_failed" },
        notices: [{ code: "missed_days", days: ["2026-10-31"] }],
      },
    });
    expect(firstRunView({ active: null, latest: first, emptyRun: false })).toMatchObject({
      messages: ["La comprobación no reprodujo la corrida."],
    });
  });

  it("words the failure in Spanish, never the technical error", () => {
    const view = firstRunView({ active: null, latest: FAILED_JOB, emptyRun: false });
    expect(view).toEqual({
      kind: "failed",
      job: FAILED_JOB,
      messages: ["El motor de tendencias terminó con error al agrupar las publicaciones."],
    });
  });

  it("says why a finished job left no trend", () => {
    const view = firstRunView({ active: null, latest: EMPTY_JOB, emptyRun: true });
    expect(view).toMatchObject({
      kind: "empty",
      messages: ["El motor no formó ninguna tendencia con 1284 publicaciones capturadas."],
    });
    const nothingCaptured = makeJob({
      status: "done",
      artifacts: {
        collect: {
          sources: ["hn"],
          fromDay: "2026-11-01",
          toDay: "2026-11-02",
          items: 0,
          incomplete: 0,
          missedDays: [],
        },
        dossiers: 0,
      },
    });
    expect(firstRunView({ active: null, latest: nothingCaptured, emptyRun: false })).toMatchObject({
      kind: "empty",
      messages: ["La captura no trajo publicaciones entre el 1 nov y el 2 nov."],
    });
  });

  it("waits for the inbox once a job imported trends, and reports an older empty run", () => {
    expect(firstRunView({ active: null, latest: DONE_JOB, emptyRun: false })).toEqual({
      kind: "done",
      job: DONE_JOB,
      messages: [
        "No hay un proveedor de modelos disponible: las tendencias están en la bandeja sin redactar. Conecta uno en Ajustes › Proveedores y redáctalas desde la bandeja.",
      ],
    });
    // The inbox read says the run holds no trend: the job's count is not trusted over it.
    expect(firstRunView({ active: null, latest: DONE_JOB, emptyRun: true }).kind).toBe("empty");
    // A run with no job of this server: say so and let a new run start.
    expect(firstRunView({ active: null, latest: null, emptyRun: true })).toEqual({
      kind: "empty",
      job: null,
      messages: [IMPORTED_EMPTY_TEXT],
      canRun: true,
    });
    // Until the job list arrives, nothing is claimed and nothing is offered.
    expect(firstRunView({ active: null, latest: null, emptyRun: true, jobsKnown: false })).toEqual({
      kind: "empty",
      job: null,
      messages: [],
      canRun: false,
    });
    expect(firstRunView({ active: null, latest: EMPTY_JOB, emptyRun: true })).toMatchObject({
      canRun: false,
    });
  });
});

describe("firstRunPhaseRows", () => {
  it("lists the five phases in order before the job records any", () => {
    const rows = firstRunPhaseRows(null);
    expect(rows.map((row) => [row.label, row.status])).toEqual([
      ["Captura", "pending"],
      ["Motor", "pending"],
      ["Comprobación", "pending"],
      ["Importación", "pending"],
      ["Redacción", "pending"],
    ]);
  });

  it("shows live progress on the running phase and what each finished phase produced", () => {
    const rows = firstRunPhaseRows(RUNNING_JOB);
    expect(rows[0]).toMatchObject({ status: "done", detail: "1284 publicaciones · 40 s" });
    expect(rows[1]).toMatchObject({ status: "running", detail: "3072 de 11.913 textos" });
    expect(phaseRowName(rows[1]!)).toBe("Motor: en curso, 3072 de 11.913 textos");
    expect(phaseRowName(rows[2]!)).toBe("Comprobación: pendiente");
  });

  it("gives the running phase its elapsed time until the engine reports a count", () => {
    const quiet = makeJob({
      artifacts: {
        phases: phasesWith((index) => (index === 0 ? "done" : index === 1 ? "running" : "pending")),
      },
    });
    // The engine phase started at 23:01:00 UTC.
    expect(firstRunPhaseRows(quiet, Date.parse("2026-11-02T23:01:30.000Z"))[1]?.detail).toBeNull();
    expect(firstRunPhaseRows(quiet, Date.parse("2026-11-02T23:13:00.000Z"))[1]?.detail).toBe(
      "12 min",
    );
    expect(firstRunPhaseRows(RUNNING_JOB, Date.parse("2026-11-02T23:13:00.000Z"))[1]?.detail).toBe(
      "3072 de 11.913 textos",
    );
  });

  it("reads the minute clock as UTC whatever the machine's zone", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Guayaquil";
    try {
      // `Date.parse` reads this form as local time: five hours off in Guayaquil.
      expect(Date.parse("2026-11-02T23:01") - Date.parse("2026-11-02T23:01:00.000Z")).toBe(
        5 * 3_600_000,
      );
      expect(minuteClockMs("2026-11-02T23:01")).toBe(Date.parse("2026-11-02T23:01:00.000Z"));
      expect(minuteClockMs("2026-11-02T23:01:00.000Z")).toBe(
        Date.parse("2026-11-02T23:01:00.000Z"),
      );
      const quiet = makeJob({
        artifacts: {
          phases: phasesWith((index) => (index === 0 ? "running" : "pending")),
        },
      });
      // Capture started at 23:00:00 UTC; one minute later it shows "60 s", not "5 h".
      expect(firstRunPhaseRows(quiet, minuteClockMs("2026-11-02T23:00"))[0]?.detail).toBeNull();
      expect(firstRunPhaseRows(quiet, minuteClockMs("2026-11-02T23:01"))[0]?.detail).toBe("60 s");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("keeps one part of a finished phase's detail for the narrow panel", () => {
    const rows = firstRunPhaseRows(RUNNING_JOB);
    expect(rows[0]?.compactDetail).toBe("1284 publicaciones");
  });

  it("counts trends and drafted presentations", () => {
    const job = makeJob({
      status: "done",
      artifacts: {
        phases: phasesWith(() => "done"),
        dossiers: 1,
        presentations: { ready: 14, failed: 1, total: 15 },
      },
    });
    const rows = firstRunPhaseRows(job);
    expect(rows[1]?.detail).toBe("1 tendencia · 40 s");
    expect(rows[3]?.detail).toBe("40 s");
    expect(rows[4]?.detail).toBe("14 de 15 redactadas · 40 s");
  });
});

const DONE_JOB_DRAFTED = makeJob({
  status: "done",
  artifacts: { runId: "run_x", dossiers: 10, presentations: { ready: 10, failed: 0, total: 10 } },
});

describe("draftingProblem", () => {
  const drafted = (ready: number, code: "presentations_pending" | "presentations_unavailable") =>
    makeJob({
      status: "done",
      artifacts: {
        phases: phasesWith(() => "done"),
        runId: "run_x",
        dossiers: 10,
        presentations: { ready, failed: 10 - ready, total: 10 },
        notices: [{ code, ready, total: 10 }],
      },
    });

  it("says no text model is available and where to connect one", () => {
    expect(draftingProblem(drafted(0, "presentations_unavailable"))?.short).toBe(
      "Tendencias sin redactar: no hay un proveedor de modelos disponible.",
    );
  });

  it("tells a provider that drafted nothing from one that drafted some", () => {
    const none = drafted(0, "presentations_pending");
    expect(draftingProblem(none)?.short).toBe(
      "Tendencias sin redactar: el proveedor de modelos no respondió.",
    );
    expect(firstRunView({ active: null, latest: none, emptyRun: false })).toMatchObject({
      kind: "done",
      messages: [
        "El proveedor de modelos no redactó ninguna de las 10 tendencias (sin sesión o sin acceso al modelo): están en la bandeja sin redactar. Revisa la sesión en Ajustes › Proveedores y redáctalas desde la bandeja.",
      ],
    });
    expect(firstRunPhaseRows(none)[4]).toMatchObject({ status: "done", warning: true });
    expect(draftingProblem(drafted(6, "presentations_pending"))?.short).toBe(
      "Faltan 4 de 10 tendencias por redactar.",
    );
    expect(draftingProblem(DONE_JOB_DRAFTED)).toBeNull();
  });
});
