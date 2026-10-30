/**
 * Earlyscript brand values. Upstream T3 Code files read these instead of their own literals, so
 * each value is defined once here. Every reader is listed in docs/upstream-divergence.md.
 * Plain values only: Node scripts and Electron launchers load this file through type stripping.
 */

const urlScheme = "earlyscript";
const desktopAppId = "cc.biste.earlyscript";

export const EarlyscriptBrand = {
  productName: "Earlyscript",
  webIconPath: "/earlyscript-icon.svg",
  webTouchIconPath: "/earlyscript-touch.png",
  desktopProductName: "Earlyscript",
  copyrightHolder: "Miguel Ángel Brito Espejo",
  artifactBaseName: "Earlyscript",
  desktopDescription:
    "Earlyscript is an editorial studio for video scripts with final human decisions.",
  desktopMacIconPngFileName: "earlyscript-macos-1024.png",
  desktopMacIconIcnsFileName: "earlyscript.icns",
  cliBinName: "earlyscript",
  /** Linux executable and package name; distinct from the CLI so both can be on PATH. */
  desktopExecutableName: "earlyscript-desktop",
  /** Base data directory below the user's home; `T3CODE_HOME` still overrides it. */
  homeDirName: ".earlyscript",
  defaultServerPort: 4773,
  defaultDevServerPort: 14773,
  defaultDevWebPort: 5743,
  urlScheme,
  devUrlScheme: `${urlScheme}-dev`,
  desktopAppId,
  desktopDevAppId: `${desktopAppId}.dev`,
  linuxWmClass: urlScheme,
  linuxDevWmClass: `${urlScheme}-dev`,
  linuxDesktopEntryName: "cc.biste.Earlyscript.desktop",
  linuxDevDesktopEntryName: "cc.biste.Earlyscript.Development.desktop",
} as const;
