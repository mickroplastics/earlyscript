// @effect-diagnostics nodeBuiltinImport:off - hashes immutable input prefixes in a backtest.
import * as NodeCrypto from "node:crypto";

import { createStacker, type StackInput, type StackResult } from "./cluster.ts";

function prefixHash(items: ReadonlyArray<StackInput>, count: number): string {
  const hash = NodeCrypto.createHash("sha256");
  for (let k = 0; k < count; k++) {
    const item = items[k]!;
    hash.update(JSON.stringify([item.id, item.publishedMs, item.vector.length]));
    hash.update(new Uint8Array(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength));
  }
  return hash.digest("hex");
}

/** Results share the replay's signals: consume each result before the next call. */
export function createStackReplay(): (
  items: ReadonlyArray<StackInput>,
  threshold: number,
  activeDays: number,
) => StackResult {
  let previous:
    | {
        count: number;
        hash: string;
        threshold: number;
        activeDays: number;
        stacker: ReturnType<typeof createStacker>;
      }
    | undefined;
  return (items, threshold, activeDays) => {
    if (items.length === 0) {
      previous = undefined;
      return { signals: [], comparisons: 0 };
    }
    const retained =
      previous &&
      previous.count <= items.length &&
      previous.threshold === threshold &&
      previous.activeDays === activeDays &&
      previous.hash === prefixHash(items, previous.count)
        ? previous
        : undefined;
    const state = retained ?? {
      count: 0,
      hash: "",
      threshold,
      activeDays,
      stacker: createStacker(items[0]!.vector.length, threshold, activeDays),
    };
    try {
      const result = state.stacker.append(items.slice(state.count));
      state.count = items.length;
      state.hash = prefixHash(items, items.length);
      previous = state;
      return result;
    } catch (error) {
      previous = undefined;
      throw error;
    }
  };
}
