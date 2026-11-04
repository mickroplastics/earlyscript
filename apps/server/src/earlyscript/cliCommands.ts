// Earlyscript-only module: CLI subcommands the fork does not mount. `update` downloads a T3 Code
// runtime from GitHub and `service`/`uninstall` manage it; Earlyscript publishes no CLI releases.

export const RETIRED_CLI_COMMANDS: ReadonlyArray<string> = ["service", "update", "uninstall"];

/** Spread in place of a retired subcommand: mounts nothing and keeps the import in use. */
export const retiredCliCommand = (command: { readonly name: string }): ReadonlyArray<never> => {
  if (!RETIRED_CLI_COMMANDS.includes(command.name)) {
    throw new Error(`${command.name} is not a retired Earlyscript CLI command.`);
  }
  return [];
};
