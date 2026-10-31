import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { NightlyRunSettings } from "./NightlyRunSettings";
import { SourcesSettings } from "./SourcesSettings";

/** Settings › Editorial. Channel profile and connectors join here as sections of their own. */
export function EditorialSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SourcesSettings />
      <NightlyRunSettings />
    </SettingsPageContainer>
  );
}
