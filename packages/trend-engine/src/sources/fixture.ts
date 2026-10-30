// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - plain library, JSONL lines are decoded below.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { Item } from "@earlyscript/editorial-contracts/item";
import { CoverageRecord, type SourceDescriptor } from "@earlyscript/editorial-contracts/source";

import type { DayResult, SourceAdapter } from "./adapter.ts";

const decodeItem = Schema.decodeUnknownSync(Item);
const decodeCoverage = Schema.decodeUnknownSync(CoverageRecord);

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function readJsonLines(file: string): Promise<Array<unknown>> {
  const text = await NodeFSP.readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}

async function readCoverageIndex(corpusDir: string): Promise<Map<string, CoverageRecord>> {
  try {
    const lines = await readJsonLines(NodePath.join(corpusDir, "coverage.jsonl"));
    return new Map(
      lines.map((line) => decodeCoverage(line)).map((row) => [`${row.source}/${row.day}`, row]),
    );
  } catch (error) {
    if (isMissing(error)) return new Map();
    throw error;
  }
}

/** Simulated collection: replays `<source>/<day>.jsonl` and coverage.jsonl of a corpus/1 directory. */
export function fixtureAdapter(corpusDir: string, descriptor: SourceDescriptor): SourceAdapter {
  const root = NodePath.resolve(corpusDir);
  let index: Promise<Map<string, CoverageRecord>> | undefined;
  return {
    descriptor,
    async collectDay(day: string): Promise<DayResult> {
      const coverage =
        (await (index ??= readCoverageIndex(root))).get(`${descriptor.id}/${day}`) ?? null;
      let lines: Array<unknown>;
      try {
        lines = await readJsonLines(NodePath.join(root, descriptor.id, `${day}.jsonl`));
      } catch (error) {
        if (!isMissing(error)) throw error;
        lines = [];
      }
      const items = lines.map((line) => decodeItem(line));
      if (coverage && coverage.items !== items.length) {
        throw new Error(`Coverage count mismatch: ${descriptor.id}/${day}`);
      }
      if (!coverage && items.length > 0) {
        throw new Error(`Items without a coverage record: ${descriptor.id}/${day}`);
      }
      return { items, coverage };
    },
  };
}
