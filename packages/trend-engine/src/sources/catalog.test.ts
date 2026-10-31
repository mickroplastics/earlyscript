import { SOURCE_CATALOG } from "@earlyscript/editorial-contracts/sourceCatalog";
import { describe, expect, it } from "vite-plus/test";

import { SOURCES } from "./index.ts";

describe("adapters against the governance catalog", () => {
  it("declare the coverage policy the catalog shows", () => {
    for (const descriptor of Object.values(SOURCES)) {
      expect(descriptor.coverage_policy, descriptor.id).toBe(
        SOURCE_CATALOG[descriptor.id].coverage,
      );
    }
  });
});
