// @effect-diagnostics nodeBuiltinImport:off -- lstat and realpath guard the destination against links.
import * as NodeFS from "node:fs";

import {
  EDITORIAL_FIGURES_MAX_TOTAL_BASE64,
  EditorialFiguresSaveError,
  type EditorialFiguresSaveInput,
  type EditorialFiguresSaveResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Writes client-drawn figures into a picked folder: a real folder under `within`, names from the
 * contract pattern, a same-name regular file replaced by rename; a link or folder with that name
 * stops the call before any write.
 */
export const writeFigures = Effect.fn("EditorialFigures.write")(function* (
  input: EditorialFiguresSaveInput,
  options: { readonly within: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const refuse = (message: string, reason: "target" | "too-large" = "target") =>
    Effect.fail(new EditorialFiguresSaveError({ reason, message }));

  const total = input.files.reduce((sum, file) => sum + file.base64.length, 0);
  if (total > EDITORIAL_FIGURES_MAX_TOTAL_BASE64) {
    return yield* refuse(
      `The figures add up to ${total} base64 characters; the limit per call is ${EDITORIAL_FIGURES_MAX_TOTAL_BASE64}.`,
      "too-large",
    );
  }
  const names = new Set(input.files.map((file) => file.name));
  if (names.size !== input.files.length) {
    return yield* refuse("Two figures have the same file name.");
  }
  if (!path.isAbsolute(input.directory)) {
    return yield* refuse(`The destination must be an absolute path: ${input.directory}`);
  }
  const target = path.resolve(input.directory);
  const unreachable = (entry: string) => () =>
    new EditorialFiguresSaveError({
      reason: "target",
      message: `Could not inspect ${entry} before writing the figures.`,
    });
  const lstat = (entry: string) =>
    Effect.try({
      try: () => NodeFS.lstatSync(entry, { throwIfNoEntry: false }),
      catch: unreachable(entry),
    });
  const realPath = (entry: string) =>
    Effect.try({ try: () => NodeFS.realpathSync(entry), catch: unreachable(entry) });

  const folder = yield* lstat(target);
  if (folder === undefined) return yield* refuse(`${target} does not exist. Choose a folder.`);
  if (folder.isSymbolicLink()) {
    return yield* refuse(`${target} is a symbolic link. Choose a real folder.`);
  }
  if (!folder.isDirectory()) return yield* refuse(`${target} is not a folder.`);
  const within = yield* realPath(options.within);
  const resolved = yield* realPath(target);
  const inside =
    resolved === within ||
    resolved.startsWith(within.endsWith(path.sep) ? within : `${within}${path.sep}`);
  if (!inside) {
    return yield* refuse(`${target} is outside ${options.within}. Choose a folder there.`);
  }

  // Every existing name checked before the first write: nothing is half done on a refusal.
  for (const file of input.files) {
    const existing = yield* lstat(path.join(resolved, file.name));
    if (existing !== undefined && !existing.isFile()) {
      return yield* refuse(
        `${path.join(target, file.name)} exists and is not a regular file. Move it or choose another folder.`,
      );
    }
  }

  const failed = (cause: unknown) =>
    Effect.logWarning("editorial figures: writing failed", { directory: target, cause }).pipe(
      Effect.andThen(refuse(`Could not write the figures to ${target}.`)),
    );
  const written: Array<{ readonly name: string; readonly bytes: number }> = [];
  const stamp = yield* Clock.currentTimeMillis;
  for (const file of input.files) {
    const bytes = Uint8Array.from(Buffer.from(file.base64, "base64"));
    const final = path.join(resolved, file.name);
    const temporary = path.join(resolved, `.${file.name}.${process.pid}.${stamp}.tmp`);
    yield* fs.writeFile(temporary, bytes, { flag: "wx" }).pipe(
      Effect.andThen(fs.rename(temporary, final)),
      Effect.catch((cause) =>
        fs.remove(temporary, { force: true }).pipe(Effect.ignore, Effect.andThen(failed(cause))),
      ),
    );
    written.push({ name: file.name, bytes: bytes.byteLength });
  }
  return { directory: target, files: written } satisfies EditorialFiguresSaveResult;
});
