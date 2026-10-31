import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { SourcesSettings } from "./SourcesSettings";

/** Settings › Editorial. Channel profile and connectors join here as sections of their own. */
export function EditorialSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SourcesSettings />
    </SettingsPageContainer>
  );
}
