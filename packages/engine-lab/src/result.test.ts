import { describe, expect, it } from "vite-plus/test";

import { canonicalJson, hmac } from "./hash.ts";
import { type JobSpec, specHash, storedResultStatus, type WorkerResult } from "./result.ts";

const spec = {
  token: "job-earlier",
  secret: "s",
  schema: "earlyscript.engine-lab-job/1",
} as unknown as JobSpec;

/** A result as an earlier evaluator stored it, signed with the job's secret. */
const earlierResult = (patch: Record<string, unknown> = {}) => {
  const unsigned = {
    schema: "earlyscript.engine-lab-result/2",
    token: spec.token,
    spec_sha256: specHash(spec),
    status: "ok",
    arms: { reference: [], candidate: [] },
    ...patch,
  };
  return {
    ...unsigned,
    signature: hmac(spec.secret, canonicalJson(unsigned)),
  } as unknown as WorkerResult;
};

describe("stored results of an earlier schema (Opus N1)", () => {
  it("tells an intact earlier result from an edited one", () => {
    expect(storedResultStatus(spec, earlierResult())).toEqual({
      kind: "earlier-schema",
      schema: "earlyscript.engine-lab-result/2",
    });
    const edited = { ...earlierResult(), status: "failed" } as WorkerResult;
    expect(storedResultStatus(spec, edited).kind).toBe("mismatch");
    const foreign = earlierResult({ token: "job-other" });
    expect(storedResultStatus(spec, foreign).kind).toBe("mismatch");
    const unknown = {
      ...earlierResult(),
      schema: "earlyscript.engine-lab-result/9",
    } as unknown as WorkerResult;
    expect(storedResultStatus(spec, unknown)).toEqual({
      kind: "mismatch",
      reason: "unknown result schema",
    });
  });
});
