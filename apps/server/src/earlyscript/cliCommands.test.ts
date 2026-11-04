import { assert, it } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import { RETIRED_CLI_COMMANDS, retiredCliCommand } from "./cliCommands.ts";

it("mounts nothing in place of a retired command and rejects a live one", () => {
  for (const name of RETIRED_CLI_COMMANDS) {
    assert.deepStrictEqual(retiredCliCommand({ name }), []);
  }
  assert.throws(() => retiredCliCommand({ name: "evidence" }));
});

// Inspects the command tree instead of running it: a mounted `update` would download a T3 Code
// runtime and manage launchers in ~/.local/bin.
it("leaves service, update and uninstall out of the earlyscript CLI", () => {
  const mounted = makeCli({ cloudEnabled: false }).subcommands.flatMap((group) =>
    group.commands.map((command) => command.name),
  );
  assert.include(mounted, "evidence");
  assert.include(mounted, "theme");
  for (const name of RETIRED_CLI_COMMANDS) {
    assert.notInclude(mounted, name);
  }
});
