import { SOURCE_ITEM_KEYS, type Item } from "@earlyscript/editorial-contracts/item";
import type { SourceId } from "@earlyscript/editorial-contracts/source";
import { expect } from "vite-plus/test";

/**
 * Every item an adapter returned carries exactly the keys SOURCE_ITEM_KEYS declares for its
 * source: what the first-run consent step tells the operator each source stores.
 */
export function expectStoredKeys(source: SourceId, items: ReadonlyArray<Item>): void {
  expect(items.length).toBeGreaterThan(0);
  const expected = [...SOURCE_ITEM_KEYS[source]].toSorted();
  for (const item of items) {
    expect(item.source).toBe(source);
    expect(Object.keys(item).toSorted()).toEqual(expected);
  }
}
