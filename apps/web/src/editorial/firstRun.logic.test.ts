import { describe, expect, it } from "vite-plus/test";

import {
  DONE_JOB,
  EMPTY_JOB,
  FAILED_JOB,
  RUNNING_JOB,
  makeJob,
  phasesWith,
} from "./firstRun.fixture";
import { firstRunPhaseRows, firstRunView, phaseRowName } from "./firstRun.logic";

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
      messages: ["Falló el motor en la fase de motor."],
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
        "Redacción pendiente: no hay un modelo de texto disponible. Las tendencias se ven con sus términos.",
      ],
    });
    // The inbox read says the run holds no trend: the job's count is not trusted over it.
    expect(firstRunView({ active: null, latest: DONE_JOB, emptyRun: true }).kind).toBe("empty");
    expect(firstRunView({ active: null, latest: null, emptyRun: true })).toEqual({
      kind: "empty",
      job: null,
      messages: [],
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
    // The engine phase started at 23:01:00.
    expect(firstRunPhaseRows(quiet, "2026-11-02T23:01:30.000Z")[1]?.detail).toBeNull();
    expect(firstRunPhaseRows(quiet, "2026-11-02T23:13:00.000Z")[1]?.detail).toBe("12 min");
    expect(firstRunPhaseRows(RUNNING_JOB, "2026-11-02T23:13:00.000Z")[1]?.detail).toBe(
      "3072 de 11.913 textos",
    );
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
