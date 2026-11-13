import { createFileRoute } from "@tanstack/react-router";

import { DataSettingsPage } from "../editorial/settings/DataSettings";

export const Route = createFileRoute("/_chat/settings/editorial/data")({
  component: DataSettingsPage,
});
