import * as Option from "effect/Option";
import { EarlyscriptBrand } from "@t3tools/shared/earlyscriptBrand";
import { assertEarlyscriptDataDirectory } from "@t3tools/shared/earlyscriptHome";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  /** Omitted: the guard checks every platform's folders. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Electron's appData folder (`%APPDATA%`, `$XDG_CONFIG_HOME`), where T3 Code's userData lives. */
  readonly appDataDirectory?: string | undefined;
}): string {
  return assertEarlyscriptDataDirectory(
    Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
      input.joinPath(input.homeDirectory, EarlyscriptBrand.homeDirName),
    ),
    {
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      appDataDirectory: input.appDataDirectory,
    },
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
