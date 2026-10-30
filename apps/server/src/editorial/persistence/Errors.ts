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

export class EditorialNotFoundError extends Schema.TaggedError<EditorialNotFoundError>()(
  "EditorialNotFoundError",
  {
    entity: Schema.Literals(["video_thread", "script_version", "work_interval"]),
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
