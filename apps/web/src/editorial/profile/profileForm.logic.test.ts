import type { EditorialProfileVersion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftFromForm,
  formFromProfile,
  issuesByField,
  profileFormChanged,
  profileFormIssues,
  profileSaveFailure,
  profileVersionLabel,
  scoringRows,
  topicCount,
  topicsFromText,
} from "./profileForm.logic";

const V1: EditorialProfileVersion = {
  version: 1,
  name: "SingulariDev",
  audience: "Solo founders and developers building products with AI agents",
  include: ["AI coding agents", "local language models"],
  exclude: ["cryptocurrency prices"],
  hash: "sha256:db510e303cb7f3cff7099230a00d36b1918f28a0e6aa6b8be01727649b8bb80d",
  createdAt: "2026-11-02T18:00:00.000Z",
  origin: "earlywindow",
  active: true,
};

describe("profile form", () => {
  it("round-trips a version through the form", () => {
    const form = formFromProfile(V1);
    expect(form.include).toEqual(["AI coding agents", "local language models"]);
    expect(draftFromForm(form)).toEqual({
      name: V1.name,
      audience: V1.audience,
      include: V1.include,
      exclude: V1.exclude,
    });
    expect(profileFormChanged(form, V1)).toBe(false);
  });

  it("ignores spacing, blank lines and repeats when deciding whether anything changed", () => {
    const form = {
      ...formFromProfile(V1),
      name: "  SingulariDev ",
      include: ["AI coding agents", "", "  local   language models", "ai coding agents", " "],
    };
    expect(profileFormChanged(form, V1)).toBe(false);
    expect(topicCount(form.include)).toBe(2);
    expect(profileFormChanged({ ...form, include: [...form.include, "AI evals"] }, V1)).toBe(true);
    // Order is part of the profile: the engine reads the topics in order.
    expect(
      profileFormChanged({ ...form, include: ["local language models", "AI coding agents"] }, V1),
    ).toBe(true);
  });

  it("splits pasted text into one topic per line", () => {
    expect(topicsFromText("a\r\n\n  b   c \n")).toEqual(["a", "b c"]);
  });

  it("requires name, audience and one topic, in Spanish", () => {
    const issues = profileFormIssues({ name: " ", audience: "", include: ["", " "], exclude: [] });
    expect(issuesByField(issues)).toEqual({
      name: "Escribe el nombre del canal.",
      audience: "Describe la audiencia en una frase.",
      include: "Escribe al menos un tema que cubre el canal.",
    });
  });

  it("refuses a topic both covered and left out, and too long or too many topics", () => {
    const base = formFromProfile(V1);
    expect(
      issuesByField(profileFormIssues({ ...base, exclude: ["ai coding AGENTS"] })).exclude,
    ).toMatch(/a la vez/);
    expect(
      issuesByField(profileFormIssues({ ...base, include: ["x".repeat(201)] })).include,
    ).toMatch(/200 caracteres/);
    const many = Array.from({ length: 31 }, (_, index) => `topic ${index}`);
    expect(issuesByField(profileFormIssues({ ...base, exclude: many })).exclude).toMatch(
      /30 temas/,
    );
    expect(profileFormIssues(base)).toEqual([]);
  });

  it("labels the seed as Earlywindow's and later versions with their date", () => {
    expect(profileVersionLabel(V1)).toBe("Versión 1, de Earlywindow");
    expect(
      profileVersionLabel({
        ...V1,
        version: 3,
        origin: "operator",
        createdAt: "2026-11-02T18:20:00Z",
      }),
    ).toMatch(/^Versión 3, guardada el \d+ nov 2026/);
  });

  it("words each engine parameter and keeps an unknown one by its key", () => {
    const rows = scoringRows({
      configVersion: "earlyscript.engine.v1",
      parameters: [
        { key: "profile.include_min", value: 0.6 },
        { key: "stage.fading_max", value: -0.69 },
        { key: "rank.weighted.weights.new_signal", value: 0.1 },
        { key: "toString", value: 1 },
      ],
    });
    expect(rows[0]).toMatchObject({ label: "Afinidad mínima con los temas", value: "0,6" });
    expect(rows[1]?.value).toMatch(/0,69$/);
    expect(rows[2]).toMatchObject({ label: "rank.weighted.weights.new_signal", description: "" });
    expect(rows[3]).toMatchObject({ label: "toString", description: "" });
  });

  it("turns a failed save into field issues or one message", () => {
    expect(
      profileSaveFailure({
        _tag: "EditorialProfileError",
        reason: "invalid-profile",
        issues: [{ field: "name", code: "required" }],
      }),
    ).toEqual({ issues: [{ field: "name", code: "required" }], message: null });
    expect(
      profileSaveFailure({ _tag: "EditorialProfileError", reason: "storage" }).message,
    ).toMatch(/no se guardó/);
    expect(profileSaveFailure({ _tag: "EnvironmentAuthorizationError" }).message).toMatch(
      /permiso/,
    );
    expect(profileSaveFailure(new Error("boom")).message).toBe("El perfil no se guardó.");
  });
});
