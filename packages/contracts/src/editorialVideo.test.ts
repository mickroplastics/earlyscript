import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EditorialVideoOpenVersionInput } from "./editorialVideo.ts";

const decode = Schema.decodeUnknownExit(EditorialVideoOpenVersionInput);
const HASH = "6b12140301194e985730a45aaa8f21e3be8a554219c0c5a0946cd083dd3829b6";

describe("EditorialVideoOpenVersionInput", () => {
  it("accepts a SHA-256 content hash in lowercase hex", () => {
    expect(Exit.isSuccess(decode({ threadId: "thread-video", contentHash: HASH }))).toBe(true);
  });

  it("refuses anything else before the server looks the version up", () => {
    for (const contentHash of [
      "..",
      "../../escape",
      "?!/foo",
      "",
      HASH.slice(0, 63),
      `${HASH}0`,
      HASH.toUpperCase(),
      `sha256:${HASH}`,
    ]) {
      expect(Exit.isFailure(decode({ threadId: "thread-video", contentHash })), contentHash).toBe(
        true,
      );
    }
  });
});
