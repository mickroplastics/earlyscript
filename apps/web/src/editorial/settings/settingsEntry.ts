// Earlyscript-only: the editorial page of Settings. `settingsSearch.ts` and
// `SettingsSidebarNav.tsx` take these at one-line hook points (docs/upstream-divergence.md §18).
import { NewspaperIcon } from "lucide-react";

export const EDITORIAL_SETTINGS_PATH = "/settings/editorial";
export const EDITORIAL_SETTINGS_LABEL = "Editorial";
export const EditorialSettingsIcon = NewspaperIcon;

export const EDITORIAL_SETTINGS_NAV_GROUP = {
  heading: "Editorial",
  paths: [EDITORIAL_SETTINGS_PATH],
} as const;

export const EDITORIAL_SOURCES_SECTION_ID = "editorial-sources";
export const EDITORIAL_NIGHTLY_SECTION_ID = "editorial-nightly";
export const EDITORIAL_ONBOARDING_SECTION_ID = "editorial-onboarding";
export const EDITORIAL_DATA_HANDLING_ID = "editorial-data-handling";
export const EDITORIAL_DRAFTING_SECTION_ID = "editorial-drafting";
export const EDITORIAL_PROFILE_SECTION_ID = "editorial-profile";
export const EDITORIAL_PAIRS_SECTION_ID = "editorial-pairs";

export const EDITORIAL_SETTINGS_SEARCH_ITEMS = [
  {
    id: EDITORIAL_PAIRS_SECTION_ID,
    title: "Revisión por pares",
    to: EDITORIAL_SETTINGS_PATH,
    searchTerms: [
      "pares pairs revisión review ciego blind jueces judges opinión opinion modo mode",
    ],
  },
  {
    id: EDITORIAL_PROFILE_SECTION_ID,
    title: "Perfil del estudio",
    to: EDITORIAL_SETTINGS_PATH,
    searchTerms: [
      "perfil profile estudio studio canal channel audiencia audience temas topics",
      "incluir include excluir exclude versión version pesos weights puntuación scoring",
    ],
  },
  {
    id: EDITORIAL_SOURCES_SECTION_ID,
    title: "Fuentes",
    to: EDITORIAL_SETTINGS_PATH,
    searchTerms: [
      "sources fuentes captura motor engine corpus cobertura coverage backtest",
      "gobernanza governance licencia license términos terms retención borrado",
      "hacker news github arxiv wikipedia npm stack exchange bluesky hugging face dev lobsters rss",
    ],
  },
  {
    id: EDITORIAL_NIGHTLY_SECTION_ID,
    title: "Corrida nocturna",
    to: EDITORIAL_SETTINGS_PATH,
    searchTerms: [
      "nightly corrida nocturna diaria daily schedule horario hora ejecutar ahora run now",
      "motor engine workers procesos captura importar redactar jobs",
    ],
  },
  {
    id: EDITORIAL_DRAFTING_SECTION_ID,
    title: "Redacción",
    to: EDITORIAL_SETTINGS_PATH,
    searchTerms: [
      "redacción drafting modelo model texto text generation título resumen haiku luna",
      "tope límite limit cap mensual monthly presupuesto budget uso usage tokens",
    ],
  },
  {
    id: EDITORIAL_ONBOARDING_SECTION_ID,
    title: "Asistente de inicio",
    to: EDITORIAL_SETTINGS_PATH,
    searchTerms: [
      "asistente inicio primer arranque onboarding welcome setup configurar decisiones aceptaciones",
    ],
  },
  {
    id: EDITORIAL_DATA_HANDLING_ID,
    title: "Cómo se tratan tus datos",
    to: EDITORIAL_SETTINGS_PATH,
    searchTerms: [
      "privacidad privacy datos data telemetría telemetry analítica analytics borrar delete política policy",
    ],
  },
] as const;
