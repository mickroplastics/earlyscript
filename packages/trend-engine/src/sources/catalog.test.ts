import { isCatalogSourceId, SOURCE_CATALOG } from "@earlyscript/editorial-contracts/sourceCatalog";
import { describe, expect, it } from "vite-plus/test";

import { SOURCES } from "./index.ts";

describe("adapters against the governance catalog", () => {
  it("declare the coverage policy the catalog shows", () => {
    for (const descriptor of Object.values(SOURCES)) {
      // A retired source keeps its adapter until another branch removes it.
      if (!isCatalogSourceId(descriptor.id)) continue;
      expect(descriptor.coverage_policy, descriptor.id).toBe(
        SOURCE_CATALOG[descriptor.id].coverage,
      );
    }
  });
});
