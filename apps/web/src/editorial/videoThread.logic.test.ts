import { EditorialVideoError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DECIDED, JUST_CREATED, MANUAL_EXPLORING, WRITING } from "./videoThread.fixture";
import {
  EMPTY_DECISION_DRAFT,
  decisionBlockState,
  draftRequestPaths,
  draftRequestPrompt,
  emptyResultDraft,
  formatClock,
  formatStageDuration,
  interpolateClock,
  parseResultDraft,
  resolvedEndIso,
  restartStage,
  shortHash,
  videoFailureReason,
  videoFailureText,
} from "./videoThread.logic";

const MINUTE = 60_000;
const RECEIVED = Date.parse("2026-10-31T13:09:00.000Z");

describe("work clock display", () => {
  it("formats minutes and seconds, and hours past the hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(59_999)).toBe("00:59");
    expect(formatClock(28 * MINUTE + 14_000)).toBe("28:14");
    expect(formatClock(61 * MINUTE + 5_000)).toBe("1:01:05");
    expect(formatClock(-5)).toBe("00:00");
    expect(formatStageDuration(null)).toBe("sin registro");
    expect(formatStageDuration(0)).toBe("00:00");
  });

  it("moves a running clock forward by the client's own elapsed time", () => {
    const now = RECEIVED + 75_000;
    expect(interpolateClock(WRITING.clock, RECEIVED, now)).toEqual({
      activeMs: 9 * MINUTE + 75_000,
      stageMs: 4 * MINUTE + 75_000,
    });
    // A client clock behind the moment it received the summary never subtracts.
    expect(interpolateClock(WRITING.clock, RECEIVED, RECEIVED - 10_000).activeMs).toBe(9 * MINUTE);
  });

  it("holds a paused or stopped clock", () => {
    const paused = {
      ...WRITING.clock,
      state: { _tag: "paused" as const, stage: "write" as const, since: WRITING.clock.asOf },
    };
    expect(interpolateClock(paused, RECEIVED, RECEIVED + 10 * MINUTE)).toEqual({
      activeMs: 9 * MINUTE,
      stageMs: 4 * MINUTE,
    });
    expect(interpolateClock(DECIDED.clock, RECEIVED, RECEIVED + MINUTE)).toEqual({
      activeMs: 9 * MINUTE,
      stageMs: null,
    });
  });

  it("restarts in the stage the clock left, else the first of the mode", () => {
    expect(restartStage("assisted", DECIDED.clock)).toBe("write");
    const fresh = { ...DECIDED.clock, stages: [] };
    expect(restartStage("assisted", fresh)).toBe("read");
    expect(restartStage("manual", fresh)).toBe("explore");
    const recovered = {
      ...fresh,
      unresolved: [
        { intervalId: "i-1", stage: "decide" as const, startedAt: "x", recoveredAt: null },
      ],
    };
    expect(restartStage("assisted", recovered)).toBe("decide");
  });

  it("clamps a typed end into the recovered segment", () => {
    const interval = {
      startedAt: "2026-10-31T13:00:30.000Z",
      recoveredAt: "2026-10-31T14:00:00.000Z",
    };
    const iso = (local: Date) => resolvedEndIso(local.toISOString(), interval);
    expect(iso(new Date("2026-10-31T13:20:00.000Z"))).toBe("2026-10-31T13:20:00.000Z");
    expect(iso(new Date("2026-10-31T13:00:00.000Z"))).toBe(interval.startedAt);
    expect(iso(new Date("2026-10-31T15:00:00.000Z"))).toBe(interval.recoveredAt);
    expect(resolvedEndIso("not a date", interval)).toBeNull();
  });
});

describe("decision block", () => {
  it("asks for an action, a utility and, to edit or reject, a reason", () => {
    const open = (draft = EMPTY_DECISION_DRAFT) => decisionBlockState(WRITING, draft, undefined);
    expect(open()).toEqual({
      _tag: "open",
      versionHash: "9f2c1ab07d3e4c55aa10",
      problem: "Elige una acción.",
    });
    expect(open({ action: "accept", utility: null, reason: "" })).toMatchObject({
      problem: "Elige la utilidad de 1 a 5.",
    });
    expect(open({ action: "reject", utility: 2, reason: "  " })).toMatchObject({
      problem: "El motivo es obligatorio para rechazar.",
    });
    expect(open({ action: "accept", utility: 5, reason: "" })).toMatchObject({ problem: null });
    expect(open({ action: "edit", utility: 4, reason: "Falta una voz crítica" })).toMatchObject({
      problem: null,
    });
  });

  it("refuses a script on disk that was never versioned", () => {
    const unversioned = { ...WRITING, script: { ...WRITING.script, head: null, versionCount: 0 } };
    expect(
      decisionBlockState(unversioned, { action: "accept", utility: 4, reason: "" }, undefined),
    ).toEqual({
      _tag: "open",
      versionHash: null,
      problem: "Guarda una versión del guion para decidir sobre ella.",
    });
  });

  it("names both versions after a refusal, and waits for the new one", () => {
    const draft = { action: "accept" as const, utility: 4, reason: "" };
    expect(decisionBlockState(WRITING, draft, "9f2c1ab07d3e4c55aa10")).toEqual({
      _tag: "version-changed",
      from: "9f2c1ab07d3e4c55aa10",
      to: null,
    });
    const moved = {
      ...WRITING,
      script: {
        ...WRITING.script,
        head: { ...WRITING.script.head!, contentHash: "b71e00aa", versionId: "version-2" },
      },
    };
    expect(decisionBlockState(moved, draft, "9f2c1ab07d3e4c55aa10")).toEqual({
      _tag: "version-changed",
      from: "9f2c1ab07d3e4c55aa10",
      to: "b71e00aa",
    });
  });

  it("waits for a recovered segment's resolution before offering the form", () => {
    const recovered = {
      ...WRITING,
      clock: {
        ...WRITING.clock,
        unresolved: [
          { intervalId: "interval-1", stage: "write" as const, startedAt: "x", recoveredAt: null },
        ],
      },
    };
    expect(decisionBlockState(recovered, EMPTY_DECISION_DRAFT, undefined)).toEqual({
      _tag: "unresolved",
      intervalId: "interval-1",
    });
    expect(
      videoFailureText(new EditorialVideoError({ reason: "clock-unresolved", message: "x" })),
    ).toBe("Resuelve el tramo abierto antes de decidir.");
  });

  it("is read-only once decided, whatever the draft says", () => {
    expect(decisionBlockState(DECIDED, EMPTY_DECISION_DRAFT, "anything")).toEqual({
      _tag: "decided",
      decision: DECIDED.decision,
    });
  });

  it("shortens hashes and names failures in Spanish", () => {
    expect(shortHash("sha256:9f2c1ab07d3e4c55")).toBe("9f2c1ab0");
    const changed = new EditorialVideoError({ reason: "version-changed", message: "x" });
    expect(videoFailureReason(changed)).toBe("version-changed");
    expect(videoFailureText(changed)).toBe("El guion cambió después de la versión que leíste.");
    expect(
      videoFailureText(new EditorialVideoError({ reason: "script-file", message: "Gone." })),
    ).toBe("No se pudo leer el archivo del guion. Gone.");
    expect(videoFailureReason(new Error("socket closed"))).toBeNull();
  });

  it("shows a launch failure's own text and keeps storage details hidden", () => {
    // The manual creation toast of "Nuevo hilo manual" (review round 2, R4).
    const gone = "El proyecto del hilo ya no existe en T3.";
    expect(videoFailureText(new EditorialVideoError({ reason: "launch", message: gone }))).toBe(
      gone,
    );
    expect(videoFailureText(new EditorialVideoError({ reason: "launch", message: " " }))).toBe(
      "No se pudo crear el hilo en T3.",
    );
    expect(
      videoFailureText(new EditorialVideoError({ reason: "storage", message: "SQLITE_BUSY" })),
    ).toBe("No se pudo escribir en la base editorial.");
  });
});

describe("video result draft", () => {
  it("sends the metrics typed, at noon UTC of the chosen day", () => {
    const draft = {
      metrics: { views: "1200", clicks: " 40 ", subscribers: "", comments: "" },
      observedOn: "2026-11-02",
    };
    expect(parseResultDraft(draft)).toEqual({
      _tag: "ok",
      input: { views: 1200, clicks: 40, observedAt: "2026-11-02T12:00:00.000Z" },
    });
  });

  it("needs one whole number and a date", () => {
    const empty = emptyResultDraft(new Date(2026, 10, 2));
    expect(empty.observedOn).toBe("2026-11-02");
    expect(parseResultDraft(empty)).toEqual({
      _tag: "invalid",
      problem: "Escribe al menos una métrica.",
    });
    expect(
      parseResultDraft({ ...empty, metrics: { ...empty.metrics, views: "1.5" } }),
    ).toMatchObject({ problem: "Vistas: escribe un número entero desde 0." });
    expect(
      parseResultDraft({ metrics: { ...empty.metrics, views: "3" }, observedOn: "" }),
    ).toMatchObject({ problem: "Indica la fecha de la observación." });
  });
});

describe("draft request", () => {
  const FRESH = { latestRun: null, latestUserMessageAt: null };
  const PATHS = {
    dossierPath: "videos/computacion-cuantica-threadvi/expediente.md",
    scriptPath: "videos/computacion-cuantica-threadvi/guion.md",
  };

  it("asks for a draft without repeating the studio instructions", () => {
    expect(draftRequestPrompt()).toBe("Escribe el primer borrador del guion de esta tendencia.");
  });

  it("is offered only in an assisted thread with a dossier that has not asked anything yet", () => {
    expect(draftRequestPaths(JUST_CREATED, FRESH)).toEqual(PATHS);
    expect(draftRequestPaths(JUST_CREATED, null)).toBeNull();
    expect(draftRequestPaths(JUST_CREATED, { ...FRESH, latestRun: { runId: "run-1" } })).toBeNull();
    expect(
      draftRequestPaths(JUST_CREATED, { ...FRESH, latestUserMessageAt: "2026-10-31T13:09:00Z" }),
    ).toBeNull();
    expect(draftRequestPaths({ ...JUST_CREATED, decision: DECIDED.decision }, FRESH)).toBeNull();
    expect(
      draftRequestPaths(
        { ...JUST_CREATED, thread: { ...JUST_CREATED.thread, deleted: true } },
        FRESH,
      ),
    ).toBeNull();
    expect(draftRequestPaths(MANUAL_EXPLORING, FRESH)).toBeNull();
    // A thread from before dossier files, or without a dossier.
    expect(draftRequestPaths(WRITING, FRESH)).toBeNull();
    expect(
      draftRequestPaths(
        { ...JUST_CREATED, script: { ...JUST_CREATED.script, dossierPath: null } },
        FRESH,
      ),
    ).toBeNull();
  });
});
