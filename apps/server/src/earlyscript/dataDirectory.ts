// Earlyscript-only module: the server side of @t3tools/shared/earlyscriptHome. Every base
// directory the server and its subcommands resolve passes through `guardEarlyscriptBaseDir`.
import { findT3CodeDataDirectory } from "@t3tools/shared/earlyscriptHome";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class EarlyscriptDataDirectoryError extends Schema.TaggedError<EarlyscriptDataDirectoryError>()(
  "EarlyscriptDataDirectoryError",
  { directory: Schema.String, t3CodeDirectory: Schema.String },
) {
  override get message(): string {
    return `Earlyscript no puede usar ${this.directory} como carpeta de datos: pertenece a T3 Code (${this.t3CodeDirectory}). Usa la carpeta por defecto (~/.earlyscript) o indica otra con --home-dir o EARLYSCRIPT_HOME.`;
  }
}

/** The T3 Code data directory holding `directory`, if any. */
export const findT3CodeDirectoryFor = Effect.fn("earlyscript.findT3CodeDirectoryFor")(function* (
  directory: string,
) {
  return findT3CodeDataDirectory(directory, {
    homeDirectory: yield* HostProcess.HomeDirectory,
    platform: yield* HostProcess.Platform,
    appDataDirectory: (yield* HostProcess.Environment).APPDATA,
  });
});

export const guardEarlyscriptBaseDir = Effect.fn("earlyscript.guardEarlyscriptBaseDir")(function* (
  directory: string,
) {
  const t3CodeDirectory = yield* findT3CodeDirectoryFor(directory);
  if (t3CodeDirectory !== undefined) {
    return yield* new EarlyscriptDataDirectoryError({ directory, t3CodeDirectory });
  }
  return directory;
});
