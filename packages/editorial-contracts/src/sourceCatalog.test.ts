import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SourceId } from "./source.ts";
import { SOURCE_CATALOG, SOURCE_IDS, SourceGovernance } from "./sourceCatalog.ts";

const decode = Schema.decodeUnknownSync(SourceGovernance);

describe("source catalog", () => {
  it("has a valid record for every source id, under its own id", () => {
    expect(Object.keys(SOURCE_CATALOG).toSorted()).toEqual([...SourceId.literals].toSorted());
    expect(SOURCE_IDS).toHaveLength(10);
    for (const id of SOURCE_IDS) {
      expect(decode(SOURCE_CATALOG[id]).id).toBe(id);
    }
  });

  it("marks a source ready only with its terms read and a license", () => {
    for (const entry of Object.values(SOURCE_CATALOG)) {
      if (entry.status !== "ready") continue;
      expect(entry.termsReviewedAt, entry.id).not.toBeNull();
      expect(entry.license.text.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("keeps the engine baseline to ready sources", () => {
    const baseline = Object.values(SOURCE_CATALOG).filter((entry) => entry.engineBaseline);
    expect(baseline.map((entry) => entry.id).toSorted()).toEqual(["github", "hn"]);
    expect(baseline.every((entry) => entry.status === "ready")).toBe(true);
  });
});
