import { SettingsRow } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { DataHandlingDialog } from "../onboarding/DataHandlingDialog";

/**
 * Settings › About › Legal: replaces T3 Code's privacy policy row, which described analytics
 * Earlyscript does not send and linked to t3.codes.
 */
export function PrivacySettingsRow() {
  return (
    <SettingsRow
      title="Cómo se tratan tus datos"
      description="Quedan en esta máquina. Earlyscript no envía telemetría ni analítica."
      control={<DataHandlingDialog label="Ver" trigger={<Button size="sm" variant="outline" />} />}
    />
  );
}
