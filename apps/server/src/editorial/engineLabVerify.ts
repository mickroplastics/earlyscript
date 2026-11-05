// Checks the lab's ledger from the database alone: manifests hash to their ids, activations
// chain to the active row, attempts stay within each campaign's budget, and every accepted
// report verifies against its job's signed worker result. The operator's `verify` action.
import { reportHash } from "@earlyscript/engine-lab/compare";
import { canonicalJson, sha256 } from "@earlyscript/engine-lab/hash";
import { type JobSpec, resultMismatch, type WorkerResult } from "@earlyscript/engine-lab/result";
import * as Effect from "effect/Effect";

import { manifestIdOf, parseJson } from "./engineLabSupport.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";

export interface LedgerCheck {
  readonly ok: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly problems: ReadonlyArray<string>;
}

export const verifyLabLedger = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const problems: Array<string> = [];
  const manifests = yield* sql<{
    manifest_hash: string;
    manifest_id: string;
    parent_hash: string | null;
    manifest_json: string;
  }>`
    SELECT manifest_hash, manifest_id, parent_hash, manifest_json FROM editorial_engine_manifests
  `;
  const known = new Set(manifests.map((row) => row.manifest_hash));
  for (const row of manifests) {
    if (sha256(canonicalJson(parseJson(row.manifest_json))) !== row.manifest_hash)
      problems.push(`manifest ${row.manifest_id} does not hash to its id`);
    if (manifestIdOf(row.manifest_hash) !== row.manifest_id)
      problems.push(`manifest ${row.manifest_id} has another id`);
    if (row.parent_hash !== null && !known.has(row.parent_hash))
      problems.push(`manifest ${row.manifest_id} has no parent row`);
  }
  const activations = yield* sql<{
    seq: number;
    activation_id: string;
    manifest_hash: string;
    previous_hash: string | null;
  }>`
    SELECT seq, activation_id, manifest_hash, previous_hash FROM editorial_engine_activations ORDER BY seq
  `;
  activations.forEach((row, k) => {
    if (row.seq !== k + 1) problems.push(`activation ${row.activation_id} is out of sequence`);
    const previous = activations[k - 1]?.manifest_hash ?? null;
    if (row.previous_hash !== previous)
      problems.push(`activation ${row.activation_id} does not follow the previous one`);
    if (!known.has(row.manifest_hash))
      problems.push(`activation ${row.activation_id} names no manifest`);
  });
  const active = yield* sql<{
    manifest_hash: string;
    activation_id: string;
  }>`SELECT manifest_hash, activation_id FROM editorial_engine_active`;
  const last = activations.at(-1);
  if (active.length > 1) problems.push("more than one active row");
  if (
    last !== undefined &&
    (active[0]?.activation_id !== last.activation_id ||
      active[0]?.manifest_hash !== last.manifest_hash)
  ) {
    problems.push("the active row is not the latest activation");
  }
  const seats = yield* sql<{ campaign_id: string; budget: number; used: number }>`
    SELECT c.campaign_id, c.budget, COUNT(a.attempt_id) AS used FROM editorial_engine_campaigns c
    LEFT JOIN editorial_engine_attempts a ON a.campaign_id = c.campaign_id
    WHERE c.kind = 'development' GROUP BY c.campaign_id
  `;
  for (const row of seats)
    if (row.used > row.budget)
      problems.push(`campaign ${row.campaign_id} used ${row.used} of ${row.budget}`);
  const orphans = yield* sql<{ job_id: string }>`
    SELECT j.job_id FROM editorial_engine_jobs j LEFT JOIN editorial_engine_attempts a ON a.job_id = j.job_id
    WHERE j.kind = 'development' AND a.attempt_id IS NULL
  `;
  for (const row of orphans) problems.push(`job ${row.job_id} has no attempt`);
  const reports = yield* sql<{
    report_id: string;
    report_json: string;
    report_hash: string;
    result_json: string;
    spec_json: string;
    secret: string;
  }>`
    SELECT r.report_id, r.report_json, r.report_hash, r.result_json, j.spec_json, j.secret
    FROM editorial_engine_reports r JOIN editorial_engine_jobs j ON j.job_id = r.job_id
  `;
  for (const row of reports) {
    const report = parseJson(row.report_json) as { result_signature?: string };
    const result = parseJson(row.result_json) as WorkerResult;
    if (reportHash(report) !== row.report_hash)
      problems.push(`report ${row.report_id} does not hash to its hash`);
    const mismatch = resultMismatch(
      { ...(parseJson(row.spec_json) as JobSpec), secret: row.secret },
      result,
    );
    if (mismatch !== null) problems.push(`report ${row.report_id}: ${mismatch}`);
    if (report.result_signature !== result.signature)
      problems.push(`report ${row.report_id} was not computed from its result`);
  }
  const jobs = yield* sql<{
    status: string;
    n: number;
  }>`SELECT status, COUNT(*) AS n FROM editorial_engine_jobs GROUP BY status`;
  return {
    ok: problems.length === 0,
    counts: {
      manifests: manifests.length,
      activations: activations.length,
      reports: reports.length,
      ...Object.fromEntries(jobs.map((row) => [`jobs_${row.status}`, row.n])),
    },
    problems,
  } satisfies LedgerCheck;
});
