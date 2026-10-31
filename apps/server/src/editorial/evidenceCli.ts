import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { authLocationFlags, resolveCliAuthConfig } from "../cli/config.ts";
import * as EditorialEvidenceExportService from "./EditorialEvidenceExportService.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";

export class EvidenceCliError extends Schema.TaggedError<EvidenceCliError>()("EvidenceCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const outFlag = Flag.String("out").pipe(
  Flag.withDescription(
    "Folder for the package; created if missing. Relative to the current folder.",
  ),
);
const fullFlag = Flag.Boolean("full").pipe(
  Flag.withDescription("Local package for the operator, free text included. Never publish it."),
  Flag.withDefault(false),
);
const shareFlag = Flag.Boolean("share").pipe(
  Flag.withDescription("Package for the report and reviewers: whitelisted columns, no free text."),
  Flag.withDefault(false),
);
const sinceFlag = Flag.String("since").pipe(
  Flag.withDescription("First UTC day (YYYY-MM-DD, inclusive) or an ISO date-time."),
  Flag.optional,
);
const untilFlag = Flag.String("until").pipe(
  Flag.withDescription("Last UTC day (YYYY-MM-DD, inclusive) or an ISO date-time."),
  Flag.optional,
);

const exportCommand = Command.make("export", {
  ...authLocationFlags,
  out: outFlag,
  full: fullFlag,
  share: shareFlag,
  since: sinceFlag,
  until: untilFlag,
}).pipe(
  Command.withDescription(
    "Export the editorial evidence package (summary, decisions, times, events, runs, manifest).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.full === flags.share) {
        return yield* new EvidenceCliError({ detail: "Choose exactly one of --full or --share." });
      }
      const mode = flags.full ? "full" : "share";
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const dbPath = path.join(config.stateDir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
      if (!(yield* fs.exists(dbPath))) {
        return yield* new EvidenceCliError({
          detail: `No editorial database at ${dbPath}. Pass --base-dir of the server whose evidence you want.`,
        });
      }
      const out = path.resolve(flags.out);
      const result = yield* Effect.gen(function* () {
        const evidence = yield* EditorialEvidenceExportService.EditorialEvidenceExportService;
        const pkg = yield* evidence.build({
          mode,
          ...(Option.isSome(flags.since) ? { since: flags.since.value } : {}),
          ...(Option.isSome(flags.until) ? { until: flags.until.value } : {}),
        });
        yield* evidence.write(pkg, out);
        return pkg;
      }).pipe(
        Effect.provide(
          EditorialEvidenceExportService.layer.pipe(
            Layer.provide(EditorialDatabase.layerFromPath(dbPath)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
        Effect.catchTags({
          EditorialEvidenceExportError: (error) =>
            Effect.fail(new EvidenceCliError({ detail: error.message })),
        }),
      );
      yield* Console.log(`Evidence package (${mode}) written to ${out}`);
      yield* Console.log(`Package hash: ${result.packageHash}`);
      for (const file of result.files) {
        yield* Console.log(
          `  ${file.name}  ${file.sha256.slice(0, 12)}  ${file.rows === null ? "" : `${file.rows} ${file.rows === 1 ? "row" : "rows"}`}`,
        );
      }
    }),
  ),
);

/** `earlyscript evidence export`, mounted in `binCli.ts`. */
export const evidenceCommand = Command.make("evidence").pipe(
  Command.withDescription("Editorial evidence for the thesis report."),
  Command.withSubcommands([exportCommand]),
);
