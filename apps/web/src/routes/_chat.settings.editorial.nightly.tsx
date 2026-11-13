import { createFileRoute } from "@tanstack/react-router";

import { NightlySettingsPage } from "../editorial/settings/NightlyRunSettings";

export const Route = createFileRoute("/_chat/settings/editorial/nightly")({
  component: NightlySettingsPage,
});
