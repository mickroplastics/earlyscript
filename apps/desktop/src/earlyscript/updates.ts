import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

/** Without `updateChecks` electron-updater stays off and the update UI shows this reason. */
export const disabledReason: string | null = earlyscriptFlags.updateChecks
  ? null
  : "Automatic updates are turned off in Earlyscript (updateChecks flag).";
