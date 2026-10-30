import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../earlyscript/remoteAccess";

function SettingsConnectionsRoute() {
  return <ConnectionsSettings view="environments" />;
}

export const Route = createFileRoute("/_chat/settings/connections")({
  component: SettingsConnectionsRoute,
});
