// Earlyscript-only module: the server side of @t3tools/shared/earlyscriptHome. Every base
// directory the server and its subcommands resolve passes through `guardEarlyscriptBaseDir`.
import {
  checkEarlyscriptDataDirectory,
  describeRefusedDataDirectory,
} from "@t3tools/shared/earlyscriptHome";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class EarlyscriptDataDirectoryError extends Schema.TaggedError<EarlyscriptDataDirectoryError>()(
  "EarlyscriptDataDirectoryError",
  {
    directory: Schema.String,
    /** The T3 Code folder it belongs to; absent when the path could not be verified. */
    t3CodeDirectory: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return describeRefusedDataDirectory(
      this.directory,
      this.t3CodeDirectory !== undefined
        ? { kind: "inside", t3CodeDirectory: this.t3CodeDirectory }
        : { kind: "unverifiable", detail: this.detail ?? "" },
    );
  }
}

/** Whether `directory` (existing or still to be created) is inside a T3 Code data directory. */
export const checkT3CodeDirectoryFor = Effect.fn("earlyscript.checkT3CodeDirectoryFor")(function* (
  directory: string,
) {
  return checkEarlyscriptDataDirectory(directory, {
    homeDirectory: yield* HostProcess.HomeDirectory,
    platform: yield* HostProcess.Platform,
    appDataDirectory: (yield* HostProcess.Environment).APPDATA,
  });
});

export const guardEarlyscriptBaseDir = Effect.fn("earlyscript.guardEarlyscriptBaseDir")(function* (
  directory: string,
) {
  const check = yield* checkT3CodeDirectoryFor(directory);
  if (check.kind === "inside") {
    return yield* new EarlyscriptDataDirectoryError({
      directory,
      t3CodeDirectory: check.t3CodeDirectory,
    });
  }
  if (check.kind === "unverifiable") {
    return yield* new EarlyscriptDataDirectoryError({ directory, detail: check.detail });
  }
  return directory;
});
