import { createFileRoute } from "@tanstack/react-router";
import { EditorialSettingsPanel } from "../editorial/settings/EditorialSettings";

export const Route = createFileRoute("/_chat/settings/editorial")({
  component: EditorialSettingsPanel,
});
