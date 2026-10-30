/**
 * Earlyscript brand values. Upstream T3 Code files read these instead of their own literals, so
 * each value is defined once here. Every reader is listed in docs/upstream-divergence.md.
 * Plain values only: Node scripts and Electron launchers load this file through type stripping.
 */

const urlScheme = "earlyscript";
const desktopAppId = "cc.biste.earlyscript";

export const EarlyscriptBrand = {
  productName: "Earlyscript",
  desktopProductName: "Earlyscript",
  cliBinName: "earlyscript",
  /** Base data directory below the user's home; `T3CODE_HOME` still overrides it. */
  homeDirName: ".earlyscript",
  defaultServerPort: 4773,
  defaultDevServerPort: 14773,
  defaultDevWebPort: 5743,
  urlScheme,
  devUrlScheme: `${urlScheme}-dev`,
  desktopAppId,
  desktopDevAppId: `${desktopAppId}.dev`,
  linuxDesktopEntryName: "cc.biste.Earlyscript.desktop",
  linuxDevDesktopEntryName: "cc.biste.Earlyscript.Development.desktop",
} as const;
