import { createFileRoute } from "@tanstack/react-router";

import { SourcesSettingsPage } from "../editorial/settings/SourcesSettings";

export const Route = createFileRoute("/_chat/settings/editorial/sources")({
  component: SourcesSettingsPage,
});
