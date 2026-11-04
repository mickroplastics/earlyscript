import { describe, expect, it } from "vite-plus/test";
import { JUST_CREATED, WRITING, DECIDED } from "./videoThread.fixture";
import { activeMapStop, mapPanel, mapScript } from "./threadMap.logic";
const SCRIPT =
  "# Hook\n\nA claim with enough words [itm_hn_a].\n\n# Block 1\n\nAnother claim here [itm_hn_b, itm_hn_a].\n\n# Sources\n\n[itm_hn_c]";
describe("video map", () => {
  it("follows content, requests, clock, and a final decision", () => {
    expect(activeMapStop(JUST_CREATED, "# Hook\n", false)).toBe(1);
    expect(activeMapStop(JUST_CREATED, "# Hook\n", true)).toBe(2);
    expect(activeMapStop(WRITING, "# Hook\n", false)).toBe(2);
    expect(activeMapStop(JUST_CREATED, SCRIPT, false)).toBe(3);
    expect(
      activeMapStop(
        {
          ...WRITING,
          clock: {
            ...WRITING.clock,
            state: { _tag: "paused", stage: "decide", since: WRITING.clock.asOf },
          },
        },
        SCRIPT,
        false,
      ),
    ).toBe(4);
    expect(activeMapStop(DECIDED, "", false)).toBe(4);
  });
  it("keeps completed stops independently readable", () => {
    expect(mapPanel(1, 4, true)).toBe("topic");
    expect(mapPanel(4, 4, true)).toBe("decision");
    expect(mapPanel(4, 3, false)).toBe("decision");
    expect(mapPanel(3, 4, true)).toBe("script");
    expect(mapPanel(2, 2, false)).toBe("empty");
  });
  it("numbers unique citations in body order and keeps missing sources explicit", () => {
    const mapped = mapScript(SCRIPT, []);
    expect(mapped.sources).toEqual([
      { id: "itm_hn_a", number: 1, evidence: null },
      { id: "itm_hn_b", number: 2, evidence: null },
    ]);
    expect(mapped.sections.map((s) => s.kind)).toEqual(["hook", "block"]);
  });
});
