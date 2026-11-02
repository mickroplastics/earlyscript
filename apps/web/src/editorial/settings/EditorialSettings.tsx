import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { DraftingSettings } from "./DraftingSettings";
import { NightlyRunSettings } from "./NightlyRunSettings";
import { OnboardingSettings } from "./OnboardingSettings";
import { SourcesSettings } from "./SourcesSettings";
import { StudioProfileSettings } from "./StudioProfileSettings";

/** Settings › Editorial. Channel profile and connectors join here as sections of their own. */
export function EditorialSettingsPanel() {
  return (
    <SettingsPageContainer>
      <StudioProfileSettings />
      <SourcesSettings />
      <NightlyRunSettings />
      <DraftingSettings />
      <OnboardingSettings />
    </SettingsPageContainer>
  );
}
