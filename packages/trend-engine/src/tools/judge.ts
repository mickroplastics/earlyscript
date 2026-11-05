// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalConsole:off - offline tool; responses are decoded with Schema.
//   node src/tools/judge.ts --in entries.jsonl --out labels.jsonl --cache <dir> [--judge judge/judge.v1.json] [--concurrency 2]
// Input lines are {id, text}; output lines {id, label: "yes"|"no"|"unsure", reason, key, call}.
// Editorial judge: labels entries {id, text} with the frozen rubric through the Claude CLI
// of the operator's subscription. It runs outside the engine: its labels train the
// relevance probe (relevance-train.ts) and the development cards, never a run.
// The CLI runs with no tools, no settings, no MCP servers and an empty working directory,
// so the rubric is its whole context. Each label is cached by (rubric, model, text) and every
// call is stored with its prompt and response, so a label set can be audited and replayed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import { canonicalJson, sha256 } from "../hash.ts";

export const DEFAULT_JUDGE_PATH = NodePath.join(import.meta.dirname, "../../judge/judge.v1.json");

export const JudgeConfig = Schema.Struct({
  judge_version: Schema.String,
  question: Schema.String,
  rubric: Schema.String,
  rubric_sha256: Schema.String,
  model: Schema.String,
  batch_size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  max_text_chars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type JudgeConfig = typeof JudgeConfig.Type;

export const JudgeLabel = Schema.Literals(["yes", "no", "unsure"]);
export type JudgeLabel = typeof JudgeLabel.Type;

const BatchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ id: Schema.String, label: JudgeLabel, reason: Schema.String }),
  ),
});
const decodeBatch = Schema.decodeUnknownSync(BatchResponse);
const decodeJudge = Schema.decodeUnknownSync(JudgeConfig);

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string", enum: ["yes", "no", "unsure"] },
          reason: { type: "string" },
        },
        required: ["id", "label", "reason"],
      },
    },
  },
  required: ["results"],
};

export interface LoadedJudge {
  readonly config: JudgeConfig;
  readonly rubric: string;
  /** sha256 of the judge file; with the rubric hash inside it, names the frozen judge. */
  readonly hash: string;
}

/** Reads the judge file and refuses a rubric whose bytes no longer match its frozen hash. */
export function loadJudge(path: string = DEFAULT_JUDGE_PATH): LoadedJudge {
  const bytes = NodeFS.readFileSync(path);
  const config = decodeJudge(JSON.parse(bytes.toString("utf8")));
  const rubricBytes = NodeFS.readFileSync(NodePath.join(NodePath.dirname(path), config.rubric));
  if (sha256(rubricBytes) !== config.rubric_sha256)
    throw new Error(`${config.rubric} does not match rubric_sha256 in ${path}`);
  return { config, rubric: rubricBytes.toString("utf8"), hash: sha256(bytes) };
}

export interface JudgeEntry {
  readonly id: string;
  readonly text: string;
}

export interface JudgedEntry {
  readonly id: string;
  readonly label: JudgeLabel;
  readonly reason: string;
  /** sha256(rubric hash, model, text): the cache key. */
  readonly key: string;
  readonly call: string;
}

/** Runs the CLI once: system prompt, user prompt on stdin, JSON on stdout. */
export type CliRunner = (args: {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly schema: string;
}) => Promise<string>;

export const claudeCli: CliRunner = ({ model, system, prompt, schema }) =>
  new Promise((resolve, reject) => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "earlyscript-judge-"));
    const child = NodeChildProcess.spawn(
      "claude",
      [
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--json-schema",
        schema,
        "--system-prompt",
        system,
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited with ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.end(prompt);
  });

export interface JudgeOptions {
  readonly judge: LoadedJudge;
  readonly cacheDir: string;
  readonly concurrency?: number;
  readonly cli?: CliRunner;
  readonly log?: (line: string) => void;
}

export interface JudgeStats {
  readonly entries: number;
  readonly cached: number;
  readonly calls: number;
  readonly retries: number;
}

/** Cache key of a label: rubric, model and the text already clipped to max_text_chars. */
export const labelKey = (judge: LoadedJudge, text: string) =>
  sha256(`${judge.config.rubric_sha256}\n${judge.config.model}\n${text}`);

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

interface CliEnvelope {
  readonly structured_output?: unknown;
  readonly result?: string;
  readonly is_error?: boolean;
  readonly usage?: Record<string, unknown>;
  readonly modelUsage?: Record<string, unknown>;
  readonly total_cost_usd?: number;
}

/**
 * Labels every entry, reusing cached labels. Entries with the same text share one label.
 * Uncached texts go to the CLI in batches of `batch_size`, with short positional ids so
 * the model sees no source names or item ids.
 */
export async function judgeEntries(
  entries: ReadonlyArray<JudgeEntry>,
  options: JudgeOptions,
): Promise<{ labels: Array<JudgedEntry>; stats: JudgeStats }> {
  const { judge, cacheDir } = options;
  const cli = options.cli ?? claudeCli;
  const labelsDir = NodePath.join(cacheDir, "labels");
  const callsDir = NodePath.join(cacheDir, "calls");
  NodeFS.mkdirSync(labelsDir, { recursive: true });
  NodeFS.mkdirSync(callsDir, { recursive: true });
  const fileOf = (key: string) => NodePath.join(labelsDir, `${key.slice(7)}.json`);

  const texts = new Map<string, string>();
  for (const entry of entries) {
    const text = clip(entry.text, judge.config.max_text_chars);
    texts.set(labelKey(judge, text), text);
  }
  const pending = [...texts].filter(([key]) => !NodeFS.existsSync(fileOf(key)));
  const cached = texts.size - pending.length;
  const batches: Array<Array<[string, string]>> = [];
  for (let k = 0; k < pending.length; k += judge.config.batch_size)
    batches.push(pending.slice(k, k + judge.config.batch_size));

  let calls = 0;
  let retries = 0;
  const runBatch = async (batch: Array<[string, string]>) => {
    const positional = batch.map(([key, text], k) => ({ id: `e${k + 1}`, key, text }));
    const prompt = `${judge.config.question}\nLabel every entry of this JSON list.\n\n${JSON.stringify(
      positional.map(({ id, text }) => ({ id, text })),
    )}`;
    for (let attempt = 0; ; attempt++) {
      calls++;
      const started = new Date().toISOString();
      let failure: string;
      try {
        const raw = await cli({
          model: judge.config.model,
          system: judge.rubric,
          prompt,
          schema: JSON.stringify(RESPONSE_SCHEMA),
        });
        const envelope = JSON.parse(raw) as CliEnvelope;
        const output =
          envelope.structured_output ?? (envelope.result ? JSON.parse(envelope.result) : null);
        const { results } = decodeBatch(output);
        const byId = new Map(results.map((r) => [r.id, r]));
        if (byId.size !== positional.length || positional.some((p) => !byId.has(p.id)))
          throw new Error(`response has ${byId.size} ids for ${positional.length} entries`);
        const call = sha256(canonicalJson({ prompt, started, attempt }));
        NodeFS.writeFileSync(
          NodePath.join(callsDir, `${call.slice(7)}.json`),
          `${JSON.stringify(
            {
              call,
              started_at: started,
              judge_hash: judge.hash,
              rubric_sha256: judge.config.rubric_sha256,
              model: judge.config.model,
              prompt_sha256: sha256(prompt),
              prompt,
              entries: positional.map(({ id, key }) => ({ id, key })),
              results,
              usage: envelope.usage ?? null,
              model_usage: envelope.modelUsage ?? null,
              total_cost_usd: envelope.total_cost_usd ?? null,
            },
            null,
            2,
          )}\n`,
        );
        for (const p of positional) {
          const r = byId.get(p.id)!;
          NodeFS.writeFileSync(
            fileOf(p.key),
            `${JSON.stringify({ key: p.key, text_sha256: sha256(p.text), label: r.label, reason: r.reason, call })}\n`,
          );
        }
        return;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (attempt >= 2) throw new Error(`judge batch failed three times: ${failure}`);
      retries++;
      options.log?.(`judge: retry after ${failure.slice(0, 200)}`);
    }
  };

  const queue = [...batches];
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 2) }, async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      await runBatch(batch);
      options.log?.(`judge: ${batches.length - queue.length}/${batches.length} batches`);
    }
  });
  await Promise.all(workers);

  const labels = entries.map((entry): JudgedEntry => {
    const key = labelKey(judge, clip(entry.text, judge.config.max_text_chars));
    const stored = JSON.parse(NodeFS.readFileSync(fileOf(key), "utf8")) as {
      label: JudgeLabel;
      reason: string;
      call: string;
    };
    return { id: entry.id, label: stored.label, reason: stored.reason, key, call: stored.call };
  });
  return { labels, stats: { entries: entries.length, cached, calls, retries } };
}

async function main(): Promise<void> {
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
    process.exitCode = 64;
    return;
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
}

if (import.meta.main) await main();
