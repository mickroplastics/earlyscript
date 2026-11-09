// `earlyscript profile import --file <profile.json>`: stores a profile file with its exact bytes,
// so the active hash is the file's, as engine.v3.json's `profile.sha256` requires (B5). Idempotent.
// Run it with the app closed, after the app has opened this database once with its migrations.
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
import * as EditorialProfileService from "./EditorialProfileService.ts";
import { sha256 } from "./nightlySchedule.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";

export class ProfileCliError extends Schema.TaggedError<ProfileCliError>()("ProfileCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fileFlag = Flag.String("file").pipe(
  Flag.withDescription("The profile/1 JSON file; its bytes are stored as they are."),
);
const expectFlag = Flag.String("expect").pipe(
  Flag.withDescription(
    "The sha256 the file must have (hex or sha256:hex); nothing is stored otherwise.",
  ),
  Flag.optional,
);

const encodeSummary = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      database: Schema.String,
      version: Schema.Int,
      sha256: Schema.String,
      bytes: Schema.Int,
      changed: Schema.Boolean,
      created: Schema.Boolean,
    }),
  ),
);

const importCommand = Command.make("import", {
  ...authLocationFlags,
  file: fileFlag,
  expect: expectFlag,
}).pipe(
  Command.withDescription(
    "Store a studio profile file byte for byte as the active version (idempotent).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.resolve(flags.file);
      const raw = yield* fs
        .readFile(file)
        .pipe(
          Effect.mapError(
            (cause) => new ProfileCliError({ detail: `Cannot read ${file}: ${cause.message}` }),
          ),
        );
      const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
      // The table keeps text: only bytes that are UTF-8 as they are keep their hash there.
      if (Buffer.compare(Buffer.from(text, "utf8"), Buffer.from(raw)) !== 0) {
        return yield* new ProfileCliError({ detail: `${file} is not UTF-8 text.` });
      }
      const hash = sha256(text);
      if (Option.isSome(flags.expect)) {
        const expected = flags.expect.value.replace(/^sha256:/, "");
        if (hash !== `sha256:${expected}`) {
          return yield* new ProfileCliError({
            detail: `${file} has ${hash}, not sha256:${expected}; nothing was stored.`,
          });
        }
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const dbPath = path.join(config.stateDir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
      if (!(yield* fs.exists(dbPath))) {
        return yield* new ProfileCliError({
          detail: `No editorial database at ${dbPath}. Pass --base-dir of the server, after it opened once.`,
        });
      }
      const result = yield* Effect.gen(function* () {
        const profiles = yield* EditorialProfileService.EditorialProfileService;
        const imported = yield* profiles.importFile(text);
        const stored = yield* profiles.activeFile;
        return { ...imported, stored };
      }).pipe(
        Effect.provide(
          EditorialProfileService.layer.pipe(
            Layer.provide(EditorialDatabase.layerFromPath(dbPath)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
        Effect.catchTags({
          EditorialProfileError: (error) =>
            Effect.fail(new ProfileCliError({ detail: error.message })),
        }),
      );
      // Read back from the table: the bytes the nightly run hands the engine.
      if (result.stored.hash !== hash) {
        return yield* new ProfileCliError({
          detail: `The active profile has ${result.stored.hash}, not the file's ${hash}.`,
        });
      }
      yield* Console.log(
        encodeSummary({
          database: dbPath,
          version: result.active.version,
          sha256: result.stored.hash,
          bytes: Buffer.byteLength(result.stored.bytes, "utf8"),
          changed: result.changed,
          created: result.created,
        }),
      );
    }),
  ),
);

/** `earlyscript profile import`, mounted in `binCli.ts`. */
export const profileCommand = Command.make("profile").pipe(
  Command.withDescription("The studio profile the nightly run scores with."),
  Command.withSubcommands([importCommand]),
);
