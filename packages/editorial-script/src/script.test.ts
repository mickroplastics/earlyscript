// @effect-diagnostics nodeBuiltinImport:off - fixtures are local files.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { checkScript, parseScript, SCRIPT_TEMPLATE } from "./script.ts";

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

  it("does not count a call to action in Close as a claim", () => {
    const script = [
      "# Hook",
      "",
      "Cisco says it is rewriting most of its legacy code with AI. [itm_hn_50061234]",
      "",
      "# Block 1",
      "",
      "Join the people who read the source before they believe the headline.",
      "",
      "# Close",
      "",
      "If this was useful, join SingulariDev as a member to get the next analysis first.",
      "Subscribe for the follow-up on the rewrite.",
      "Join 3,000 members who already read the full benchmark.",
      "The rewrite still has no published quality assessment.",
      "",
      "# Sources",
      "",
      "- https://news.ycombinator.com/item?id=50061234",
      "",
    ].join("\n");
    const report = checkScript(script);
    expect(report.claimsMap.map((claim) => claim.text)).toEqual([
      "Cisco says it is rewriting most of its legacy code with AI. [itm_hn_50061234]",
      // Outside Close an imperative still counts.
      "Join the people who read the source before they believe the headline.",
      // A figure may be a claim.
      "Join 3,000 members who already read the full benchmark.",
      "The rewrite still has no published quality assessment.",
    ]);
    expect(report.counts).toEqual({ claims: 4, cited: 1, uncited: 3 });
  });

  it("counts an invitation that carries a claim or a figure (Sol, hallazgo 1)", () => {
    const counted = (sentence: string) =>
      checkScript(`# Hook\nA valid claim has words.\n# Block 1\nx\n# Close\n${sentence}`)
        .claimsMap.map((claim) => claim.text)
        .includes(sentence);
    // Not claims: a plain membership or subscription invitation.
    for (const sentence of [
      "Join SingulariDev as a member today.",
      "If this was useful, subscribe to the channel.",
      "Become a member of SingulariDev to get the next analysis first.",
      "Hazte miembro de SingulariDev.",
    ]) {
      expect(counted(sentence), sentence).toBe(false);
    }
    // Claims: a figure in digits or words, a subordinate clause, a comparison, or a verb that
    // invites to nothing about membership.
    for (const sentence of [
      "Join 10,000 members in our community.",
      "Join ten thousand members in our community.",
      "Join our community, which is the largest developer community in Ecuador.",
      "Consider that this model outperforms every competitor.",
      "Leave the benchmark running because this model never leaks private data.",
      "Join SingulariDev, the largest developer community in Ecuador.",
      "Subscribe to the channel with more benchmarks than anyone else.",
      "Únete a los miles de miembros de SingulariDev.",
      "Únete al canal con más miembros de Ecuador.",
    ]) {
      expect(counted(sentence), sentence).toBe(true);
    }
  });

  it("starts from a template whose only problems are its empty sections", () => {
    const report = checkScript(SCRIPT_TEMPLATE);
    expect(report.structure.map(({ code }) => code)).toEqual([
      "empty-section",
      "empty-section",
      "empty-section",
    ]);
    expect(parseScript(SCRIPT_TEMPLATE).sections.map(({ kind }) => kind)).toEqual([
      "hook",
      "block",
      "close",
      "sources",
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

  it("accepts Hugging Face and npm ids, which carry slashes, dots and at signs", () => {
    const hf = "itm_hf_model_nvidia/Nemotron-3.5-Embed-8B-BF16";
    const npm = "itm_npm_@motrix/cli@0.5.0";
    const text = fixture("valid")
      .replaceAll("itm_hn_50061234", hf)
      .replaceAll("itm_github_987", npm);
    const report = checkScript(text, {
      dossier: { evidence: [{ item_id: hf }, { item_id: npm }] },
    });
    expect(report.unknownCitations).toEqual([]);
    expect(report.claimsMap.flatMap((claim) => claim.citations)).toEqual(
      expect.arrayContaining([hf, npm]),
    );
    // A trailing dot is sentence punctuation, not part of an id.
    expect(() =>
      checkScript(text, { dossier: { evidence: [{ item_id: "itm_hf_model_a/b." }] } }),
    ).toThrow("Invalid dossier");
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

  it.each([
    "“These four words have evidence [hn:50078937].” These four words lack evidence.",
    '"These four words have evidence [hn:50078937]." These four words lack evidence.',
    "**These four words have evidence [hn:50078937].** These four words lack evidence.",
    "__These four words have evidence [hn:50078937].__ These four words lack evidence.",
    "*These four words have evidence [hn:50078937].* These four words lack evidence.",
    "~~These four words have evidence [hn:50078937].~~ These four words lack evidence.",
  ])("splits sentences after closing quotes and emphasis: %s", (hook) => {
    const report = checkScript(`# Hook\n${hook}\n# Block 1\nx\n# Close\nx`);
    expect(report.ok).toBe(false);
    expect(report.claimsMap.map(({ citations }) => citations)).toEqual([["itm_hn_50078937"], []]);
  });

  it("keeps the claim after a quoted question", () => {
    const script =
      "# Hook\n“Why would anyone need this?” These four words lack evidence.\n# Block 1\nx\n# Close\nx";
    const report = checkScript(script);
    expect(report.claimsMap.map(({ text, citations }) => [text, citations])).toEqual([
      ["These four words lack evidence.", []],
    ]);
    const cli = new URL("./cli.ts", import.meta.url).pathname;
    const dir = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/editorial-script-`);
    NodeFS.writeFileSync(`${dir}/quoted.md`, script);
    expect(NodeChildProcess.spawnSync(process.execPath, [cli, `${dir}/quoted.md`]).status).toBe(1);
    NodeFS.rmSync(dir, { recursive: true });
  });

  it.each([
    "The documentation is at https://example.com/?version=1 [hn:50078937].",
    "The flag `--mode=?` selects interactive mode [hn:50078937].",
    "Models from Acme Inc. support local inference [hn:50078937].",
    "Small models, e.g. local ones, run offline [hn:50078937].",
    "Teams in the U.S. compare local models [hn:50078937].",
  ])("keeps one declarative claim despite URLs, code and abbreviations: %s", (hook) => {
    const report = checkScript(`# Hook\n${hook}\n# Block 1\nx\n# Close\nx`);
    expect(report.ok).toBe(true);
    expect(report.claimsMap.map(({ text }) => text)).toEqual([hook]);
  });

  it("still excludes questions that end outside URLs", () => {
    const report = checkScript(
      "# Hook\nHave you read https://example.com/?version=1 yet?\n# Block 1\nx\n# Close\nx",
    );
    expect(report.claimsMap).toEqual([]);
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
