// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - command-line entry point.
//   node src/tools/editorial-judge.ts --in entries.jsonl --out labels.jsonl --cache <dir> [--judge judge/judge.v1.json] [--concurrency 2]
// Input lines are {id, text}; output lines {id, label: "yes"|"no"|"unsure", reason, key, call}.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { DEFAULT_JUDGE_PATH, judgeEntries, type JudgeEntry, loadJudge } from "./judge.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    in: { type: "string" },
    out: { type: "string" },
    cache: { type: "string" },
    judge: { type: "string" },
    concurrency: { type: "string" },
  },
});
if (!values.in || !values.out || !values.cache) {
  console.error(
    "usage: editorial-judge --in <entries.jsonl> --out <labels.jsonl> --cache <dir> [--judge <judge.json>] [--concurrency n]",
  );
  process.exit(64);
}
const entries = NodeFS.readFileSync(values.in, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => {
    const { id, text } = JSON.parse(line) as JudgeEntry;
    if (typeof id !== "string" || typeof text !== "string") throw new Error(`bad entry: ${line}`);
    return { id, text };
  });
const judge = loadJudge(values.judge ?? DEFAULT_JUDGE_PATH);
const { labels, stats } = await judgeEntries(entries, {
  judge,
  cacheDir: values.cache,
  concurrency: values.concurrency ? Number(values.concurrency) : 2,
  log: (line) => console.error(line),
});
NodeFS.writeFileSync(values.out, labels.map((l) => `${JSON.stringify(l)}\n`).join(""));
console.log(
  JSON.stringify({
    judge_hash: judge.hash,
    rubric_sha256: judge.config.rubric_sha256,
    model: judge.config.model,
    ...stats,
  }),
);
