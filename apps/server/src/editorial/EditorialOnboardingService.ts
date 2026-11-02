import {
  EDITORIAL_ONBOARDING_MAX_PAYLOAD_BYTES,
  EDITORIAL_ONBOARDING_STEPS,
  EditorialOnboardingError,
  type EditorialOnboardingAcceptance,
  type EditorialOnboardingList,
  EditorialOnboardingPayload,
  type EditorialOnboardingRecordInput,
  type EditorialOnboardingStatus,
  type EditorialOnboardingStep,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId, nowIso } from "./persistence/support.ts";

export interface EditorialOnboardingServiceShape {
  readonly record: (
    input: EditorialOnboardingRecordInput,
  ) => Effect.Effect<EditorialOnboardingAcceptance, EditorialOnboardingError>;
  readonly list: Effect.Effect<EditorialOnboardingList, EditorialOnboardingError>;
  readonly status: Effect.Effect<EditorialOnboardingStatus, EditorialOnboardingError>;
  /** Stores that the operator finished the wizard; a reopened wizard finishes again. */
  readonly complete: Effect.Effect<EditorialOnboardingStatus, EditorialOnboardingError>;
}

/** The first-run wizard's acceptances and completions over `editorial.sqlite`. */
export class EditorialOnboardingService extends Context.Service<
  EditorialOnboardingService,
  EditorialOnboardingServiceShape
>()("t3/editorial/EditorialOnboardingService") {}

interface AcceptanceRow {
  readonly id: string;
  readonly step: EditorialOnboardingStep;
  readonly accepted_at: string;
  readonly payload: string;
  readonly app_version: string;
}

const storageError = (cause: unknown) =>
  new EditorialOnboardingError({
    reason: "storage",
    message: `The onboarding decisions could not be read or written: ${String(cause)}`,
  });

const invalidPayload = (message: string) =>
  new EditorialOnboardingError({ reason: "invalid-payload", message });

const PayloadJson = Schema.fromJsonString(EditorialOnboardingPayload);
const encodePayload = Schema.encodeUnknownEffect(PayloadJson);
const decodePayload = Schema.decodeUnknownOption(PayloadJson);

/** A plain JSON object within the size limit, serialized once; anything else is refused. */
const serializePayload = Effect.fn("EditorialOnboardingService.serializePayload")(function* (
  payload: EditorialOnboardingPayload,
): Effect.fn.Return<string, EditorialOnboardingError> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return yield* invalidPayload("The acceptance must be a JSON object.");
  }
  const text = yield* encodePayload(payload).pipe(
    Effect.mapError(() => invalidPayload("The acceptance is not JSON-serializable.")),
  );
  if (new TextEncoder().encode(text).byteLength > EDITORIAL_ONBOARDING_MAX_PAYLOAD_BYTES) {
    return yield* invalidPayload(
      `The acceptance exceeds ${EDITORIAL_ONBOARDING_MAX_PAYLOAD_BYTES} bytes; store ids, booleans and hashes, not texts.`,
    );
  }
  return text;
});

// Rows are written by `serializePayload`; a hand-edited row reads as an empty acceptance.
const parsePayload = (text: string): EditorialOnboardingPayload =>
  Option.getOrElse(decodePayload(text), () => ({}));

const acceptanceOfRow = (row: AcceptanceRow): EditorialOnboardingAcceptance => ({
  id: row.id,
  step: row.step,
  acceptedAt: row.accepted_at,
  payload: parsePayload(row.payload),
  appVersion: row.app_version,
});

const makeWithVersion = Effect.fn("EditorialOnboardingService.make")(function* (
  appVersion: string,
) {
  const sql = yield* EditorialSql;
  const newId = yield* makeNewId;

  const list: EditorialOnboardingServiceShape["list"] = Effect.gen(function* () {
    const rows = yield* sql<AcceptanceRow>`
      SELECT id, step, accepted_at, payload, app_version
      FROM editorial_onboarding_acceptances
      ORDER BY accepted_at, rowid
    `;
    return { acceptances: rows.map(acceptanceOfRow) } satisfies EditorialOnboardingList;
  }).pipe(Effect.mapError(storageError), Effect.withSpan("EditorialOnboardingService.list"));

  const status: EditorialOnboardingServiceShape["status"] = Effect.gen(function* () {
    const latest = yield* sql<{ readonly step: string; readonly accepted_at: string }>`
      SELECT step, MAX(accepted_at) AS accepted_at
      FROM editorial_onboarding_acceptances GROUP BY step
    `;
    const completions = yield* sql<{ readonly completed_at: string }>`
      SELECT completed_at FROM editorial_onboarding_completions
      ORDER BY completed_at DESC, rowid DESC LIMIT 1
    `;
    const byStep = new Map(latest.map((row) => [row.step, row.accepted_at] as const));
    return {
      steps: EDITORIAL_ONBOARDING_STEPS.map((step) => ({
        step,
        lastAcceptedAt: byStep.get(step) ?? null,
      })),
      completedAt: completions[0]?.completed_at ?? null,
    } satisfies EditorialOnboardingStatus;
  }).pipe(Effect.mapError(storageError), Effect.withSpan("EditorialOnboardingService.status"));

  const record: EditorialOnboardingServiceShape["record"] = Effect.fn(
    "EditorialOnboardingService.record",
  )(function* (input) {
    const payload = yield* serializePayload(input.payload);
    const id = yield* newId;
    const acceptedAt = yield* nowIso;
    yield* sql`
      INSERT INTO editorial_onboarding_acceptances (id, step, accepted_at, payload, app_version)
      VALUES (${id}, ${input.step}, ${acceptedAt}, ${payload}, ${appVersion})
    `.pipe(Effect.mapError(storageError));
    return {
      id,
      step: input.step,
      acceptedAt,
      payload: parsePayload(payload),
      appVersion,
    } satisfies EditorialOnboardingAcceptance;
  });

  const complete: EditorialOnboardingServiceShape["complete"] = Effect.gen(function* () {
    const id = yield* newId;
    const completedAt = yield* nowIso;
    yield* sql`
      INSERT INTO editorial_onboarding_completions (id, completed_at, app_version)
      VALUES (${id}, ${completedAt}, ${appVersion})
    `.pipe(Effect.mapError(storageError));
    return yield* status;
  }).pipe(Effect.withSpan("EditorialOnboardingService.complete"));

  return EditorialOnboardingService.of({ record, list, status, complete });
});

export const layer = Layer.effect(EditorialOnboardingService, makeWithVersion(packageJson.version));

export const layerWithVersion = (appVersion: string) =>
  Layer.effect(EditorialOnboardingService, makeWithVersion(appVersion));
