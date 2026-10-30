import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { EarlyscriptBrand } from "../../packages/shared/src/earlyscriptBrand.ts";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "earlyscript-icons-"));
const run = (command, args) => NodeChildProcess.execFileSync(command, args, { stdio: "inherit" });

try {
  const png = NodePath.join(temporary, EarlyscriptBrand.desktopMacIconPngFileName);
  run("sips", [
    "-s",
    "format",
    "png",
    "-z",
    "1024",
    "1024",
    NodePath.join(root, "apps/web/public", EarlyscriptBrand.webIconPath),
    "--out",
    png,
  ]);
  const iconset = NodePath.join(temporary, "earlyscript.iconset");
  NodeFS.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      run("sips", [
        "-z",
        pixels,
        pixels,
        png,
        "--out",
        NodePath.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      ]);
    }
  }
  const icns = NodePath.join(temporary, EarlyscriptBrand.desktopMacIconIcnsFileName);
  run("iconutil", ["-c", "icns", iconset, "-o", icns]);
  for (const channel of ["dev", "prod", "nightly"]) {
    const directory = NodePath.join(root, "assets", channel);
    NodeFS.copyFileSync(png, NodePath.join(directory, EarlyscriptBrand.desktopMacIconPngFileName));
    NodeFS.copyFileSync(
      icns,
      NodePath.join(directory, EarlyscriptBrand.desktopMacIconIcnsFileName),
    );
  }
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
