import type { Item } from "@earlyscript/editorial-contracts/item";
import type { CoverageRecord, SourceDescriptor } from "@earlyscript/editorial-contracts/source";

export interface DayResult {
  readonly items: ReadonlyArray<Item>;
  /** Null when the day was never collected: the engine reads it as a gap, never as zero. */
  readonly coverage: CoverageRecord | null;
}

/**
 * One source, one UTC day at a time. The fixture adapter reads a frozen corpus; live
 * HN and GitHub adapters implement the same interface and write the same corpus/1 files.
 */
export interface SourceAdapter {
  readonly descriptor: SourceDescriptor;
  collectDay(day: string): Promise<DayResult>;
}
