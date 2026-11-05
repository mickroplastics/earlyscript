// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalConsole:off - runs inside the sandbox as a plain script.
// One arm at one cutoff: runs the engine of the tree it is given (the installed one or a code
// candidate's copy), which may be hostile. It sees no labels, no evaluator and no secret.
//   node arm.ts --spec <arm-spec.json>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface ArmRunSpec {
  readonly engine_src: string;
  readonly corpus_dir: string;
  readonly cutoff: string;
  readonly profile_path: string;
  readonly config_path: string;
  readonly out_dir: string;
  readonly cache_file: string | null;
  readonly cache_only: boolean;
  readonly models_dir: string | null;
  readonly embedder: "local" | "synthetic";
  readonly workers: number;
  readonly top: number;
}

const flag = process.argv.indexOf("--spec");
const specPath = flag < 0 ? undefined : process.argv[flag + 1];
if (specPath === undefined) {
  console.error("usage: arm.ts --spec <arm-spec.json>");
  process.exit(2);
}
const spec = JSON.parse(NodeFS.readFileSync(specPath, "utf8")) as ArmRunSpec;
const moduleOf = (file: string) => NodeURL.pathToFileURL(NodePath.join(spec.engine_src, file)).href;
const engine = (await import(moduleOf("run.ts"))) as {
  runEngine: (options: Record<string, unknown>) => Promise<{
    run_id: string;
    status: string;
    error: unknown;
    config_hash: string;
    profile: { hash: string };
    logical_hash: string | null;
  }>;
};
const embedder =
  spec.embedder === "synthetic"
    ? (
        (await import(moduleOf("embed/fingerprint.ts"))) as { fingerprintEmbedder: () => unknown }
      ).fingerprintEmbedder()
    : undefined;
const members = new Map<string, ReadonlyArray<string>>();
const runsDir = NodePath.join(spec.out_dir, "runs");
NodeFS.mkdirSync(runsDir, { recursive: true });
const record = await engine.runEngine({
  corpusDir: spec.corpus_dir,
  cutoff: spec.cutoff,
  profilePath: spec.profile_path,
  outDir: runsDir,
  config: JSON.parse(NodeFS.readFileSync(spec.config_path, "utf8")),
  ...(embedder === undefined ? {} : { embedder }),
  ...(spec.cache_file === null ? {} : { cacheFile: spec.cache_file }),
  cacheOnly: spec.cache_only,
  ...(spec.models_dir === null ? {} : { modelDir: spec.models_dir }),
  workers: spec.workers,
  onEmitted: (trends: ReadonlyArray<{ id: string; itemIds: ReadonlyArray<string> }>) => {
    for (const trend of trends) members.set(trend.id, trend.itemIds);
  },
});
// Raw output only: the engine wrote run.json and the dossiers; this adds each emitted trend's
// members. The worker, in another process that loads no candidate code, reads and checks all of
// it and computes every hash it reports; nothing written here is taken on trust.
NodeFS.writeFileSync(
  NodePath.join(spec.out_dir, "members.json"),
  `${JSON.stringify({ run_id: record.run_id, members: Object.fromEntries(members) })}\n`,
);
