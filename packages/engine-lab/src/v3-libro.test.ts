// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the v3 ledger on temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { v3Command, type V3Context } from "./v3-cli.ts";
import { appendLedger, readLedger } from "./v3-ledger.ts";
import {
  appendV3,
  assertCanLabel,
  functionSource,
  judgeCacheEntries,
  oraclePayload,
  p3Closing,
  p4LabelFiles,
  premanifestPayload,
  type PremanifestFiles,
  readV3Ledger,
  v3LedgerPath,
} from "./v3-libro.ts";

const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v3-libro-"));
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));
let n = 0;

const PROFILE_TEXT =
  "Perfil v2 creado el 9 nov ~00:50 UTC por decisión editorial de Miguel (ángulo home lab / autoalojado), después de que el coordinador y Miguel vieran las listas de la maqueta de octubre (sin-wikipedia, SHA d6139c349a); no se tocaron pesos ni umbrales";

function freshRoot() {
  const root = NodePath.join(base, `root-${++n}`);
  const p3 = NodePath.join(root, "p3", "libro", "ledger-p3.jsonl");
  appendLedger(p3, { kind: "p3_open" });
  appendLedger(p3, { kind: "stop", motivo: "paso 0" });
  const files = NodePath.join(root, "files");
  NodeFS.mkdirSync(files, { recursive: true });
  const write = (name: string, text: string) => {
    NodeFS.writeFileSync(NodePath.join(files, name), text);
    return NodePath.join(files, name);
  };
  const premanifest: PremanifestFiles = {
    contract: write(
      "diseno-v3-v4.md",
      "# Motor v3: contrato consolidado, versión 4.2\n\n## Decisión 1 de Miguel y corrección 4.2\n",
    ),
    rubric: write("judge.util.v1.json", '{"version":"judge.util.v1"}'),
    cardText: write(
      "card.ts",
      "export function cardTextV3(card: unknown): string {\n  if (card) { return 'x'; }\n  return '';\n}\nexport const other = 1;\n",
    ),
    profileV2: write("singularidev.v2.json", '{"include":["a","b"]}'),
    profileV1: write("singularidev.v1.json", '{"include":["a"]}'),
    keywords: write("keywords.v1.json", '{"terms":["agent"]}'),
    measurementA: write("mediciones-A.json", '{"takeoffs":58,"october_4_to_24":{"takeoffs":26}}'),
  };
  return { root, premanifest };
}

function openRoot() {
  const r = freshRoot();
  const p3 = p3Closing(r.root);
  appendV3(r.root, "v3_open", { p3_entries: p3.entries, p3_last_sha256: p3.sha256 });
  return r;
}

const premanifested = () => {
  const r = openRoot();
  appendV3(r.root, "exposicion", { texto: PROFILE_TEXT });
  appendV3(r.root, "v3_premanifest", premanifestPayload({ root: r.root, files: r.premanifest }));
  return r;
};

describe("v3 ledger chain", () => {
  it("chains every line to the one before and to P3's last entry", () => {
    const { root } = premanifested();
    const ledger = readV3Ledger(root);
    expect(ledger.map((e) => e.kind)).toEqual(["v3_open", "exposicion", "v3_premanifest"]);
    expect(ledger[0]!.prev_sha256).toBeNull();
    expect(ledger[0]!["p3_entries"]).toBe(2);
  });

  it("refuses to read or append when a line was edited", () => {
    const { root } = premanifested();
    const path = v3LedgerPath(root);
    const lines = NodeFS.readFileSync(path, "utf8").split("\n");
    lines[1] = lines[1]!.replace("Perfil v2", "Perfil V2");
    NodeFS.writeFileSync(path, lines.join("\n"));
    expect(() => readLedger(path)).toThrow(/breaks the chain/);
    expect(() => appendV3(root, "exposicion", { texto: "x" })).toThrow(/breaks the chain/);
  });

  it("v3_open must name P3's last entry, and P3 must keep it", () => {
    const r = freshRoot();
    expect(() =>
      appendV3(r.root, "v3_open", { p3_entries: 1, p3_last_sha256: "sha256:00" }),
    ).toThrow(/last entry of P3/);
    const { root } = openRoot();
    const p3 = NodePath.join(root, "p3", "libro", "ledger-p3.jsonl");
    NodeFS.writeFileSync(p3, NodeFS.readFileSync(p3, "utf8").replace("paso 0", "paso 1"));
    expect(() => appendV3(root, "exposicion", { texto: "x" })).toThrow();
  });

  it("enforces the freeze order without going back", () => {
    const r = openRoot();
    expect(() => appendV3(r.root, "v3_oracle", oraclePayload(r.root))).toThrow(
      /before v3_premanifest/,
    );
    expect(() =>
      appendV3(
        r.root,
        "v3_premanifest",
        premanifestPayload({ root: r.root, files: r.premanifest }),
      ),
    ).toThrow(/Perfil v2/);
    appendV3(r.root, "exposicion", { texto: PROFILE_TEXT });
    appendV3(r.root, "v3_premanifest", premanifestPayload({ root: r.root, files: r.premanifest }));
    expect(() => appendV3(r.root, "v3_premanifest", {})).toThrow(/already has/);
    expect(() => appendV3(r.root, "v3_judge_diag", {})).toThrow(/before v3_oracle/);
    appendV3(r.root, "v3_oracle", oraclePayload(r.root));
    expect(() => appendV3(r.root, "v3_dev_results", {})).toThrow(/before v3_judge_diag/);
    expect(() => appendV3(r.root, "v3_pairs", { motor: "v3" })).toThrow(/before v3_freeze/);
    appendV3(r.root, "v3_judge_diag", { fallido: true });
    appendV3(r.root, "v3_dev_results", { decision: { promote: false, stop: true } });
    expect(() => appendV3(r.root, "v3_freeze", { aprobacion_miguel: "sí" })).toThrow(/promote/);
    appendV3(r.root, "v3_pairs", { motor: "engine.v1" });
    expect(() => appendV3(r.root, "v3_pairs", { motor: "engine.v1" })).toThrow(/once/);
    expect(() => appendV3(r.root, "v3_prospective", { fecha: "2026-01-01" })).toThrow(/day after/);
    appendV3(r.root, "v3_prospective", { fecha: "2099-01-01" });
    expect(() => appendV3(r.root, "v3_prospective", { fecha: "2099-01-01" })).toThrow(/exists/);
    appendV3(r.root, "stop", { motivo: "fin" });
    expect(() => appendV3(r.root, "v3_freeze", { aprobacion_miguel: "sí" })).toThrow(/stop/);
  });

  it("freeze needs promotion and Miguel's approval; v3 pairs need the freeze", () => {
    const r = premanifested();
    appendV3(r.root, "v3_oracle", oraclePayload(r.root));
    appendV3(r.root, "v3_judge_diag", { fallido: false });
    appendV3(r.root, "v3_dev_results", { decision: { promote: true, stop: false } });
    expect(() => appendV3(r.root, "v3_freeze", {})).toThrow(/approval/);
    appendV3(r.root, "v3_freeze", { aprobacion_miguel: "Miguel aprueba la promoción" });
    appendV3(r.root, "v3_pairs", { motor: "v3" });
    expect(readV3Ledger(r.root).at(-1)!.kind).toBe("v3_pairs");
  });
});

describe("v3_premanifest integrity", () => {
  it("records the hashes, both profiles and R4's keywords", () => {
    const r = openRoot();
    const payload = premanifestPayload({ root: r.root, files: r.premanifest });
    expect(payload.perfiles.v2.sha256).toMatch(/^sha256:/);
    expect(payload.perfiles.v1.sha256).not.toBe(payload.perfiles.v2.sha256);
    expect(payload.perfiles.r4_keywords.nota).toBe("R4 usa keywords.v1.json");
    expect(payload.card_text_v3.function_sha256).toMatch(/^sha256:/);
    expect(payload.tardio).toBe(false);
    expect(payload.medicion_a_sin_wikipedia.despegues_42_cortes).toBe(58);
  });

  it("fails and says so when B's files do not exist yet", () => {
    const r = openRoot();
    expect(() =>
      premanifestPayload({
        root: r.root,
        files: { ...r.premanifest, rubric: "/no/judge.util.v1.json" },
      }),
    ).toThrow(/does not exist yet/);
    NodeFS.writeFileSync(r.premanifest.cardText, "export const x = 1;\n");
    expect(() => premanifestPayload({ root: r.root, files: r.premanifest })).toThrow(/cardTextV3/);
  });

  it("is refused while a judge cache entry exists under v3/", () => {
    const r = openRoot();
    const cache = NodePath.join(r.root, "v3", "b", "cache-jueces", "opus.jsonl");
    NodeFS.mkdirSync(NodePath.dirname(cache), { recursive: true });
    NodeFS.writeFileSync(cache, '{"k":1}\n');
    expect(judgeCacheEntries(r.root)).toEqual([cache]);
    expect(() => premanifestPayload({ root: r.root, files: r.premanifest })).toThrow(
      /Judge cache entries/,
    );
    const late = premanifestPayload({ root: r.root, files: r.premanifest, late: true });
    expect(late.tardio).toBe(true);
    expect(late.encontrados_al_asentar.cache_jueces).toEqual([cache]);
  });

  it("is refused with an entry of an extra judge cache directory, and with a p4 label", () => {
    const r = openRoot();
    const extra = NodePath.join(r.root, "elsewhere");
    NodeFS.mkdirSync(extra, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(extra, "x.json"), "{}");
    expect(() =>
      premanifestPayload({ root: r.root, files: r.premanifest, judgeCaches: [extra] }),
    ).toThrow(/Judge cache/);
    const r2 = openRoot();
    const label = NodePath.join(
      r2.root,
      "v3",
      "d",
      "p4",
      "etiquetas",
      "etiquetas-p4-2026-10-04.jsonl",
    );
    NodeFS.mkdirSync(NodePath.dirname(label), { recursive: true });
    NodeFS.writeFileSync(label, "{}\n");
    expect(p4LabelFiles(r2.root)).toEqual([label]);
    expect(() => premanifestPayload({ root: r2.root, files: r2.premanifest })).toThrow(/p4 labels/);
  });

  it("ignores documents and empty files", () => {
    const r = openRoot();
    NodeFS.mkdirSync(NodePath.join(r.root, "v3", "b", "juez"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(r.root, "v3", "b", "juez", "informe.md"), "texto");
    NodeFS.writeFileSync(NodePath.join(r.root, "v3", "b", "juez", "vacio.jsonl"), "");
    expect(judgeCacheEntries(r.root)).toEqual([]);
  });

  it("hashes the function source up to its matching brace", () => {
    const text =
      "export function cardTextV3(a: { b: number }): string {\n  return `${a.b}`;\n}\nconst z = 2;";
    expect(functionSource(text, "cardTextV3")).toBe(
      "export function cardTextV3(a: { b: number }): string {\n  return `${a.b}`;\n}",
    );
  });
});

describe("labelling order", () => {
  const ctx = (root: string, extra: Record<string, string> = {}): V3Context => ({
    root,
    opt: (name) => extra[name],
    opts: (name) => (extra[name] ? [extra[name]!] : []),
    flag: () => false,
  });

  it("refuses to label before v3_oracle", async () => {
    const r = premanifested();
    expect(() => assertCanLabel(readV3Ledger(r.root))).toThrow(/before the v3_oracle/);
    await expect(
      v3Command(
        "evaluate",
        [],
        ctx(r.root, { corpus: "/x", coverage: "/x", bolsas: "/x", listas: "/x" }),
      ),
    ).rejects.toThrow(/before the v3_oracle/);
    const oracle = oraclePayload(r.root);
    expect(oracle.cortes_sellados_p1.cortes).toEqual(["2026-10-27", "2026-10-30"]);
    expect(oracle.definicion.corroboracion.entidad_enlazada).toMatch(/^estricta/);
    appendV3(r.root, "v3_oracle", oracle);
    expect(() => assertCanLabel(readV3Ledger(r.root))).not.toThrow();
  });

  it("refuses v3_oracle once a p4 label exists", () => {
    const r = premanifested();
    const label = NodePath.join(r.root, "v3", "d", "labels", "2026-10-04.jsonl");
    NodeFS.mkdirSync(NodePath.dirname(label), { recursive: true });
    NodeFS.writeFileSync(label, "{}\n");
    expect(() => oraclePayload(r.root)).toThrow(/before v3_oracle/);
  });

  it("libro exposicion --dry-run checks the order and writes nothing", async () => {
    const r = openRoot();
    const before = NodeFS.readFileSync(v3LedgerPath(r.root), "utf8");
    const c: V3Context = { ...ctx(r.root, { texto: PROFILE_TEXT }), flag: (f) => f === "dry-run" };
    expect(await v3Command("libro", ["exposicion"], c)).toBe(0);
    expect(NodeFS.readFileSync(v3LedgerPath(r.root), "utf8")).toBe(before);
  });
});
