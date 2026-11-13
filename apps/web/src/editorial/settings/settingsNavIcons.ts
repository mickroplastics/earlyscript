// Earlyscript-only: the sidebar icons of the editorial pages, apart from `settingsEntry.ts` so
// the search index does not load components. `SettingsSidebarNav.tsx` spreads them.
import { ChartLineIcon, PencilIcon, ShieldIcon, TvMinimalPlayIcon } from "lucide-react";
import type { ComponentType } from "react";

import { NightlyNavIcon } from "./NightlyNavIcon";
import {
  EDITORIAL_CHANNEL_PATH,
  EDITORIAL_DATA_PATH,
  EDITORIAL_DRAFTING_PATH,
  EDITORIAL_NIGHTLY_PATH,
  EDITORIAL_SOURCES_PATH,
  type EditorialSettingsPath,
} from "./settingsEntry";

export const EDITORIAL_SETTINGS_ICONS: Readonly<
  Record<EditorialSettingsPath, ComponentType<{ className?: string }>>
> = {
  [EDITORIAL_CHANNEL_PATH]: TvMinimalPlayIcon,
  [EDITORIAL_SOURCES_PATH]: ChartLineIcon,
  [EDITORIAL_NIGHTLY_PATH]: NightlyNavIcon,
  [EDITORIAL_DRAFTING_PATH]: PencilIcon,
  [EDITORIAL_DATA_PATH]: ShieldIcon,
};
