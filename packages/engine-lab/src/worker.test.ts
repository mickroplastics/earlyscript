// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - the worker runs the real engine over a synthetic corpus.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { textsOf } from "./cacheView.ts";
import { developmentReport } from "./compare.ts";
import { canonicalInputs } from "./inputs.ts";
import { subsetCorpus } from "./corpusSubset.ts";
import { readLabelSource } from "./labels.ts";
import { hashCorpus } from "@earlyscript/trend-engine/corpus";

import { sha256 } from "./hash.ts";
import { resultMismatch } from "./result.ts";
import { corpusIdentity, treeHash } from "./view.ts";
import { jobSpec, labFixture, patchCandidate, weightCandidate } from "./testkit.ts";
import { bwrapAvailable, evaluateJob, snapshotOutput } from "./worker.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-lab-worker-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const fixture = labFixture(NodePath.join(root, "fixture"));
const options = {
  jobsRoot: NodePath.join(root, "jobs"),
  engineRoot: NodePath.resolve(import.meta.dirname, "../../.."),
};
const human = readLabelSource({
  cardsPath: fixture.cards_path,
  labelsPath: fixture.labels_path,
  kind: "human",
});

describe("worker", () => {
  it("runs both arms on the real engine, signs the outputs, and the evaluator scores them", async () => {
    const candidate = weightCandidate(fixture, { growth: 0.1, log_authors_7d: 0.9 });
    const spec = jobSpec(fixture, { token: "job-worker-better", candidate });
    const result = await evaluateJob(spec, options);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(resultMismatch(spec, result)).toBeNull();
    expect(result.arms.reference.map((arm) => arm.config_hash)).toEqual(
      spec.cutoffs.map(() => fixture.installed.config_hash),
    );
    const report = developmentReport({
      result,
      campaignId: "c",
      cutoffs: spec.cutoffs,
      human,
      judge: null,
    });
    expect(report.human?.reference.coverage).toBe(1);
    expect(report.human?.verdict).toBe("better");
    expect(report.equivalent).toBe(false);

    // A second call with the same token answers the stored result and runs nothing.
    const again = await evaluateJob(spec, options);
    expect(again).toEqual(result);

    // Any edit of the signed outputs is refused, even with a success status.
    const first = result.arms.candidate[0]!;
    const forged = {
      ...result,
      arms: {
        ...result.arms,
        candidate: [{ ...first, top: first.top.toReversed() }, ...result.arms.candidate.slice(1)],
      },
    };
    expect(resultMismatch(spec, forged)).toBe("the result signature does not match its content");
    expect(resultMismatch({ ...spec, secret: "another" }, result)).toBe(
      "the result signature does not match its content",
    );
  });

  it("scores a worse candidate as worse", async () => {
    const candidate = weightCandidate(fixture, { growth: 2, log_authors_7d: 0 });
    const spec = jobSpec(fixture, { token: "job-worker-worse", candidate });
    const result = await evaluateJob(spec, options);
    const report = developmentReport({
      result,
      campaignId: "c",
      cutoffs: spec.cutoffs,
      human,
      judge: null,
    });
    expect(report.human?.verdict).toBe("worse");
  });

  it("runs the engine over a copy of some days of a corpus, which verifies against its manifest", async () => {
    const copy = subsetCorpus({
      from: fixture.corpus_dir,
      out: NodePath.join(root, "subset"),
      sources: ["hn", "github"],
      fromDay: "2026-12-01",
      toDay: "2026-12-17",
    });
    expect(copy.files).toBeGreaterThan(0);
    const spec = jobSpec(fixture, {
      token: "job-worker-subset",
      candidate: weightCandidate(fixture, { growth: 0.2 }),
      cutoffs: [fixture.cutoffs[0]!],
    });
    const result = await evaluateJob(
      {
        ...spec,
        corpus_dir: copy.out,
        input_roots: [root],
        inputs: { ...spec.inputs, corpus_hash: copy.corpus_hash },
      },
      options,
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
  });

  it("refuses the frozen evaluation's cutoffs before running anything", async () => {
    const spec = jobSpec(fixture, {
      token: "job-worker-sealed",
      candidate: weightCandidate(fixture, { growth: 0.2 }),
      cutoffs: ["2026-11-06T00:00:00.000Z"],
    });
    const result = await evaluateJob(spec, options);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("sealed-partition");
    expect(NodeFS.existsSync(NodePath.join(options.jobsRoot, spec.token, "reference"))).toBe(false);
  });

  it("refuses code whose files differ from the candidate's manifest", async () => {
    const patched = patchCandidate(fixture, RANK_PATCH("// harmless\n"));
    const spec = jobSpec(fixture, {
      token: "job-worker-mismatch",
      candidate: patched.manifest,
      files: {
        "packages/trend-engine/src/rank.ts": `${patched.files["packages/trend-engine/src/rank.ts"]}\n// edited`,
      },
    });
    const result = await evaluateJob(spec, options);
    expect(result.error?.code).toBe("artifact-mismatch");
  });

  it("runs a code candidate in bwrap: no network, no files outside its inputs, only its cutoff's view", async () => {
    expect(bwrapAvailable()).toBe(true);
    const secret = NodePath.join(root, "labels-miguel.json");
    NodeFS.writeFileSync(secret, "{}");
    const days = NodeFS.readdirSync(NodePath.join(fixture.corpus_dir, "hn")).toSorted();
    const later = days.at(-1)!;
    const probe = [
      'import * as NodeFS from "node:fs";',
      "const probe: Record<string, string> = {};",
      'const armSpec = JSON.parse(NodeFS.readFileSync(process.argv[process.argv.indexOf("--spec") + 1]!, "utf8"));',
      `try { NodeFS.readFileSync(${JSON.stringify(secret)}); probe.labels = "read"; } catch (e) { probe.labels = String((e as { code?: string }).code); }`,
      'try { NodeFS.writeFileSync(armSpec.corpus_dir + "/x", "x"); probe.corpus = "written"; } catch (e) { probe.corpus = String((e as { code?: string }).code); }',
      `try { NodeFS.readFileSync(${JSON.stringify(NodePath.join(fixture.corpus_dir, "hn", later))}); probe.original = "read"; } catch (e) { probe.original = String((e as { code?: string }).code); }`,
      `try { NodeFS.readFileSync(armSpec.corpus_dir + "/hn/${later}"); probe.later = "read"; } catch (e) { probe.later = String((e as { code?: string }).code); }`,
      'probe.latest = NodeFS.readdirSync(armSpec.corpus_dir + "/hn").toSorted().at(-1) ?? "";',
      'try { process.getBuiltinModule("child_process").execSync("true"); probe.child = "ran"; } catch (e) { probe.child = String((e as { code?: string }).code); }',
      'try { NodeFS.writeFileSync(armSpec.out_dir + "/../../witness.txt", "x"); probe.jobDir = "written"; } catch (e) { probe.jobDir = String((e as { code?: string }).code); }',
      'try { (() => {})["con" + "structor"]("return 1")(); probe.codegen = "ran"; } catch (e) { probe.codegen = (e as Error).name; }',
      'try { await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) }); probe.network = "reached"; } catch (e) { probe.network = "unreachable"; }',
      'NodeFS.writeFileSync("probe.json", JSON.stringify(probe));',
      "",
    ].join("\n");
    const patched = patchCandidate(fixture, RANK_PATCH(probe), { pure: false });
    const spec = jobSpec(fixture, {
      token: "job-worker-sandbox",
      candidate: patched.manifest,
      files: patched.files,
    });
    const result = await evaluateJob(spec, options);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.executor.sandbox).toBe("bwrap");
    const day = spec.cutoffs[0]!.slice(0, 10);
    const seen = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(options.jobsRoot, spec.token, "candidate", day, "probe.json"),
        "utf8",
      ),
    );
    // Sol, B1: the whole corpus is not mounted, and its view stops before the cutoff. Node's
    // permissions refuse first; bwrap, under them, hides the rest (pure: false skips the
    // text filter so that this second boundary is what is tested).
    expect(seen).toMatchObject({
      labels: "ERR_ACCESS_DENIED",
      corpus: "ERR_ACCESS_DENIED",
      original: "ERR_ACCESS_DENIED",
      later: "ENOENT",
      network: "unreachable",
      child: "ERR_ACCESS_DENIED",
      jobDir: "ERR_ACCESS_DENIED",
      codegen: "EvalError",
    });
    expect(later > day).toBe(true);
    expect(`${seen.latest}` < `${day}.jsonl`).toBe(true);
    // The probe changes no output: the candidate is logically equal to the reference.
    expect(
      developmentReport({ result, campaignId: "c", cutoffs: spec.cutoffs, human, judge: null })
        .equivalent,
    ).toBe(true);
  });
});

/** A copy of the fixture's corpus with `edit` applied to one day file, its manifest rewritten. */
function editedCorpus(name: string, day: string, edit: (text: string) => string): string {
  const copy = NodePath.join(root, name);
  NodeFS.cpSync(fixture.corpus_dir, copy, { recursive: true });
  const file = NodePath.join(copy, "hn", `${day}.jsonl`);
  const text = edit(NodeFS.readFileSync(file, "utf8"));
  NodeFS.writeFileSync(file, text);
  rewriteManifest(copy);
  return copy;
}

function rewriteManifest(dir: string) {
  const path = NodePath.join(dir, "corpus-manifest.json");
  const manifest = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  manifest.files = manifest.files.map((entry: { path: string }) => {
    const bytes = NodeFS.readFileSync(NodePath.join(dir, entry.path));
    return { path: entry.path, sha256: sha256(bytes), bytes: bytes.length };
  });
  manifest.corpus_hash = hashCorpus(manifest);
  NodeFS.writeFileSync(path, JSON.stringify(manifest, null, 2));
}

const retitle = (text: string) =>
  text
    .split("\n")
    .map((line) =>
      line.trim() === ""
        ? line
        : JSON.stringify({
            ...JSON.parse(line),
            title: `${JSON.parse(line).title} (edited later)`,
          }),
    )
    .join("\n");

describe("a cutoff sees only its past (Sol B1, Astra B2)", () => {
  const candidate = weightCandidate(fixture, { growth: 0.1, log_authors_7d: 0.9 });
  const cutoffs = fixture.cutoffs.slice(0, 2);
  const lastDay = NodeFS.readdirSync(NodePath.join(fixture.corpus_dir, "hn"))
    .toSorted()
    .at(-1)!
    .slice(0, 10);

  it("gives the same result for a past cutoff whatever was published after it", async () => {
    const base = await evaluateJob(
      jobSpec(fixture, { token: "job-view-base", candidate, cutoffs }),
      options,
    );
    expect(base.status, JSON.stringify(base.error)).toBe("ok");
    expect(lastDay > cutoffs.at(-1)!.slice(0, 10)).toBe(true);
    const changed = editedCorpus("future-edited", lastDay, retitle);
    const spec = jobSpec(fixture, { token: "job-view-future-edited", candidate, cutoffs });
    const after = await evaluateJob(
      {
        ...spec,
        corpus_dir: changed,
        input_roots: [root],
        inputs: { ...spec.inputs, corpus_hash: corpusIdentity(changed) },
      },
      options,
    );
    expect(after.status, JSON.stringify(after.error)).toBe("ok");
    expect(after.inputs.corpus_hash).not.toBe(base.inputs.corpus_hash);
    expect(after.views.map((view) => view.corpus_hash)).toEqual(
      base.views.map((view) => view.corpus_hash),
    );
    for (const side of ["reference", "candidate"] as const) {
      expect(after.arms[side].map((arm) => [arm.logical_hash, arm.members_hash])).toEqual(
        base.arms[side].map((arm) => [arm.logical_hash, arm.members_hash]),
      );
    }
  });

  it("refuses a corpus, or a model directory, edited under the same path, also when it recovers a stored result", async () => {
    const copy = NodePath.join(root, "identity-corpus");
    NodeFS.cpSync(fixture.corpus_dir, copy, { recursive: true });
    const models = NodePath.join(root, "identity-models");
    NodeFS.mkdirSync(models, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(models, "weights.bin"), "v1");
    const spec = jobSpec(fixture, { token: "job-identity", candidate, cutoffs: [cutoffs[0]!] });
    const fixed = {
      ...spec,
      corpus_dir: copy,
      models_dir: models,
      input_roots: [root],
      inputs: { corpus_hash: corpusIdentity(copy), models_hash: treeHash(models) },
    };
    const ok = await evaluateJob(fixed, options);
    expect(ok.status, JSON.stringify(ok.error)).toBe("ok");

    // The corpus, edited and re-manifested at the same path: another identity.
    const firstDay = NodeFS.readdirSync(NodePath.join(copy, "hn")).toSorted()[0]!;
    NodeFS.writeFileSync(
      NodePath.join(copy, "hn", firstDay),
      retitle(NodeFS.readFileSync(NodePath.join(copy, "hn", firstDay), "utf8")),
    );
    rewriteManifest(copy);
    const fresh = await evaluateJob({ ...fixed, token: "job-identity-corpus" }, options);
    expect(fresh.error?.code).toBe("artifact-mismatch");
    expect(fresh.error?.message).toContain("not the campaign's");
    // The stored result of the same token is not handed back over the edited corpus.
    const recovered = await evaluateJob(fixed, options);
    expect(recovered.status).toBe("failed");
    expect(recovered.error?.code).toBe("artifact-mismatch");

    // An edit the manifest does not list fails too.
    NodeFS.appendFileSync(NodePath.join(copy, "hn", firstDay), "\n");
    expect(
      (
        await evaluateJob(
          {
            ...fixed,
            token: "job-identity-unlisted",
            inputs: { ...fixed.inputs, corpus_hash: null },
          },
          options,
        )
      ).error?.code,
    ).toBe("artifact-mismatch");

    // The models, edited in place.
    const clean = NodePath.join(root, "identity-corpus-2");
    NodeFS.cpSync(fixture.corpus_dir, clean, { recursive: true });
    const withModels = {
      ...fixed,
      corpus_dir: clean,
      inputs: { ...fixed.inputs, corpus_hash: corpusIdentity(clean) },
    };
    NodeFS.writeFileSync(NodePath.join(models, "weights.bin"), "v2");
    const edited = await evaluateJob({ ...withModels, token: "job-identity-models" }, options);
    expect(edited.error?.code).toBe("artifact-mismatch");
    expect(edited.error?.message).toContain("models");
  });

  it("runs a shadow cutoff only once it has passed and its previous day is covered", async () => {
    const cutoff = cutoffs[0]!;
    const spec = jobSpec(fixture, {
      token: "job-shadow-early",
      candidate,
      cutoffs: [cutoff],
      kind: "shadow",
    });
    const early = await evaluateJob(spec, {
      ...options,
      now: () => Date.parse(cutoff) - 3_600_000,
    });
    expect(early.error?.code).toBe("insufficient-evidence");
    expect(NodeFS.existsSync(NodePath.join(options.jobsRoot, spec.token, "result.json"))).toBe(
      false,
    );
    const observedAt = Date.parse(cutoff) + 3_600_000;
    const late = await evaluateJob(spec, { ...options, now: () => observedAt });
    expect(late.status, JSON.stringify(late.error)).toBe("ok");
    expect(late.views[0]!.observed_at).toBe(new Date(observedAt).toISOString());
    expect(resultMismatch(spec, late)).toBeNull();
    // A signed view dated before its cutoff is refused by the server's check.
    expect(
      resultMismatch(spec, {
        ...late,
        views: [{ ...late.views[0]!, observed_at: new Date(Date.parse(cutoff) - 1).toISOString() }],
      }),
    ).not.toBeNull();

    // A cutoff past the corpus' last covered day is not closed yet.
    const open = new Date(Date.parse(`${lastDay}T00:00:00.000Z`) + 3 * 86_400_000).toISOString();
    const unclosed = await evaluateJob(
      jobSpec(fixture, {
        token: "job-shadow-unclosed",
        candidate,
        cutoffs: [open],
        kind: "shadow",
      }),
      { ...options, now: () => Date.parse(open) + 86_400_000 },
    );
    expect(unclosed.error?.code).toBe("insufficient-evidence");
    expect(unclosed.error?.message).toContain("does not cover");
  });

  it("kills an arm that runs past its time limit and fails the job", async () => {
    const patched = patchCandidate(fixture, RANK_PATCH("for (;;) {}\n"));
    const result = await evaluateJob(
      jobSpec(fixture, {
        token: "job-limit-time",
        candidate: patched.manifest,
        files: patched.files,
        cutoffs: [cutoffs[0]!],
        limits: { arm_timeout_ms: 4_000, memory_mb: 512 },
      }),
      options,
    );
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.message).toContain("ran past 4000 ms");
  });
});

describe("worker against a hostile candidate (Sol, B1)", () => {
  // Sol's repro-worker.ts: the patch rebinds node:fs inside the arm to rewrite its output.
  const poison = (
    target: string,
    rewrite: string,
    condition = `String(file).endsWith(${JSON.stringify(target)})`,
  ) =>
    [
      'import fsPoison from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const originalWrite = fsPoison.writeFileSync;",
      "fsPoison.writeFileSync = function (file: unknown, data: unknown, ...args: Array<unknown>) {",
      `  if (${condition}) {`,
      "    const value = JSON.parse(String(data));",
      `    ${rewrite}`,
      "    return (originalWrite as Function).call(this, file, JSON.stringify(value), ...args);",
      "  }",
      "  return (originalWrite as Function).call(this, file, data, ...args);",
      "} as typeof fsPoison.writeFileSync;",
      "syncBuiltinESMExports();",
      "",
    ].join("\n");
  const runForged = async (token: string, text: string) => {
    const patched = patchCandidate(fixture, RANK_PATCH(text), { pure: false });
    const spec = jobSpec(fixture, {
      token,
      candidate: patched.manifest,
      files: patched.files,
      cutoffs: fixture.cutoffs.slice(0, 1),
    });
    return { spec, result: await evaluateJob(spec, options) };
  };

  it("ignores a forged arm.json: the ranking comes from the run the engine wrote", async () => {
    const { spec, result } = await runForged(
      "job-b1-arm-json",
      poison("/arm.json", "value.top = []; value.eligible = 0;"),
    );
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(resultMismatch(spec, result)).toBeNull();
    const reference = result.arms.reference[0]!;
    const candidate = result.arms.candidate[0]!;
    expect(reference.top.length).toBeGreaterThan(0);
    expect(candidate.top.map((t) => t.trend_id)).toEqual(reference.top.map((t) => t.trend_id));
  });

  it("rejects a run.json that no longer matches its dossiers, whatever hash it claims", async () => {
    const { result } = await runForged(
      "job-b1-run-json",
      poison("/run.json", "value.files = []; value.dossiers = 0;"),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("artifact-mismatch");
    expect(result.error?.message).toContain("logical hash is not the hash of its dossiers");
  });

  it("rejects dossiers rewritten after the engine hashed them", async () => {
    const { result } = await runForged(
      "job-b1-dossier",
      poison("", "value.rankings.weighted.score = 99;", 'String(file).includes("/dossiers/")'),
    );
    expect(result.error?.code).toBe("artifact-mismatch");
  });

  it("rejects members that drop a dossier's evidence", async () => {
    const { result } = await runForged(
      "job-b1-members",
      poison("/members.json", "for (const k of Object.keys(value.members)) value.members[k] = [];"),
    );
    expect(result.error?.code).toBe("artifact-mismatch");
    expect(result.error?.message).toContain("do not contain its evidence");
  });
});

describe("an arm's output read as untrusted (Sol, B1-R2)", () => {
  // Sol's repro-symlink-output.ts: at exit the candidate swaps its output for links to the
  // reference arm's, and scores everything -999.
  const exitLinks = [
    'import solFs from "node:fs";',
    'process.on("exit", () => {',
    "  const here = process.cwd();",
    '  const ref = here.replace("/candidate/", "/reference/");',
    '  solFs.renameSync(here + "/runs", here + "/actual-runs");',
    '  solFs.renameSync(here + "/members.json", here + "/actual-members.json");',
    '  solFs.symlinkSync(ref + "/runs", here + "/runs");',
    '  solFs.symlinkSync(ref + "/members.json", here + "/members.json");',
    "});",
    "",
  ].join("\n");

  it("refuses links in the output instead of reading the reference through them", async () => {
    // Node's permissions no longer let the arm point a link outside its own output.
    const patched = patchCandidate(fixture, RANK_PATCH(exitLinks), { pure: false });
    const spec = jobSpec(fixture, {
      token: "job-b1r2-links",
      candidate: patched.manifest,
      files: patched.files,
      cutoffs: fixture.cutoffs.slice(0, 1),
    });
    const result = await evaluateJob(spec, options);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("engine-failed");
    expect(result.error?.message).toContain("ERR_ACCESS_DENIED");
    // Node refuses any link the arm makes, even inside its own output; the collector, the
    // boundary behind it, still refuses a link it finds, whatever it names.
    const own = NodePath.join(root, "own-links");
    NodeFS.mkdirSync(NodePath.join(own, "actual-runs"), { recursive: true });
    NodeFS.symlinkSync(NodePath.join(own, "actual-runs"), NodePath.join(own, "runs"));
    expect(() =>
      snapshotOutput(own, NodePath.join(root, "own-links.collected"), (m) => new Error(m)),
    ).toThrow("is a link");
  });

  it("refuses a run.json that names files outside its dossiers", async () => {
    const rewrite = [
      'import fsPoison from "node:fs";',
      'process.on("exit", () => {',
      '  const dir = process.cwd() + "/runs";',
      '  const run = fsPoison.readdirSync(dir).find((name) => name.startsWith("run_"));',
      '  const file = dir + "/" + run + "/run.json";',
      '  const value = JSON.parse(fsPoison.readFileSync(file, "utf8"));',
      '  value.files = ["../../../reference/x/run.json"];',
      "  fsPoison.writeFileSync(file, JSON.stringify(value));",
      "});",
      "",
    ].join("\n");
    const patched = patchCandidate(fixture, RANK_PATCH(rewrite), { pure: false });
    const result = await evaluateJob(
      jobSpec(fixture, {
        token: "job-b1r2-files",
        candidate: patched.manifest,
        files: patched.files,
        cutoffs: fixture.cutoffs.slice(0, 1),
      }),
      options,
    );
    expect(result.error?.code).toBe("artifact-mismatch");
    expect(result.error?.message).toContain("outside its own dossiers");
  });
});

describe("inputs resolved to their canonical paths (Sol, B2)", () => {
  const sealedRoot = NodePath.join(root, "eval-prospectivo");
  const sealed = labFixture(NodePath.join(sealedRoot, "fake"));
  const spec = (token: string, patch: Partial<ReturnType<typeof jobSpec>>) => ({
    ...jobSpec(fixture, {
      token,
      candidate: weightCandidate(fixture, { growth: 0.1 }),
      cutoffs: [fixture.cutoffs[0]!],
    }),
    input_roots: [root],
    ...patch,
  });

  it("refuses a corpus link to a sealed directory", async () => {
    const alias = NodePath.join(root, "friendly-corpus");
    NodeFS.symlinkSync(sealed.corpus_dir, alias);
    const result = await evaluateJob(spec("job-b2-dir-link", { corpus_dir: alias }), options);
    expect(result.error?.code).toBe("sealed-partition");
    expect(NodeFS.existsSync(NodePath.join(options.jobsRoot, "job-b2-dir-link", "reference"))).toBe(
      false,
    );
  });

  it("refuses a day file inside the corpus that links to a sealed file", async () => {
    const copy = NodePath.join(root, "linked-day-corpus");
    NodeFS.cpSync(fixture.corpus_dir, copy, { recursive: true });
    const day = NodeFS.readdirSync(NodePath.join(copy, "hn"))[0]!;
    NodeFS.rmSync(NodePath.join(copy, "hn", day));
    NodeFS.symlinkSync(NodePath.join(sealed.corpus_dir, "hn", day), NodePath.join(copy, "hn", day));
    const result = await evaluateJob(spec("job-b2-file-link", { corpus_dir: copy }), options);
    expect(result.error?.code).toBe("sealed-partition");
  });

  it("refuses a profile or a cache that resolves outside the authorized roots or into a sealed path", async () => {
    const elsewhere = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-lab-outside-"));
    try {
      const profileLink = NodePath.join(root, "profile-link.json");
      NodeFS.copyFileSync(fixture.profile_path, NodePath.join(elsewhere, "profile.json"));
      NodeFS.symlinkSync(NodePath.join(elsewhere, "profile.json"), profileLink);
      const outside = await evaluateJob(
        spec("job-b2-profile", { profile_path: profileLink }),
        options,
      );
      expect(outside.error?.code).toBe("permission-denied");
      const cacheLink = NodePath.join(root, "cache-link");
      NodeFS.symlinkSync(sealedRoot, cacheLink);
      const cache = await evaluateJob(
        spec("job-b2-cache", { cache_file: NodePath.join(cacheLink, "embeddings.sqlite") }),
        options,
      );
      expect(cache.error?.code).toBe("sealed-partition");
    } finally {
      NodeFS.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses labels through a link, on the evaluator's side too", () => {
    const labels = NodePath.join(root, "labels-link.json");
    NodeFS.symlinkSync(sealed.labels_path, labels);
    expect(() => canonicalInputs([root], [{ path: labels, kind: "file" }])).toThrow(
      /frozen evaluation/,
    );
  });
});

describe("cutoffs are distinct days (Sol, B3)", () => {
  it("refuses a job that repeats a day", async () => {
    const day = fixture.cutoffs[6]!;
    const result = await evaluateJob(
      jobSpec(fixture, {
        token: "job-b3-repeat",
        candidate: weightCandidate(fixture, { growth: 0.1 }),
        cutoffs: Array(7).fill(day),
      }),
      options,
    );
    expect(result.error?.code).toBe("invalid-change");
  });
});

/** A patch that inserts `text` after rank.ts's first line. */
function RANK_PATCH(text: string): string {
  const rank = NodeFS.readFileSync(
    NodePath.resolve(import.meta.dirname, "../../trend-engine/src/rank.ts"),
    "utf8",
  ).split("\n");
  const added = text.split("\n").filter((line, k, all) => k < all.length - 1 || line !== "");
  return [
    "--- a/packages/trend-engine/src/rank.ts",
    "+++ b/packages/trend-engine/src/rank.ts",
    `@@ -1,2 +1,${2 + added.length} @@`,
    ` ${rank[0]}`,
    ...added.map((line) => `+${line}`),
    ` ${rank[1]}`,
    "",
  ].join("\n");
}

describe("capabilities checked when the candidate runs (Opus B1, Astra B1)", () => {
  // Their reviews' patches: both pass the text filter, which is only a first layer.
  const astra = [
    'const astraHost = (() => {})["con" + "structor"]("return pro" + "cess")();',
    `astraHost.getBuiltinModule("fs").writeFileSync(${JSON.stringify(NodePath.join(root, "astra-witness.txt"))}, "x");`,
    "",
  ].join("\n");
  const opus = [
    'const k = "constr" + "uctor";',
    'const g = ((x: number) => x)[k]("return this")();',
    'const cp = g["pro" + "cess"]["getBuiltin" + "Module"]("child" + "_pro" + "cess");',
    `cp.execSync(${JSON.stringify(`touch ${NodePath.join(root, "opus-witness.txt")}`)});`,
    "",
  ].join("\n");

  it.each([
    ["Astra's", astra, "astra-witness.txt"],
    ["Opus'", opus, "opus-witness.txt"],
  ])(
    "%s patch passes the text filter, and the run refuses the code it builds",
    async (_who, text, witness) => {
      const patched = patchCandidate(fixture, RANK_PATCH(text));
      const result = await evaluateJob(
        jobSpec(fixture, {
          token: `job-capability-${witness.split("-")[0]}`,
          candidate: patched.manifest,
          files: patched.files,
          cutoffs: fixture.cutoffs.slice(0, 1),
        }),
        options,
      );
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("EvalError");
      expect(NodeFS.existsSync(NodePath.join(root, witness))).toBe(false);
    },
  );
});

describe("models and cache entries fixed for both arms (Astra B2)", () => {
  const candidate = weightCandidate(fixture, { growth: 0.2 });
  const cutoffs = fixture.cutoffs.slice(0, 2);

  it("refuses models changed between the arms, at the first acceptance", async () => {
    const models = NodePath.join(root, "between-models");
    NodeFS.mkdirSync(models, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(models, "weights.bin"), "v1");
    const spec = jobSpec(fixture, { token: "job-models-between", candidate, cutoffs });
    const result = await evaluateJob(
      {
        ...spec,
        models_dir: models,
        input_roots: [root],
        inputs: { ...spec.inputs, models_hash: treeHash(models) },
      },
      {
        ...options,
        log: (line) => {
          if (JSON.parse(line).side === "candidate")
            NodeFS.writeFileSync(NodePath.join(models, "weights.bin"), "v2");
        },
      },
    );
    expect(result.error?.code).toBe("artifact-mismatch");
    expect(result.error?.message).toContain("models changed while the job ran");
  });

  // A shared cache with a vector for every text the fixture's cutoffs embed.
  const shared = NodePath.join(root, "shared-cache.sqlite");
  const vectorOf = (text: string, salt = "") => {
    const vector = new Float32Array(1024);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? ["empty"];
    for (const word of words) {
      const digest = NodeCrypto.createHash("sha256").update(`${salt}${word}`).digest();
      for (let k = 0; k < 16; k++) vector[digest[k]! * 4 + (k % 4)]! += 1;
    }
    const norm = Math.hypot(...vector);
    return new Uint8Array(vector.map((x) => x / norm).buffer);
  };
  const fill = async () => {
    NodeFS.rmSync(shared, { force: true });
    const db = new NodeSqlite.DatabaseSync(shared);
    db.exec(
      "CREATE TABLE embeddings (embedding_key TEXT NOT NULL, text_hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (embedding_key, text_hash)) STRICT;",
    );
    const insert = db.prepare("INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?)");
    for (const cutoff of cutoffs) {
      const { key, texts } = await textsOf({
        engineRoot: options.engineRoot,
        corpusDir: fixture.corpus_dir,
        cutoff,
        profilePath: fixture.profile_path,
        config: fixture.config,
      });
      for (const text of texts) insert.run(key, sha256(text), vectorOf(text));
    }
    db.close();
  };
  const set = (sql: string, ...values: Array<string | Uint8Array>) => {
    const db = new NodeSqlite.DatabaseSync(shared);
    db.prepare(sql).run(...values);
    db.close();
  };
  const cacheSpec = (token: string) => ({
    ...jobSpec(fixture, { token, candidate, cutoffs }),
    embedder: "local" as const,
    cache_file: shared,
    cache_only: true,
    input_roots: [root],
  });

  it("gives both arms the same read-only entries, and refuses one changed between them or before a recovery", async () => {
    await fill();
    const spec = cacheSpec("job-cache-entries");
    const result = await evaluateJob(spec, options);
    expect(result.status, JSON.stringify(result.error)).toBe("ok");
    expect(result.views.every((view) => view.cache_entries > 0)).toBe(true);
    expect(result.views.every((view) => view.cache_entries_hash?.startsWith("sha256:"))).toBe(true);
    expect(resultMismatch(spec, result)).toBeNull();
    // An entry no cutoff reads does not change the identity.
    set("INSERT INTO embeddings VALUES ('another-key', 'sha256:unrelated', ?)", vectorOf("x"));
    expect(await evaluateJob(spec, options)).toEqual(result);
    // An entry the arms read, changed afterwards: the stored result is not handed back.
    const used = new NodeSqlite.DatabaseSync(
      NodePath.join(options.jobsRoot, spec.token, "cache", `${cutoffs[0]!.slice(0, 10)}.sqlite`),
      { readOnly: true },
    );
    const row = used.prepare("SELECT embedding_key, text_hash FROM embeddings LIMIT 1").get() as {
      embedding_key: string;
      text_hash: string;
    };
    used.close();
    set(
      "UPDATE embeddings SET vector = ? WHERE embedding_key = ? AND text_hash = ?",
      vectorOf("changed", "salt"),
      row.embedding_key,
      row.text_hash,
    );
    const recovered = await evaluateJob(spec, options);
    expect(recovered.error?.code).toBe("artifact-mismatch");
    expect(recovered.error?.message).toContain("cache entry");

    // The same change made while the job runs, between the arms.
    await fill();
    const between = await evaluateJob(cacheSpec("job-cache-between"), {
      ...options,
      log: (line) => {
        if (JSON.parse(line).side === "candidate")
          set(
            "UPDATE embeddings SET vector = ? WHERE embedding_key = ? AND text_hash = ?",
            vectorOf("changed", "salt"),
            row.embedding_key,
            row.text_hash,
          );
      },
    });
    expect(between.error?.code).toBe("artifact-mismatch");
    expect(between.error?.message).toContain("cache entry");
  });
});
