// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the worker runs the real engine over a synthetic corpus.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { developmentReport } from "./compare.ts";
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
    const result = await evaluateJob({ ...spec, corpus_dir: copy.out }, options);
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
