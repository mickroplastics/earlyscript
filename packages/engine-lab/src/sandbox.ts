// @effect-diagnostics nodeBuiltinImport:off - bwrap arguments, shared by the executor and the nightly run.
// The sandbox an engine that is not the installed one runs in: no network, a read-only system,
// /home and the other user trees hidden, and only the paths it needs mounted back. Its
// environment is cleared: no credential of the process that launches it reaches it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const HIDDEN = ["/home", "/root", "/tmp", "/mnt", "/media", "/srv", "/var/tmp"];

export const nodeDir = () => NodePath.dirname(process.execPath);

export function sandboxArgs(input: {
  readonly readOnly: ReadonlyArray<string>;
  readonly writable: ReadonlyArray<string>;
  /** Writable too, the working directory and HOME. */
  readonly out: string;
  /** Set inside, after the environment is cleared. */
  readonly env?: Readonly<Record<string, string>>;
}): Array<string> {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  for (const hidden of HIDDEN) {
    if (NodeFS.existsSync(hidden)) args.push("--tmpfs", hidden);
  }
  const seen = new Set<string>();
  for (const path of [nodeDir(), ...input.readOnly]) {
    if (seen.has(path) || !NodeFS.existsSync(path)) continue;
    seen.add(path);
    args.push("--ro-bind", path, path);
  }
  for (const path of [...input.writable, input.out]) {
    args.push("--bind", path, path);
  }
  args.push(
    "--clearenv",
    "--setenv",
    "PATH",
    `${nodeDir()}:/usr/bin:/bin`,
    "--setenv",
    "HOME",
    input.out,
  );
  for (const [name, value] of Object.entries(input.env ?? {})) args.push("--setenv", name, value);
  args.push("--chdir", input.out);
  return args;
}
