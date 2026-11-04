// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EDITORIAL_FIGURES_MAX_TOTAL_BASE64,
  EditorialFiguresSaveInput,
  type EditorialFigureFile,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeTempDir, removeDir } from "./persistence/EditorialDatabase.testkit.ts";
import { writeFigures } from "./figuresWrite.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const png = (name: string): EditorialFigureFile => ({ name, base64: PNG.toString("base64") });
const md = (text: string): EditorialFigureFile => ({
  name: "figuras.md",
  base64: Buffer.from(text).toString("base64"),
});

/** A home with a figures folder inside, removed afterwards. */
const withHome = <A, E>(body: (home: string, folder: string) => Effect.Effect<A, E, never>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const home = makeTempDir();
      const folder = NodePath.join(home, "informe", "figuras");
      NodeFS.mkdirSync(folder, { recursive: true });
      return { home, folder };
    }),
    ({ home, folder }) => body(home, folder),
    ({ home }) => removeDir(home),
  );

const write = (input: EditorialFiguresSaveInput, within: string) =>
  writeFigures(input, { within }).pipe(Effect.provide(NodeServices.layer));

describe("writeFigures", () => {
  it.effect("writes the images and the index into the chosen folder, replacing same names", () =>
    withHome((home, folder) =>
      Effect.gen(function* () {
        const first = yield* write(
          {
            directory: folder,
            files: [png("figura-etapas-2026-11-04.png"), md("# Figuras\n")],
          },
          home,
        );
        assert.strictEqual(first.directory, folder);
        assert.deepStrictEqual(first.files, [
          { name: "figura-etapas-2026-11-04.png", bytes: PNG.length },
          { name: "figuras.md", bytes: 10 },
        ]);
        assert.deepStrictEqual(
          NodeFS.readFileSync(NodePath.join(folder, "figura-etapas-2026-11-04.png")),
          PNG,
        );
        // The same day again replaces the files and leaves no temporary file behind.
        yield* write({ directory: folder, files: [md("# Otra\n")] }, home);
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(folder, "figuras.md"), "utf8"),
          "# Otra\n",
        );
        assert.deepStrictEqual(NodeFS.readdirSync(folder).toSorted(), [
          "figura-etapas-2026-11-04.png",
          "figuras.md",
        ]);
      }),
    ),
  );

  it.effect("refuses folders outside the root, links, missing folders and relative paths", () =>
    withHome((home, folder) =>
      Effect.gen(function* () {
        const outside = makeTempDir();
        const link = NodePath.join(home, "enlace");
        NodeFS.symlinkSync(outside, link);
        const refused = (directory: string) =>
          Effect.flip(write({ directory, files: [png("figura-a-2026-11-04.png")] }, folder)).pipe(
            Effect.map((error) => error.reason),
          );
        assert.strictEqual(yield* refused(home), "target");
        assert.strictEqual(yield* refused(link), "target");
        assert.strictEqual(yield* refused(NodePath.join(folder, "falta")), "target");
        assert.strictEqual(yield* refused("informe/figuras"), "target");
        assert.deepStrictEqual(NodeFS.readdirSync(outside), []);
        NodeFS.rmSync(outside, { recursive: true, force: true });
      }),
    ),
  );

  it.effect("never writes through a link or over a folder with a figure's name", () =>
    withHome((home, folder) =>
      Effect.gen(function* () {
        const target = NodePath.join(home, "secreto.txt");
        NodeFS.writeFileSync(target, "no tocar");
        NodeFS.symlinkSync(target, NodePath.join(folder, "figuras.md"));
        NodeFS.mkdirSync(NodePath.join(folder, "figura-b-2026-11-04.png"));
        const error = yield* Effect.flip(
          write({ directory: folder, files: [png("figura-a-2026-11-04.png"), md("x")] }, home),
        );
        assert.strictEqual(error.reason, "target");
        // Checked before the first write: nothing was written.
        assert.isFalse(NodeFS.existsSync(NodePath.join(folder, "figura-a-2026-11-04.png")));
        assert.strictEqual(NodeFS.readFileSync(target, "utf8"), "no tocar");
        const folderError = yield* Effect.flip(
          write({ directory: folder, files: [png("figura-b-2026-11-04.png")] }, home),
        );
        assert.strictEqual(folderError.reason, "target");
      }),
    ),
  );

  it.effect("never writes into T3 Code's home, directly or through a link", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const figures = NodePath.join(home, ".t3", "figuras");
        NodeFS.mkdirSync(figures, { recursive: true });
        NodeFS.symlinkSync(NodePath.join(home, ".t3"), NodePath.join(home, "informes"));
        for (const directory of [figures, NodePath.join(home, "informes", "figuras")]) {
          // Under the user's home, so `within` alone would let it through.
          const refused = yield* Effect.flip(
            write({ directory, files: [png("figura-a-2026-11-04.png")] }, home).pipe(
              Effect.provideService(HostProcess.HomeDirectory, home),
              Effect.provideService(HostProcess.Platform, "linux"),
            ),
          );
          assert.strictEqual(refused.reason, "target");
          assert.include(refused.message, "T3 Code");
        }
        assert.deepStrictEqual(NodeFS.readdirSync(figures), []);
      }),
    ),
  );

  it.effect("refuses repeated names and a call over the total size", () =>
    withHome((home, folder) =>
      Effect.gen(function* () {
        const repeated = yield* Effect.flip(
          write({ directory: folder, files: [md("a"), md("b")] }, home),
        );
        assert.strictEqual(repeated.reason, "target");
        const chunk = "A".repeat(4_000_000);
        const files = Array.from({ length: 9 }, (_, index) => ({
          name: `figura-f${index}-2026-11-04.png`,
          base64: chunk,
        }));
        assert.isAbove(files.length * chunk.length, EDITORIAL_FIGURES_MAX_TOTAL_BASE64);
        const large = yield* Effect.flip(write({ directory: folder, files }, home));
        assert.strictEqual(large.reason, "too-large");
        assert.deepStrictEqual(NodeFS.readdirSync(folder), []);
      }),
    ),
  );

  it("accepts only fixed figure names in the contract", () => {
    const decode = Schema.decodeUnknownExit(EditorialFiguresSaveInput);
    const input = (name: string) => ({ directory: "/home/x", files: [{ name, base64: "AA==" }] });
    assert.isTrue(decode(input("figura-etapas-2026-11-04.png"))._tag === "Success");
    assert.isTrue(decode(input("figura-etapas-2026-11-04.svg"))._tag === "Success");
    assert.isTrue(decode(input("figuras.md"))._tag === "Success");
    for (const name of [
      "../figura-a.png",
      "figura-a/b.png",
      "figura-A.png",
      "figura-a.exe",
      ".figuras.md",
      "figura-.png",
    ]) {
      assert.isTrue(decode(input(name))._tag === "Failure", name);
    }
    assert.isTrue(
      decode({ directory: "/home/x", files: [{ name: "figuras.md", base64: "no base64!" }] })
        ._tag === "Failure",
    );
  });
});
