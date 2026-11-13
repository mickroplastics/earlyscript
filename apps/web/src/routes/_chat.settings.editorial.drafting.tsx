import { createFileRoute } from "@tanstack/react-router";

import { DraftingSettingsPage } from "../editorial/settings/DraftingSettings";

export const Route = createFileRoute("/_chat/settings/editorial/drafting")({
  component: DraftingSettingsPage,
});
