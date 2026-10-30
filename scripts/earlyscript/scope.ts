// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a synchronous wrapper around vp run.
// es:test and es:build run only the packages in packages.json. The check fails when a
// workspace package is unclassified or imports Earlyscript code without being included.
// Usage: scope.ts check | scope.ts run <task> [args...]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { readWorkspace } from "../../.github/scripts/ci-changes.cjs";

export interface ScopeConfig {
  readonly include: Readonly<Record<string, string>>;
  readonly exclude: Readonly<Record<string, string>>;
  readonly owned: ReadonlyArray<string>;
  readonly testAlone: ReadonlyArray<string>;
}

export interface ScopePackage {
  readonly name: string;
  readonly dir: string;
  readonly deps: ReadonlyArray<string>;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

const matchesOwned = (path: string, pattern: string) => {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
  }
  return path === pattern;
};

const ownedRootOf = (path: string, owned: ReadonlyArray<string>) => {
  const segments = path.split("/");
  for (let length = segments.length; length > 0; length--) {
    const candidate = segments.slice(0, length).join("/");
    if (owned.some((pattern) => matchesOwned(candidate, pattern))) return candidate;
  }
  return undefined;
};

const packageOf = (path: string, packages: ReadonlyArray<ScopePackage>) =>
  packages
    .filter((pkg) => path.startsWith(`${pkg.dir}/`))
    .toSorted((a, b) => b.dir.length - a.dir.length)[0];

const bareName = (specifier: string) => {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
};

export function checkScope(
  config: ScopeConfig,
  packages: ReadonlyArray<ScopePackage>,
  sources: Iterable<SourceFile>,
): Array<string> {
  const problems: Array<string> = [];
  const dirs = new Set(packages.map((pkg) => pkg.dir));
  const included = new Set(Object.keys(config.include));

  for (const dir of [...Object.keys(config.include), ...Object.keys(config.exclude)]) {
    if (!dirs.has(dir)) problems.push(`${dir} is listed but is not a workspace package.`);
  }
  for (const dir of dirs) {
    const inInclude = dir in config.include;
    const inExclude = dir in config.exclude;
    if (inInclude && inExclude) problems.push(`${dir} is in both include and exclude.`);
    if (!inInclude && !inExclude) problems.push(`${dir} is not classified in include or exclude.`);
  }
  for (const dir of config.testAlone) {
    if (!included.has(dir)) problems.push(`${dir} is in testAlone but not in include.`);
  }

  const ownedPackages = new Map(
    packages
      .filter((pkg) => ownedRootOf(pkg.dir, config.owned) === pkg.dir)
      .map((pkg) => [pkg.name, pkg.dir]),
  );
  const requireIncluded = (dir: string, reason: string) => {
    if (!included.has(dir)) problems.push(`${dir} ${reason} but is not in include.`);
  };

  for (const dir of ownedPackages.values()) requireIncluded(dir, "is Earlyscript's own package");
  for (const pkg of packages) {
    for (const dep of pkg.deps) {
      const owner = ownedPackages.get(dep);
      if (owner && owner !== pkg.dir) requireIncluded(pkg.dir, `depends on ${owner}`);
    }
  }

  const reported = new Set<string>();
  for (const file of sources) {
    const importer = packageOf(file.path, packages);
    if (!importer || included.has(importer.dir) || !SOURCE_EXTENSION.test(file.path)) continue;
    const fileOwner = ownedRootOf(file.path, config.owned);
    for (const [, specifier = ""] of file.text.matchAll(IMPORT_SPECIFIER)) {
      const target = specifier.startsWith(".")
        ? ownedRootOf(
            NodePath.posix.join(NodePath.posix.dirname(file.path), specifier),
            config.owned,
          )
        : ownedPackages.get(bareName(specifier));
      if (!target || target === fileOwner) continue;
      const key = `${importer.dir}\0${target}`;
      if (reported.has(key)) continue;
      reported.add(key);
      requireIncluded(importer.dir, `imports ${target} (${file.path})`);
    }
  }
  return problems;
}

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");

const readConfig = (): ScopeConfig =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, "scripts/earlyscript/packages.json"), "utf8"));

function* readSources(): Generator<SourceFile> {
  const listed = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  for (const path of listed.split("\0")) {
    if (!SOURCE_EXTENSION.test(path)) continue;
    const absolute = NodePath.join(root, path);
    if (!NodeFS.existsSync(absolute)) continue;
    yield { path, text: NodeFS.readFileSync(absolute, "utf8") };
  }
}

function main(args: ReadonlyArray<string>): number {
  const [command, task = "", ...rest] = args;
  if (command !== "check" && !(command === "run" && task)) {
    console.error("Usage: scope.ts check | scope.ts run <task> [args...]");
    return 2;
  }
  const config = readConfig();
  const problems = checkScope(config, readWorkspace(), readSources());
  if (problems.length > 0) {
    console.error("Earlyscript scope check failed (scripts/earlyscript/packages.json):");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  if (command === "check") {
    console.log(`Earlyscript scope OK: ${Object.keys(config.include).length} packages included.`);
    return 0;
  }
  // Like upstream CI's test jobs: a failing web run must not skip the server, which depends on it.
  const alone = task === "test" ? config.testAlone : [];
  const passes = [
    Object.keys(config.include).filter((dir) => !alone.includes(dir)),
    ...alone.map((dir) => [dir]),
  ];
  const failed = passes.filter((dirs) => {
    const filters = dirs.flatMap((dir) => ["--filter", `./${dir}`]);
    const parallel = task === "test" && dirs.length > 1 ? ["--parallel"] : [];
    const result = NodeChildProcess.spawnSync(
      "vp",
      ["run", ...parallel, ...filters, task, ...rest],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    return result.status !== 0;
  });
  for (const dirs of failed) console.error(`es ${task} failed in: ${dirs.join(", ")}`);
  return failed.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
