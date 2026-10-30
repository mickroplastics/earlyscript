// @effect-diagnostics nodeBuiltinImport:off - the CLI is the filesystem boundary.
import * as NodeFS from "node:fs";
import { checkScript } from "./script.ts";

function main(args: readonly string[]): number {
  const [file, ...flags] = args;
  if (!file || file.startsWith("--"))
    throw new Error("Usage: check <script.md> [--dossier <json>] [--json] (line 1, column 1).");
  let dossier: unknown;
  let json = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--json") json = true;
    else if (flag === "--dossier" && flags[i + 1] && !flags[i + 1]?.startsWith("--")) {
      dossier = JSON.parse(NodeFS.readFileSync(flags[++i] ?? "", "utf8"));
    } else throw new Error(`Invalid option: ${flag} (line 1, column 1).`);
  }
  const report = checkScript(NodeFS.readFileSync(file, "utf8"), { dossier });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      `Structure: ${report.structure.length ? "invalid" : "OK"}\nClaims: ${report.counts.claims}, cited: ${report.counts.cited}, uncited: ${report.counts.uncited}\nUnknown citations: ${report.unknownCitations.length}\n`,
    );
    for (const diagnostic of report.diagnostics)
      process.stdout.write(
        `${diagnostic.line}:${diagnostic.column} ${diagnostic.code}: ${diagnostic.message}\n`,
      );
  }
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${message}${/line \d+, column \d+/.test(message) ? "" : " (line 1, column 1)"}\n`,
  );
  process.exitCode = 2;
}
