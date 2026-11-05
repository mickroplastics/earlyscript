// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalConsole:off - runs inside the sandbox as a plain script.
// One arm at one cutoff: runs the engine of the tree it is given (the installed one or a code
// candidate's copy) and writes arm.json next to its run. It sees no labels and no evaluator;
// the worker checks what it writes against the corpus.
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

interface Dossier {
  readonly trend: {
    readonly id: string;
    readonly label: string;
    readonly stage: string;
    readonly items_7d: number;
  };
  readonly rankings: {
    readonly eligible: number;
    readonly weighted: {
      readonly position: number;
      readonly score: number;
      readonly components: ReadonlyArray<{
        name: string;
        value: number | null;
        weight: number;
        contribution: number;
      }>;
    };
  };
}

const flag = process.argv.indexOf("--spec");
const specPath = flag < 0 ? undefined : process.argv[flag + 1];
if (specPath === undefined) {
  console.error("usage: arm.ts --spec <arm-spec.json>");
  process.exit(2);
}
const spec = JSON.parse(NodeFS.readFileSync(specPath, "utf8")) as ArmRunSpec;
const started = Date.now();
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
const dossierDir = NodePath.join(runsDir, record.run_id, "dossiers");
const dossiers = NodeFS.existsSync(dossierDir)
  ? NodeFS.readdirSync(dossierDir)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(NodeFS.readFileSync(NodePath.join(dossierDir, name), "utf8")) as Dossier,
      )
  : [];
const top = dossiers
  .toSorted((a, b) => a.rankings.weighted.position - b.rankings.weighted.position)
  .slice(0, spec.top)
  .map((dossier) => ({
    position: dossier.rankings.weighted.position,
    trend_id: dossier.trend.id,
    label: dossier.trend.label,
    stage: dossier.trend.stage,
    score: dossier.rankings.weighted.score,
    components: dossier.rankings.weighted.components,
    items_7d: dossier.trend.items_7d,
    item_ids: [...(members.get(dossier.trend.id) ?? [])],
  }));
NodeFS.writeFileSync(
  NodePath.join(spec.out_dir, "arm.json"),
  `${JSON.stringify({
    run_id: record.run_id,
    status: record.status,
    error: record.error ?? null,
    logical_hash: record.logical_hash,
    config_hash: record.config_hash,
    profile_hash: record.profile.hash,
    eligible: dossiers[0]?.rankings.eligible ?? 0,
    top,
    duration_ms: Date.now() - started,
  })}\n`,
);
