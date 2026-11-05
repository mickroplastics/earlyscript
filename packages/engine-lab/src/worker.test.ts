// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the worker runs the real engine over a synthetic corpus.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { developmentReport } from "./compare.ts";
import { canonicalInputs } from "./inputs.ts";
import { subsetCorpus } from "./corpusSubset.ts";
import { readLabelSource } from "./labels.ts";
import { resultMismatch } from "./result.ts";
import { jobSpec, labFixture, patchCandidate, weightCandidate } from "./testkit.ts";
import { bwrapAvailable, evaluateJob } from "./worker.ts";

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
      { ...spec, corpus_dir: copy.out, input_roots: [root] },
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

  it("runs a code candidate in bwrap: no network, no files outside its inputs, read-only corpus", async () => {
    expect(bwrapAvailable()).toBe(true);
    const secret = NodePath.join(root, "labels-miguel.json");
    NodeFS.writeFileSync(secret, "{}");
    const probe = [
      'import * as NodeFS from "node:fs";',
      "const probe: Record<string, string> = {};",
      `try { NodeFS.readFileSync(${JSON.stringify(secret)}); probe.labels = "read"; } catch (e) { probe.labels = String((e as { code?: string }).code); }`,
      `try { NodeFS.writeFileSync(${JSON.stringify(NodePath.join(fixture.corpus_dir, "x"))}, "x"); probe.corpus = "written"; } catch (e) { probe.corpus = String((e as { code?: string }).code); }`,
      'try { await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) }); probe.network = "reached"; } catch (e) { probe.network = "unreachable"; }',
      'NodeFS.writeFileSync("probe.json", JSON.stringify(probe));',
      "",
    ].join("\n");
    const patched = patchCandidate(fixture, RANK_PATCH(probe));
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
    expect(seen).toEqual({ labels: "ENOENT", corpus: "EROFS", network: "unreachable" });
    // The probe changes no output: the candidate is logically equal to the reference.
    expect(
      developmentReport({ result, campaignId: "c", cutoffs: spec.cutoffs, human, judge: null })
        .equivalent,
    ).toBe(true);
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
    const patched = patchCandidate(fixture, RANK_PATCH(text));
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
    const patched = patchCandidate(fixture, RANK_PATCH(exitLinks));
    const spec = jobSpec(fixture, {
      token: "job-b1r2-links",
      candidate: patched.manifest,
      files: patched.files,
      cutoffs: fixture.cutoffs.slice(0, 1),
    });
    const result = await evaluateJob(spec, options);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("artifact-mismatch");
    expect(result.error?.message).toContain("is a link");
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
    const patched = patchCandidate(fixture, RANK_PATCH(rewrite));
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
