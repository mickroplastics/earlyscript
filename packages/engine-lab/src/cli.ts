// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalConsole:off - the executor's command line.
// The fixed commands an executor runs. The server sends the job spec on stdin; nothing here
// takes a path, host or argument from a model.
//   node src/cli.ts evaluate --jobs-root <dir> --engine-root <dir> --token <token>  (spec on stdin)
//   node src/cli.ts cancel --jobs-root <dir> --token <token>
//   node src/cli.ts identify  (input roots, corpus and models dirs on stdin)
//   node src/cli.ts cache-view --spec <file>  (the nightly's trusted cache preparation)
//   node src/cli.ts synthetic --out <dir> --from <day> --days <n>
//   node src/cli.ts subset --from-corpus <dir> --out <new dir> --sources hn,github --from <day> --to <exclusive day>
import * as NodeFS from "node:fs";

import type { JobSpec } from "./result.ts";
import { subsetCorpus } from "./corpusSubset.ts";
import { writeSyntheticCorpus } from "./synthetic.ts";
import { buildCacheView } from "./cacheView.ts";
import { cancelJob, evaluateJob, identifyInputs } from "./worker.ts";

const [command, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const at = rest.indexOf(`--${name}`);
  return at < 0 ? undefined : rest[at + 1];
};
const need = (name: string) => {
  const value = opt(name);
  if (value === undefined) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
};

if (command === "evaluate") {
  const jobsRoot = need("jobs-root");
  const engineRoot = need("engine-root");
  const token = need("token");
  const spec = JSON.parse(NodeFS.readFileSync(0, "utf8")) as JobSpec;
  if (spec.token !== token) {
    console.error("the spec belongs to another token");
    process.exit(2);
  }
  const result = await evaluateJob(spec, {
    jobsRoot,
    engineRoot,
    log: (line) => console.error(line),
  });
  console.log(JSON.stringify(result));
} else if (command === "identify") {
  const input = JSON.parse(NodeFS.readFileSync(0, "utf8")) as Parameters<typeof identifyInputs>[0];
  try {
    console.log(JSON.stringify({ ok: true, ...identifyInputs(input) }));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    console.log(
      JSON.stringify({
        ok: false,
        code: typeof code === "string" ? code : "artifact-mismatch",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
} else if (command === "cache-view") {
  // A child of the nightly job, under its lock token: cancelling the job ends its process
  // group, the installed embedder's processes included.
  const input = JSON.parse(NodeFS.readFileSync(need("spec"), "utf8")) as Parameters<
    typeof buildCacheView
  >[0];
  try {
    console.log(JSON.stringify({ ok: true, ...(await buildCacheView(input)) }));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
} else if (command === "cancel") {
  console.log(JSON.stringify({ status: cancelJob(need("jobs-root"), need("token")) }));
} else if (command === "synthetic") {
  console.log(
    JSON.stringify(
      writeSyntheticCorpus({ dir: need("out"), fromDay: need("from"), days: Number(need("days")) }),
    ),
  );
} else if (command === "subset") {
  console.log(
    JSON.stringify(
      subsetCorpus({
        from: need("from-corpus"),
        out: need("out"),
        sources: need("sources").split(","),
        fromDay: need("from"),
        toDay: need("to"),
      }),
    ),
  );
} else {
  console.error("usage: cli.ts evaluate|cancel|synthetic ...");
  process.exit(2);
}
