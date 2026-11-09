// @effect-diagnostics nodeBuiltinImport:off - the pairs draw and the blind export.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  allKeys,
  BLIND_FORBIDDEN,
  blindExport,
  directoryHash,
  drawPairs,
  type PairsInput,
  pickCitations,
} from "./v3-pairs.ts";

const input: PairsInput = {
  protocolo: "Anexo 6, v3",
  corrida: "run_v3_frozen",
  config: "earlyscript.engine.v3",
  sesiones: Array.from({ length: 6 }, (_, s) => ({
    dominio: `Dominio ${s + 1}`,
    candidatos: Array.from({ length: 3 }, (_, c) => ({
      tema: `tema ${s}-${c}`,
      dossier_id: `dos_${s}${c}`,
      items_7d: 3 + c,
    })),
  })),
};

describe("pairs draw", () => {
  it("has the structure of the 6 Nov sheet and is deterministic for a seed", () => {
    const a = drawPairs(input, 20261110);
    expect(Object.keys(a)).toEqual(["protocolo", "semilla", "corrida", "config", "sesiones"]);
    expect(a.sesiones).toHaveLength(6);
    for (const s of a.sesiones) {
      expect(s.ejercicios.map((e) => e.orden)).toEqual([1, 2]);
      expect(new Set(s.ejercicios.map((e) => e.modo))).toEqual(new Set(["manual", "asistido"]));
      expect(Object.keys(s.ejercicios[0]!)).toEqual([
        "orden",
        "modo",
        "tema",
        "dossier_id",
        "items_7d",
      ]);
    }
    expect(drawPairs(input, 20261110)).toEqual(a);
    expect(drawPairs(input, 20261111)).not.toEqual(a);
  });

  it("refuses the old seed, a wrong number of sessions and repeated dossiers", () => {
    expect(() => drawPairs(input, 20261106)).toThrow(/new seed/);
    expect(() => drawPairs({ ...input, sesiones: input.sesiones.slice(1) }, 1)).toThrow(/Six/);
    const dup = {
      ...input,
      sesiones: input.sesiones.map((s) => ({
        ...s,
        candidatos: [s.candidatos[0]!, { ...s.candidatos[1]!, dossier_id: "dos_00" }],
      })),
    };
    expect(() => drawPairs(dup, 1)).toThrow(/two places/);
  });

  it("picks 3 citations per card by the prerregistered seed", () => {
    const cites = ["a", "b", "c", "d", "e", "f"];
    const one = pickCitations("card1", cites, 7);
    expect(one).toHaveLength(3);
    expect(pickCitations("card1", cites, 7)).toEqual(one);
    expect(new Set(one).size).toBe(3);
    expect(pickCitations("card1", ["a", "b"], 7)).toHaveLength(2);
  });
});

describe("blind export and run hash", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v3-pairs-"));
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it("drops judge, arm and provenance fields at every depth", () => {
    const card = {
      title: "t",
      include_score: 0.7,
      arm: "V1",
      config_hash: "sha256:1",
      judge: { opus: 4 },
      juez_sol: 3,
      evidence: [{ item_id: "i1", url: "u", provenance: "run_1", rank: 2 }],
      dossier: { movement: "nueva", run_id: "r", engine: "v3", variant: "V2" },
    };
    const out = blindExport([card]);
    const keys = [...allKeys(out)];
    expect(keys.filter((k) => BLIND_FORBIDDEN.test(k) || /judge|juez/i.test(k))).toEqual([]);
    expect(keys).toEqual(
      expect.arrayContaining(["title", "include_score", "evidence", "item_id", "movement"]),
    );
  });

  it("hashes a run directory by its files", () => {
    NodeFS.mkdirSync(NodePath.join(dir, "run", "sub"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "run", "a.json"), "1");
    NodeFS.writeFileSync(NodePath.join(dir, "run", "sub", "b.json"), "2");
    const h = directoryHash(NodePath.join(dir, "run"));
    expect(directoryHash(NodePath.join(dir, "run"))).toBe(h);
    NodeFS.writeFileSync(NodePath.join(dir, "run", "sub", "b.json"), "3");
    expect(directoryHash(NodePath.join(dir, "run"))).not.toBe(h);
  });
});
