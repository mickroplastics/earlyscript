import { createFileRoute } from "@tanstack/react-router";

// Split into five pages below it; the settings route redirects /settings/editorial and its
// old anchors to them (EDITORIAL_RENAMED_SETTINGS_PATHS).
export const Route = createFileRoute("/_chat/settings/editorial")({});
