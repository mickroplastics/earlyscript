import * as Schema from "effect/Schema";

export class EditorialPersistenceError extends Schema.TaggedError<EditorialPersistenceError>()(
  "EditorialPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Editorial storage failed in ${this.operation}`;
  }
}

/**
 * The editorial Migrator skips every id at or below the latest applied one, so a hole in the
 * manifest, or a registered migration below that id that never ran, would never be applied.
 * The editorial layer refuses to start instead.
 */
export class EditorialMigrationGapError extends Schema.TaggedError<EditorialMigrationGapError>()(
  "EditorialMigrationGapError",
  {
    reason: Schema.Literals([
      "manifest-gap",
      "unapplied-below-latest",
      "not-replayable",
      /** An applied marker's name is not the one the manifest gives its id. */
      "name-mismatch",
    ]),
    ids: Schema.Array(Schema.Number),
    detail: Schema.String,
  },
) {
  override get message(): string {
    if (this.reason === "name-mismatch") return `Migraciones editoriales: ${this.detail}`;
    return `Editorial migrations are not continuous (${this.reason}: ${this.ids.join(", ")}). ${this.detail}`;
  }
}

export class EditorialNotFoundError extends Schema.TaggedError<EditorialNotFoundError>()(
  "EditorialNotFoundError",
  {
    entity: Schema.Literals(["video_thread", "script_version", "work_interval", "capture"]),
    id: Schema.String,
  },
) {
  override get message(): string {
    return `No editorial ${this.entity} ${this.id}`;
  }
}

export class EditorialInvalidInputError extends Schema.TaggedError<EditorialInvalidInputError>()(
  "EditorialInvalidInputError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid input for ${this.operation}: ${this.detail}`;
  }
}

export class EditorialConflictError extends Schema.TaggedError<EditorialConflictError>()(
  "EditorialConflictError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Conflict in ${this.operation}: ${this.detail}`;
  }
}

export const WorkClockStateReason = Schema.Literals([
  "already-running",
  "paused",
  "not-running",
  "not-paused",
  "not-started",
  "same-stage",
  "not-unresolved",
  /** The thread was decided; its clock is final. */
  "decided",
  /** A segment left open by a restart awaits the operator's resolution. */
  "unresolved",
]);
export type WorkClockStateReason = typeof WorkClockStateReason.Type;

/** The clock is not in a state that allows the command. */
export class WorkClockStateError extends Schema.TaggedError<WorkClockStateError>()(
  "WorkClockStateError",
  {
    threadId: Schema.String,
    reason: WorkClockStateReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Work clock for ${this.threadId}: ${this.detail}`;
  }
}

export const toPersistenceError = (operation: string) => (cause: unknown) =>
  new EditorialPersistenceError({ operation, cause });
