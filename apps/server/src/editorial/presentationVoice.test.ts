import { describe, expect, it } from "@effect/vitest";

import { trendPresentationVoiceProblems } from "./presentationVoice.ts";

const EVIDENCE = [
  { title: "Why is AI slop so frustrating to read?", excerpt: "" },
  { title: "Science Is Drowning in AI Slop", excerpt: "" },
];

const presentation = (whatHappened: string, videoAngle = "Un video podría comparar ejemplos.") => ({
  title: "Debate sobre el contenido de IA de baja calidad",
  summary: { whatHappened, whyItMatters: "Toca la calidad del software.", videoAngle },
});

describe("trendPresentationVoiceProblems", () => {
  it.each([
    [
      "En los últimos 7 días el motor registró 11 elementos de 11 autores distintos.",
      ["Qué pasó: «motor»", "Qué pasó: «autores distintos»", "Qué pasó: «11 elementos»"],
    ],
    ["La tendencia reúne títulos sobre slop [itm_hn_1].", ["Qué pasó: «la tendencia»"]],
    ["Varios textos discuten el slop. Esta tendencia crece.", ["Qué pasó: «esta tendencia»"]],
    ["El clúster agrupa textos sobre slop.", ["Qué pasó: «el cluster»"]],
  ])("rejects %s", (whatHappened, problems) => {
    expect(trendPresentationVoiceProblems(presentation(whatHappened), EVIDENCE)).toEqual(problems);
  });

  it("rejects the engine in the video angle", () => {
    expect(
      trendPresentationVoiceProblems(
        presentation("Varios textos discuten el slop.", "Mostrar cómo el engine agrupa textos."),
        EVIDENCE,
      ),
    ).toEqual(["Ángulo de video: «engine»"]);
  });

  it.each([
    "Varios textos discuten por qué el contenido de IA de baja calidad cansa al lector [itm_hn_50433799][itm_hn_50434647]. Un artículo describe la ciencia «inundada» de slop [itm_hn_50371470] y otro lo plantea como un juicio social más que técnico [itm_hn_50425222]. Solo hay titulares; los artículos no se han leído.",
    "Anthropic fija un rango de 70 a 78 dólares por acción [itm_rss_1].",
    "El texto cita una prueba [itm_motor_1].",
  ])("accepts %s", (whatHappened) => {
    expect(trendPresentationVoiceProblems(presentation(whatHappened), EVIDENCE)).toEqual([]);
  });

  it("accepts the word when the news itself is about an engine", () => {
    expect(
      trendPresentationVoiceProblems(presentation("Unreal Engine 6 sale con un nuevo editor."), [
        { title: "Unreal Engine 6 released", excerpt: "" },
      ]),
    ).toEqual([]);
  });
});
