import { describe, expect, it } from "vite-plus/test";

import { checkScope, importSpecifiers, type ScopeConfig, type ScopePackage } from "./scope.ts";

const packages: ReadonlyArray<ScopePackage> = [
  { name: "t3", dir: "apps/server", deps: ["@t3tools/editorial-core"] },
  { name: "@t3tools/web", dir: "apps/web", deps: [] },
  { name: "@t3tools/mobile", dir: "apps/mobile", deps: [] },
  { name: "@t3tools/editorial-core", dir: "packages/editorial-core", deps: [] },
];

const config: ScopeConfig = {
  include: { "apps/server": "", "apps/web": "", "packages/editorial-core": "" },
  exclude: { "apps/mobile": "" },
  owned: ["packages/editorial-*", "apps/web/src/editorial"],
  testAlone: ["apps/web"],
};

describe("checkScope", () => {
  it("accepts a fully classified workspace", () => {
    const sources = [
      { path: "apps/web/src/App.tsx", text: 'import { Board } from "./editorial/Board";' },
      { path: "apps/mobile/src/App.tsx", text: 'import { Shell } from "@t3tools/web";' },
    ];
    expect(checkScope(config, packages, sources)).toEqual([]);
  });

  it("reports unclassified, stale and doubly listed packages", () => {
    const problems = checkScope(
      {
        ...config,
        include: { ...config.include, "packages/gone": "" },
        exclude: { "apps/web": "" },
        testAlone: ["apps/mobile"],
      },
      packages,
      [],
    );
    expect(problems).toEqual([
      "packages/gone is listed but is not a workspace package.",
      "apps/web is in both include and exclude.",
      "apps/mobile is not classified in include or exclude.",
      "apps/mobile is in testAlone but not in include.",
    ]);
  });

  it("requires every importer of Earlyscript code to be included", () => {
    const problems = checkScope(
      config,
      [...packages, { name: "@t3tools/relay", dir: "infra/relay", deps: [] }].map((pkg) =>
        pkg.dir === "apps/mobile" ? { ...pkg, deps: ["@t3tools/editorial-core"] } : pkg,
      ),
      [
        {
          path: "infra/relay/src/index.ts",
          text: [
            'const view = await import("../../../apps/web/src/editorial/view.ts");',
            'export { score } from "@t3tools/editorial-core/score";',
          ].join("\n"),
        },
      ],
    );
    expect(problems).toEqual([
      "infra/relay is not classified in include or exclude.",
      "apps/mobile depends on packages/editorial-core but is not in include.",
      "infra/relay imports apps/web/src/editorial (infra/relay/src/index.ts) but is not in include.",
      "infra/relay imports packages/editorial-core (infra/relay/src/index.ts) but is not in include.",
    ]);
  });

  it("requires Earlyscript's own packages to be included", () => {
    const problems = checkScope(
      {
        ...config,
        include: { "apps/server": "", "apps/web": "" },
        exclude: { ...config.exclude, "packages/editorial-core": "" },
      },
      packages,
      [],
    );
    expect(problems).toEqual([
      "packages/editorial-core is Earlyscript's own package but is not in include.",
    ]);
  });

  it("reads imports from the syntax tree, not from comments", () => {
    const relay = { name: "@t3tools/relay", dir: "infra/relay", deps: [] };
    const report = (text: string) =>
      checkScope(
        { ...config, exclude: { ...config.exclude, "infra/relay": "" } },
        [...packages, relay],
        [{ path: "infra/relay/src/index.ts", text }],
      );
    const editorial =
      "infra/relay imports apps/web/src/editorial (infra/relay/src/index.ts) but is not in include.";
    const core =
      "infra/relay imports packages/editorial-core (infra/relay/src/index.ts) but is not in include.";

    expect(report('import { view } from "../../../apps/web/src/editorial/view.ts";')).toEqual([
      editorial,
    ]);
    expect(report('await import("../../../apps/web/src/editorial/view.ts");')).toEqual([editorial]);
    expect(report("await import(`../../../apps/web/src/editorial/${name}.ts`);")).toEqual([
      editorial,
    ]);
    expect(report('export * from "@t3tools/editorial-core";')).toEqual([core]);
    expect(
      report(
        [
          '// import { view } from "../../../apps/web/src/editorial/view.ts";',
          '/* await import("@t3tools/editorial-core"); */',
          "const note = \"import x from '@t3tools/editorial-core'\";",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("importSpecifiers", () => {
  it("covers every module reference form", () => {
    const text = [
      'import a from "a";',
      'import type { B } from "b";',
      'export { c } from "c";',
      'const d = await import("d");',
      "const e = await import(`e/${name}`);",
      'const f = require("f");',
      'import g = require("g");',
      'type H = typeof import("h");',
      "// import i from 'i';",
    ].join("\n");
    expect(importSpecifiers("x.ts", text)).toEqual(["a", "b", "c", "d", "e/", "f", "g", "h"]);
  });
});
