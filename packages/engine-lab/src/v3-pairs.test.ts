// @effect-diagnostics nodeBuiltinImport:off - the pairs draw and the blind export.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  blindExport,
  blindSchemaPaths,
  directoryHash,
  drawPairs,
  keyPaths,
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

  /** The exact fields B's judge-score writes per card (judge-v3-score.ts), with nested judges. */
  const bCard = {
    topic_id: "t1",
    item_ids: ["i1"],
    utility_opus: 5,
    utility_sol: 1,
    utility: 3,
    utility_difference: 4,
    fit: "discrepan",
    fit_opus: "core",
    fit_sol: "out",
    text_sha256: "sha256:00",
    arm: "V1",
    judges: { opus: { valid: true, utility: 5, fit: "core", reason: "r", angle: "a", key: "k" } },
  };
  /** A's list entry (listas/<arm>/<day>.json, moving[]), with judge fields smuggled inside. */
  const aEntry = {
    ...bCard,
    position: 1,
    slot: "rank",
    arm_score: {
      method: "weighted_sum.v3",
      score: 1.2,
      components: [{ name: "relevance", value: 0.6, weight: 1, contribution: 0.6 }],
    },
    card: {
      schema_version: "earlyscript.dossier/2",
      cutoff_at: "2026-10-10T00:00:00.000Z",
      engine: { version: "engine.v3", config_hash: "sha256:c" },
      profile: { name: "singularidev", version: "v2", hash: "sha256:p" },
      profile_fit: { include_score: 0.7, exclude_score: 0.1, passes: true },
      origin: "run_x",
      related: ["t9"],
      coverage: { window_days: 35 },
      data_gaps: [],
      curve: [{ day: "2026-10-09", items: 2 }],
      trend: {
        id: "trd_1",
        label: "alpha beta",
        label_source: "provider",
        top_terms: ["alpha"],
        items_7d: 3,
        stage: "growing",
        growth: 1.2,
      },
      movement: {
        movement: "nueva",
        movement_since: "2026-10-09",
        weeks: [3, 0, 0, 0, 0],
        pop: 2.1,
        tau_days: 7,
        relevance: { score: 0.6, model_id: "m" },
        cut: { p50: 1, p90: 3 },
        by_source: [
          {
            source: "hn",
            status: "comparable",
            weeks: [3, 0, 0, 0, 0],
            total: 3,
            authors_w0: 2,
            utility_opus: 4,
          },
        ],
        first_source: { source: "hn", at: "2026-10-08", item_id: "i1", arm: "V1" },
        second_source: null,
        fit: {
          nearest_include: "agents",
          nearest_exclude: "crypto",
          matched_terms: ["agent"],
          keywords_version: "k1",
          headlines: [
            { item_id: "i1", source: "hn", title: "T", permalink: "p", judges: { sol: 1 } },
          ],
        },
        saturation: {
          items_life: 3,
          items_total: 4,
          heavy_weeks: 0,
          perennial: false,
          decided_at: null,
        },
      },
      evidence: [
        {
          item_id: "i1",
          source: "hn",
          title: "T",
          permalink: "p",
          external_url: "u",
          published_at: "2026-10-09T01:00:00Z",
          author: "a",
          excerpt: "e",
          relevance: 0.6,
          similarity: 0.9,
          retrieved_at: "x",
          week: 0,
          also_in: [
            { source: "npm", item_id: "i2", permalink: "q", published_at: "z", fit_sol: "out" },
          ],
        },
      ],
      evidence_status: "sufficient",
      utility_opus: 5,
      fit_opus: "core",
      judges: { opus: { utility: 5 } },
    },
  };
  const FORBIDDEN =
    /utility|fit_|judge|juez|arm|position|slot|score|engine|profile|origin|config|text_sha256|relevance|similarity|^pop$|^cut$|related|label_source|nearest_exclude/;

  it("passes only the allowed schema: nothing of B's output survives (Sol D2)", () => {
    expect(blindExport([bCard])).toEqual([{}]);
    expect(blindExport({ cards: [bCard] })).toEqual([{}]);
  });

  it("projects A's card on the allowed schema, dropping smuggled fields at every depth", () => {
    const out = blindExport({ moving: [aEntry] });
    const paths = keyPaths(out);
    const allowed = blindSchemaPaths();
    expect([...paths].filter((p) => !allowed.has(p))).toEqual([]);
    expect([...paths].filter((p) => FORBIDDEN.test(p.split(".").at(-1)!))).toEqual([]);
    expect(Object.keys(out[0]!)).not.toContain("fit");
    expect(out[0]).toMatchObject({
      trend: { label: "alpha beta", top_terms: ["alpha"] },
      movement: { movement: "nueva", fit: { matched_terms: ["agent"] }, second_source: null },
      evidence: [{ item_id: "i1", also_in: [{ source: "npm" }] }],
    });
  });

  it("never lets an object through a leaf of the schema", () => {
    const out = blindExport([
      { card: { cutoff_at: { judge: 5 }, trend: { top_terms: [{ utility_opus: 4 }] } } },
    ]);
    expect(out).toEqual([{ trend: {} }]);
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
