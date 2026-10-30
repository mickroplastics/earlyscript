// @effect-diagnostics nodeBuiltinImport:off - fixtures are local files.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { checkScript, parseScript } from "./script.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`../fixtures/${name}.md`, import.meta.url), "utf8");
const dossier = { evidence: [{ item_id: "itm_hn_50061234" }, { item_id: "itm_github_987" }] };

describe("script checking", () => {
  it("maps explicit and paragraph-final citations without counting Sources", () => {
    const report = checkScript(fixture("valid"), { dossier });
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ claims: 4, cited: 4, uncited: 0 });
    expect(report.claimsMap[1]).toMatchObject({
      line: 7,
      column: 1,
      citations: ["itm_github_987"],
    });
    expect(report.claimsMap[2]).toMatchObject({ line: 7, column: 48 });
  });

  it("reports uncited claims at their original positions", () => {
    const report = checkScript(fixture("uncited"));
    expect(report.ok).toBe(false);
    expect(report.counts).toEqual({ claims: 3, cited: 0, uncited: 3 });
    expect(report.uncitedClaims.map(({ line, column }) => [line, column])).toEqual([
      [3, 1],
      [7, 1],
      [11, 1],
    ]);
  });

  it("rejects missing, repeated, empty and out-of-order headings", () => {
    const report = checkScript(fixture("out-of-order"));
    expect(report.structure.map(({ code }) => code)).toContain("heading-order");
    expect(report.structure.map(({ code }) => code)).toContain("block-number");
    expect(
      checkScript("# Hook\n# Hook\n# Block 1\n# Close").structure.map(({ code }) => code),
    ).toContain("empty-section");
    expect(checkScript("").structure.filter(({ code }) => code === "missing-heading")).toHaveLength(
      3,
    );
    expect(
      checkScript("# Introduction").structure.some(({ code }) => code === "unknown-heading"),
    ).toBe(true);
  });

  it("checks canonical citations against the dossier, including Sources", () => {
    const report = checkScript(fixture("unknown"), { dossier });
    expect(report.counts.cited).toBe(3);
    expect(report.unknownCitations).toEqual([
      { id: "itm_hn_999", raw: "[itm_hn_999]", line: 3, column: 37 },
    ]);
    expect(
      checkScript(fixture("valid"), { dossier: { evidence: [] } }).unknownCitations,
    ).toHaveLength(6);
    expect(() => checkScript(fixture("valid"), { dossier: { evidence: [{}] } })).toThrow(
      "Invalid dossier",
    );
  });

  it("normalizes short and multiple references", () => {
    const report = checkScript(fixture("short-form"), { dossier });
    expect(report.ok).toBe(true);
    expect(report.claimsMap[1]?.citations).toEqual(["itm_github_987", "itm_hn_50061234"]);
  });

  it("parses simple metadata without counting it and preserves CRLF positions", () => {
    const script = fixture("frontmatter").replaceAll("\n", "\r\n");
    expect(parseScript(script).metadata).toEqual({
      trend: "dos_469a6dff5126",
      thread: "thread-example",
      mode: "assisted",
      version: "1",
    });
    expect(checkScript(script).claimsMap[0]?.line).toBe(10);
    expect(checkScript("---\nmode: manual").structure[0]?.message).toBe("Unclosed frontmatter.");
    expect(
      checkScript("---\nmode: a\nmode: b\nother: c\n---").structure.filter(
        ({ code }) => code === "frontmatter",
      ),
    ).toHaveLength(2);
  });

  it("handles post-punctuation citations, questions, short sentences, decimals and paragraph boundaries", () => {
    const report = checkScript(
      "# Hook\nWhy would developers care? Very short. Four words make one. [hn:1]\n\nFour words remain uncited.\n# Block 1\nRelease 1.5 includes local inference [hn:2].\n# Close\nThese four words end here [hn:3]",
    );
    expect(report.counts).toEqual({ claims: 4, cited: 3, uncited: 1 });
    expect(report.claimsMap[0]?.citations).toEqual(["itm_hn_1"]);
    expect(report.uncitedClaims[0]?.line).toBe(4);
    const own = checkScript(
      "# Hook\nThese words have their source [hn:1]. These words have another source [hn:2].\n# Block 1\nx\n# Close\nx",
    );
    expect(own.claimsMap[0]?.citations).toEqual(["itm_hn_1"]);
  });

  it("checks the actual README example and CLI exit codes", () => {
    const readme = NodeFS.readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const example = /```markdown\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(example).toBe(fixture("valid"));
    expect(checkScript(example ?? "").ok).toBe(true);
    const cli = new URL("./cli.ts", import.meta.url);
    const valid = new URL("../fixtures/valid.md", import.meta.url);
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [cli.pathname, valid.pathname, "--json"],
      {
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output).counts).toEqual({ claims: 4, cited: 4, uncited: 0 });
    expect(
      NodeChildProcess.spawnSync(process.execPath, [
        cli.pathname,
        new URL("../fixtures/uncited.md", import.meta.url).pathname,
      ]).status,
    ).toBe(1);
    expect(
      NodeChildProcess.spawnSync(process.execPath, [cli.pathname, valid.pathname, "--bogus"])
        .status,
    ).toBe(2);
  });
});
