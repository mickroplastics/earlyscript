import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Switch } from "../../components/ui/switch";
import { usePairsModeStore } from "../pairsMode";
import { EDITORIAL_PAIRS_SECTION_ID } from "./settingsEntry";

/** Settings › Editorial › Revisión por pares: the persistent pairs mode. */
export function PairsModeSettings() {
  const enabled = usePairsModeStore((state) => state.enabled);
  const setEnabled = usePairsModeStore((state) => state.setEnabled);
  return (
    <SettingsSection id={EDITORIAL_PAIRS_SECTION_ID} title="Revisión por pares">
      <SettingsRow
        title="Modo pares"
        description="Para los seis pares con revisores ciegos. Oculta la opinión de los jueces y cualquier indicio del brazo, del motor o de la procedencia de cada tarjeta. Tu decisión se registra con su hora como siempre. Al apagarlo, la opinión de los jueces vuelve a mostrarse solo en las tarjetas que ya decidiste."
        status={enabled ? "Activado en esta app." : "Desactivado."}
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(Boolean(checked))}
            aria-label="Modo pares"
          />
        }
      />
    </SettingsSection>
  );
}
