import { describe, expect, it } from "@effect/vitest";

import {
  trendPresentationVoiceProblems,
  voiceFailureMessage,
  voiceProblemsText,
  voiceRetryReason,
} from "./presentationVoice.ts";

const EVIDENCE = [
  { title: "Why is AI slop so frustrating to read?", excerpt: "" },
  { title: "Science Is Drowning in AI Slop", excerpt: "" },
];

const presentation = (whatHappened: string, videoAngle = "Un video podría comparar ejemplos.") => ({
  title: "Debate sobre el contenido de IA de baja calidad",
  summary: { whatHappened, whyItMatters: "Toca la calidad del software.", videoAngle },
});

const problemsText = (
  whatHappened: string,
  evidence: ReadonlyArray<{ readonly title: string; readonly excerpt: string }> = EVIDENCE,
) => voiceProblemsText(trendPresentationVoiceProblems(presentation(whatHappened), evidence));

describe("trendPresentationVoiceProblems", () => {
  it.each([
    [
      "En los últimos 7 días el motor registró 11 elementos de 11 autores distintos.",
      "Qué pasó: «el motor registro»; Qué pasó: «11 elementos»; Qué pasó: «autores distintos»",
    ],
    ["La tendencia reúne títulos sobre slop [itm_hn_1].", "Qué pasó: «la tendencia»"],
    ["Varios textos discuten el slop. Esta tendencia crece.", "Qué pasó: «esta tendencia»"],
    ["El clúster agrupa textos sobre slop.", "Qué pasó: «el cluster agrupa»"],
    ["El sistema registró once titulares.", "Qué pasó: «el sistema registro»"],
    ["El sistema agrupó estos titulares [itm_hn_1].", "Qué pasó: «el sistema agrupo»"],
    ["El algoritmo detectó un repunte de textos.", "Qué pasó: «el algoritmo detecto»"],
    [
      "Se recogieron once artículos de Hacker News [itm_hn_1].",
      "Qué pasó: «se recogieron»; Qué pasó: «once articulos de hacker news»",
    ],
    [
      "Hubo 11 publicaciones en Hacker News sobre slop.",
      "Qué pasó: «11 publicaciones en hacker news»",
    ],
    ["Escriben distintos autores sobre el slop.", "Qué pasó: «distintos autores»"],
    ["Hay doce elementos sobre slop.", "Qué pasó: «doce elementos»"],
    [
      "Solo hay titulares para la mayoría de los elementos [itm_hn_1].",
      "Qué pasó: «los elementos»; Qué pasó: «solo hay titulares»",
    ],
    ["Un motor de recomendaciones ordena los textos.", "Qué pasó: «motor»"],
    ["Lo señalo tal cual, sin recomendar acción.", "Qué pasó: «lo senalo»"],
    ["No he leído los artículos [itm_hn_1].", "Qué pasó: «no he leido»"],
    // Round 5: the headline-only rule echoed back in the angle.
    [
      "Es la pregunta de un Show HN y podría discutirse sin probar ninguna herramienta.",
      "Qué pasó: «sin probar ninguna»",
    ],
    // Round 2: compound tenses, the passive, written counts and the first person.
    [
      "Se han recopilado titulares de Hacker News durante la última semana [itm_hn_1].",
      "Qué pasó: «se han recopilado»",
    ],
    ["Las publicaciones han sido recopiladas de varios foros.", "Qué pasó: «han sido recopiladas»"],
    ["Hay trece elementos sobre slop.", "Qué pasó: «trece elementos»"],
    ["Veintiún elementos tratan el slop.", "Qué pasó: «veintiun elementos»"],
    [
      "La recopilación registró trece publicaciones de Hacker News.",
      "Qué pasó: «la recopilacion registro»; Qué pasó: «trece publicaciones de hacker news»",
    ],
    [
      "Hacker News registró 11 publicaciones sobre el tema.",
      "Qué pasó: «registro 11 publicaciones»",
    ],
    [
      "Once publicaciones en una semana muestran interés por el slop.",
      "Qué pasó: «once publicaciones en una semana»",
    ],
    ["Creo que el debate sobre slop encaja con el canal.", "Qué pasó: «creo»"],
    ["Hemos reunido noticias de Hacker News para esta ficha [itm_hn_1].", "Qué pasó: «hemos»"],
    ["Hemos visto varias publicaciones sobre slop.", "Qué pasó: «hemos»"],
    ["Vemos un debate sobre slop en la ciencia.", "Qué pasó: «vemos»"],
    ["Nosotros seguimos el debate sobre slop.", "Qué pasó: «nosotros»"],
    // Round 3: the simple passive about the collection.
    [
      "Las publicaciones fueron recopiladas de Hacker News para esta ficha.",
      "Qué pasó: «publicaciones fueron recopiladas»",
    ],
    ["Los titulares fueron recogidos para esta ficha.", "Qué pasó: «titulares fueron recogidos»"],
    [
      "Los titulares fueron recopilados de Hacker News durante la última semana [itm_hn_1].",
      "Qué pasó: «titulares fueron recopilados»",
    ],
    [
      "Las noticias fueron recogidas de varios foros [itm_hn_1].",
      "Qué pasó: «noticias fueron recogidas»",
    ],
    [
      "Publicaciones recopiladas de Hacker News discuten el slop.",
      "Qué pasó: «recopiladas de hacker news»",
    ],
    // Round 3: a note about the evidence is the application's, never the model's.
    [
      "Varios textos discuten el slop [itm_hn_1]. Solo hay extractos, no textos completos.",
      "Qué pasó: «solo hay extractos»",
    ],
    [
      "Varios textos discuten el slop [itm_hn_1]. Los artículos no se han leído. Solo hay titulares; los artículos no se han leído.",
      "Qué pasó: «no se han leido»",
    ],
  ])("rejects %s", (whatHappened, problems) => {
    expect(problemsText(whatHappened)).toBe(problems);
  });

  it.each([
    // Round 1: the word of another item's expression does not excuse the collection.
    [
      "El motor agrupó estos titulares [itm_1].",
      "Presentan un motor de búsqueda.",
      "Qué pasó: «el motor agrupo»",
    ],
    [
      "El engine agrupó estos titulares [itm_1].",
      "New Unreal Engine demo.",
      "Qué pasó: «el engine agrupo»",
    ],
    ["Un motor ordena estas noticias.", "Presentan un motor de búsqueda.", "Qué pasó: «motor»"],
    // Round 6: an outlet inferred from the URL, and a source counting its pieces.
    [
      "TechCrunch reporta que Anthropic fija el rango de su IPO [itm_1].",
      "Anthropic sets IPO price range",
      "Qué pasó: «TechCrunch»",
    ],
    [
      "Hacker News suma once publicaciones esta semana [itm_1].",
      "Anthropic sets IPO price range",
      "Qué pasó: «suma once publicaciones»",
    ],
  ])("rejects %s despite the evidence «%s»", (whatHappened, title, problems) => {
    expect(problemsText(whatHappened, [{ title, excerpt: "" }])).toBe(problems);
  });

  it("rejects a note in another part, and the wrong note before the application's", () => {
    const EXCERPTS = [
      {
        title: "Anthropic sets IPO price range",
        excerpt: "The company could end up being worth more.",
      },
      { title: "All 7 Anthropic founders will cash out", excerpt: "" },
    ];
    expect(
      voiceProblemsText(
        trendPresentationVoiceProblems(
          presentation(
            "Anthropic fija un rango de precio [itm_1]. Hay extractos breves de la mitad; los artículos no se han leído.",
            "Explicar la valuación [itm_1]. Solo hay titulares; los artículos no se han leído.",
          ),
          EXCERPTS,
        ),
      ),
    ).toBe("Ángulo de video: «solo hay titulares»; Ángulo de video: «no se han leido»");
    expect(
      problemsText(
        "Anthropic fija un rango de precio [itm_1]. Solo hay titulares; los artículos no se han leído. Hay extractos breves de la mitad; los artículos no se han leído.",
        EXCERPTS,
      ),
    ).toBe("Qué pasó: «solo hay titulares»; Qué pasó: «no se han leido»");
  });

  it("rejects the engine in the video angle", () => {
    expect(
      voiceProblemsText(
        trendPresentationVoiceProblems(
          presentation("Varios textos discuten el slop.", "Mostrar cómo el engine agrupa textos."),
          EVIDENCE,
        ),
      ),
    ).toBe("Ángulo de video: «el engine agrupa»");
  });

  it.each([
    "Varios textos discuten por qué el contenido de IA de baja calidad cansa al lector [itm_hn_50433799][itm_hn_50434647]. Un artículo describe la ciencia «inundada» de slop [itm_hn_50371470] y otro lo plantea como un juicio social más que técnico [itm_hn_50425222]. Solo hay titulares; los artículos no se han leído.",
    "Anthropic fija un rango de 70 a 78 dólares por acción [itm_rss_1].",
    "El texto cita una prueba [itm_motor_1].",
    "OpenAI publica 3 artículos de investigación sobre seguridad [itm_rss_1].",
    "La tendencia del mercado de GPUs sube según el titular [itm_rss_1].",
    "Una publicación de Hacker News pregunta por qué el slop cansa [itm_hn_1].",
    "Google presenta Veo 4 para generar video [itm_rss_1].",
    "Los datos fueron recogidos por la NASA durante la misión [itm_rss_1].",
    "Los usuarios registrados en GitHub reciben un aviso de seguridad [itm_rss_1].",
    // Round 4: "creó" is the author of the news, not the writer's "creo".
    "Su autor declara que creó smelt, uno de los agentes medidos [itm_hn_1].",
  ])("accepts %s", (whatHappened) => {
    expect(problemsText(whatHappened)).toBe("");
  });

  it.each([
    ["Unreal Engine 6 sale con un nuevo editor.", "Unreal Engine 6 released"],
    [
      "El sistema operativo Alpine publica un aviso de seguridad [itm_1].",
      "Alpine, el sistema operativo, publica un aviso",
    ],
    [
      "Google presenta un motor de búsqueda para código [itm_1].",
      "Google launches a search engine for code",
    ],
    [
      "Un motor eléctrico más barato llega a las bicicletas [itm_1].",
      "El nuevo motor eléctrico de Bosch",
    ],
    [
      "El clúster de Kubernetes de GitHub cayó dos horas [itm_1].",
      "Caída del clúster de Kubernetes de GitHub",
    ],
    [
      "TechCrunch reporta que Anthropic fija el rango de su IPO [itm_1].",
      "Anthropic sets IPO price range, TechCrunch reports",
    ],
    ["Anthropic suma tres millones de usuarios [itm_1].", "Anthropic adds three million users"],
  ])("accepts %s when the news is about it", (whatHappened, title) => {
    expect(problemsText(whatHappened, [{ title, excerpt: "" }])).toBe("");
  });
});

describe("voice messages", () => {
  const problems = trendPresentationVoiceProblems(
    {
      title: "Debate sobre slop",
      summary: {
        whatHappened: "El motor registró 11 elementos.",
        whyItMatters: "Lo señalo tal cual.",
        videoAngle: "Un video posible. Solo hay titulares.",
      },
    },
    EVIDENCE,
  );

  it("names the matched words to the model in the retry", () => {
    expect(voiceRetryReason(problems)).toBe(
      "it described how the data was collected instead of the news, and it commented on its own writing or instructions instead of the news, and it wrote a note about the evidence (headlines, excerpts, articles not read), which the application adds (Qué pasó: «el motor registro»; Qué pasó: «11 elementos»; Encaje con el canal: «lo senalo»; Ángulo de video: «solo hay titulares»)",
    );
  });

  it("names only the parts to the operator, never the rejected words", () => {
    const message = voiceFailureMessage(problems);
    expect(message).toBe(
      "«Qué pasó» describía cómo se reunieron los datos y no las noticias. «Encaje con el canal» comentaba su propia redacción. «Ángulo de video» añadía su propia nota sobre la evidencia. Regenera o elige otro modelo en Ajustes › Editorial › Redacción.",
    );
    expect(message).not.toMatch(/motor|elementos|señalo|titulares/i);
  });
});
