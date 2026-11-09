// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - command-line entry point.
// engine v3 lists: the evaluation lists of the v3 arms (lists-v3.ts).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { parseCutoffList } from "./backtest.ts";
import { ARMS, type Arm, isArm, runLists } from "./lists-v3.ts";
import { sha256 } from "./hash.ts";

const USAGE =
  "usage: engine v3 lists --corpus <dir> --cutoff <day|day,day|from..to> --arm <arm|A,B|all> --out <file.json|dir> [--bags <dir>] [--runs <dir>] [--dev <days>] [--lists <days>] [--config <file>] [--profile <file>] [--cache <sqlite>] [--cache-only] [--models <dir>] [--workers n]";

export async function v3Command(argv: ReadonlyArray<string>): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = NodeUtil.parseArgs({
    args: [...rest],
    options: {
      corpus: { type: "string" },
      cutoff: { type: "string" },
      arm: { type: "string" },
      out: { type: "string" },
      bags: { type: "string" },
      runs: { type: "string" },
      dev: { type: "string" },
      lists: { type: "string" },
      config: { type: "string" },
      profile: { type: "string" },
      cache: { type: "string" },
      "cache-only": { type: "boolean" },
      models: { type: "string" },
      workers: { type: "string" },
    },
  });
  if (sub !== "lists" || !values.corpus || !values.cutoff || !values.arm || !values.out) {
    console.error(USAGE);
    return 64;
  }
  const arms = values.arm === "all" ? [...ARMS] : values.arm.split(",").map((a) => a.trim());
  if (!arms.every(isArm)) {
    console.error(`unknown arm in ${values.arm}; arms: ${ARMS.join(", ")}`);
    return 64;
  }
  const cutoffs = parseCutoffList(values.cutoff);
  const single = cutoffs.length === 1 && arms.length === 1 && values.out.endsWith(".json");
  const started = performance.now();
  const result = await runLists({
    corpusDir: values.corpus,
    cutoffs,
    arms: arms as Array<Arm>,
    ...(single ? { outFile: values.out } : { outDir: values.out }),
    ...(values.bags ? { bagsDir: values.bags } : {}),
    ...(values.runs ? { runsDir: values.runs } : {}),
    ...(values.dev ? { developmentCutoffs: parseCutoffList(values.dev) } : {}),
    ...(values.lists ? { listCutoffs: parseCutoffList(values.lists) } : {}),
    ...(values.config ? { configPath: values.config } : {}),
    ...(values.profile ? { profilePath: values.profile } : {}),
    ...(values.cache ? { cacheFile: values.cache } : {}),
    ...(values["cache-only"] ? { cacheOnly: true } : {}),
    ...(values.models ? { modelDir: values.models } : {}),
    ...(values.workers ? { workers: Number(values.workers) } : {}),
    log: (line) => console.error(line),
  });
  if (!single) {
    const files = result.files.map((f) => ({
      arm: f.arm,
      cutoff: f.cutoff,
      path: NodePath.relative(values.out!, f.path!),
      logical_hash: f.logical_hash,
      sha256: sha256(NodeFS.readFileSync(f.path!)),
    }));
    const manifest = {
      schema_version: "earlyscript.v3-lists-manifest/1",
      arms,
      cutoffs: values.lists ? parseCutoffList(values.lists) : cutoffs,
      development: values.dev ? parseCutoffList(values.dev) : cutoffs,
      files,
      /** Over the files' sha256 in order: what two runs of the same inputs reproduce. */
      lists_hash: sha256(files.map((f) => `${f.path} ${f.sha256}`).join("\n")),
    };
    NodeFS.writeFileSync(
      NodePath.join(values.out, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(values.out, "timings.json"),
      `${JSON.stringify({ seconds: Math.round((performance.now() - started) / 1000), cuts: result.timings, preflight: result.preflight }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ files: files.length, lists_hash: manifest.lists_hash }));
  } else console.log(JSON.stringify(result.files[0]));
  return 0;
}
