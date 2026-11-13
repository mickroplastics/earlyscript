import { createFileRoute } from "@tanstack/react-router";

import { ChannelSettingsPage } from "../editorial/settings/ChannelSettings";

export const Route = createFileRoute("/_chat/settings/editorial/channel")({
  component: ChannelSettingsPage,
});
