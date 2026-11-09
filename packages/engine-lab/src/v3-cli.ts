// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalConsole:off globalDate:off - v3 ledger and evaluation commands.
// `pnpm --filter @earlyscript/engine-lab v3 <command>` (node src/v3-cli.ts):
//   libro open | exposicion --texto <t> [--tipo <t>] | premanifest [--dry-run] [--tardio]
//     [--rubrica <judge.util.v1.json>] [--card-text <file with cardTextV3>] [--judge-cache <dir>]...
//   libro premanifest-2 --campos <json> | oracle [--dry-run] | judge-diag --kappa --acuerdo
//     --validas-opus --validas-sol [--diag <file>] [--fallido] | dev-results --metricas <file> [--dry-run]
//   libro freeze --config (--checkout <dir> | --commit --tree) --corrida <dir> --semilla-pares --semilla-citas --aprobacion <t> [--hash-logico]
//   libro pairs --motor v3|engine.v1 --resultados <file> | prospective --fecha <día> --resumen <file> | stop --motivo <t>
//   evaluate [--dry-run] --corpus --coverage --bolsas --listas [--jueces] [--out]   (labels p4 after v3_oracle only)
//   pairs-draw --entrada <json> --out <json> | blind-export --entrada <json> --out <json>
// --root defaults to ~/earlyscript-data/hillclimb. Only the coordinator enters ledger entries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { canonicalJson, sha256 } from "./hash.ts";
import { appendLedger, fileSha256, type LedgerEntry } from "./v3-ledger.ts";
import {
  appendV3,
  assertCanLabel,
  assertV3Order,
  devResultsPayload,
  freezePayload,
  judgeDiagPayload,
  oraclePayload,
  p3Closing,
  type PremanifestFiles,
  premanifestPayload,
  readV3Ledger,
  v3Dir,
  type V3LedgerKind,
} from "./v3-libro.ts";
import { evaluateV3, writeLabels } from "./v3-eval.ts";
import { blindExport, directoryHash, drawPairs, type PairsInput } from "./v3-pairs.ts";
import { writeSyntheticV3 } from "./v3-synthetic.ts";

const HOME = NodeOS.homedir();
const DEFAULT_ROOT = NodePath.join(HOME, "earlyscript-data", "hillclimb");
const REPO = NodePath.resolve(import.meta.dirname, "../../..");

export interface V3Context {
  readonly root: string;
  readonly opt: (name: string) => string | undefined;
  readonly opts: (name: string) => Array<string>;
  readonly flag: (name: string) => boolean;
}

const need = (ctx: V3Context, name: string) => {
  const v = ctx.opt(name);
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const num = (ctx: V3Context, name: string) => {
  const v = ctx.opt(name);
  if (v === undefined) return null;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`--${name} is not a number`);
  return n;
};
const writeJson = (path: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const printed = (entry: LedgerEntry) => {
  console.log(JSON.stringify({ kind: entry.kind, at: entry.at, prev_sha256: entry.prev_sha256 }));
  return 0;
};

export function premanifestFiles(ctx: V3Context): PremanifestFiles {
  const v3 = v3Dir(ctx.root);
  const rubric = ctx.opt("rubrica");
  const cardText = ctx.opt("card-text");
  if (!rubric || !cardText)
    throw new Error(
      "v3 premanifest needs --rubrica <judge/judge.util.v1.json> and --card-text <file exporting cardTextV3> (B's paths, given by the coordinator).",
    );
  return {
    contract: ctx.opt("contrato") ?? NodePath.join(v3, "diseno-v3-v4.md"),
    rubric,
    cardText,
    profileV2: ctx.opt("perfil-v2") ?? NodePath.join(v3, "perfil", "singularidev.v2.json"),
    profileV1:
      ctx.opt("perfil-v1") ??
      NodePath.join(
        NodePath.resolve(ctx.root),
        "..",
        "beatriz-home",
        "earlyscript-data",
        "profiles",
        "singularidev.v1.json",
      ),
    keywords:
      ctx.opt("keywords") ??
      NodePath.join(REPO, "packages/trend-engine/config/editorial-eval/keywords.v1.json"),
    measurementA:
      ctx.opt("medicion-a") ?? NodePath.join(v3, "maqueta", "sin-wikipedia", "mediciones-A.json"),
  };
}

/** A dry run of a ledger entry: the order is checked against the real ledger, nothing is written. */
const dryOrder = (ctx: V3Context, kind: V3LedgerKind, payload: Record<string, unknown>) => {
  assertV3Order(readV3Ledger(ctx.root), kind, payload);
  console.log(JSON.stringify({ dry_run: true, kind, protocol: "v3", ...payload }, null, 2));
  return 0;
};

export async function v3LibroCommand(sub: string, ctx: V3Context): Promise<number> {
  const { root } = ctx;
  const dry = ctx.flag("dry-run");
  const enter = (kind: V3LedgerKind, payload: Record<string, unknown>) =>
    dry ? dryOrder(ctx, kind, payload) : printed(appendV3(root, kind, payload));
  switch (sub) {
    case "open": {
      const p3 = p3Closing(root);
      return enter("v3_open", {
        contrato:
          "diseno-v3-v4.md versión 4.2 (consejo 9,2 / 9,5 / 9,5 / 9,5; decisión 1 de Miguel)",
        p3_ledger: NodePath.join(NodePath.resolve(root), "p3", "libro", "ledger-p3.jsonl"),
        p3_entries: p3.entries,
        p3_last_sha256: p3.sha256,
      });
    }
    case "exposicion": {
      const tipo = ctx.opt("tipo");
      return enter("exposicion", { texto: need(ctx, "texto"), ...(tipo ? { tipo } : {}) });
    }
    case "premanifest": {
      const payload = premanifestPayload({
        root,
        files: premanifestFiles(ctx),
        judgeCaches: ctx.opts("judge-cache"),
        late: ctx.flag("tardio"),
      });
      return enter("v3_premanifest", payload);
    }
    case "premanifest-2": {
      const fields = JSON.parse(NodeFS.readFileSync(need(ctx, "campos"), "utf8")) as Record<
        string,
        unknown
      >;
      const pre = readV3Ledger(root).find((e) => e.kind === "v3_premanifest");
      const clash = Object.keys(fields).filter(
        (k) => pre && pre[k] !== undefined && pre[k] !== null,
      );
      if (clash.length > 0)
        throw new Error(`v3_premanifest_2 only adds fields; ${clash.join(", ")} exist.`);
      return enter("v3_premanifest_2", {
        campos: fields,
        campos_sha256: sha256(canonicalJson(fields)),
      });
    }
    case "oracle":
      return enter("v3_oracle", oraclePayload(root));
    case "judge-diag":
      return enter(
        "v3_judge_diag",
        judgeDiagPayload({
          diagPath: ctx.opt("diag"),
          failed: ctx.flag("fallido"),
          kappa: num(ctx, "kappa"),
          agreement: num(ctx, "acuerdo"),
          validOpus: num(ctx, "validas-opus"),
          validSol: num(ctx, "validas-sol"),
        }),
      );
    case "dev-results":
      return enter("v3_dev_results", devResultsPayload(root, need(ctx, "metricas")));
    case "freeze": {
      const runDir = need(ctx, "corrida");
      const checkout = ctx.opt("checkout");
      const code = checkout
        ? gitIdentity(checkout)
        : { commit: need(ctx, "commit"), tree: need(ctx, "tree") };
      return enter(
        "v3_freeze",
        freezePayload({
          configPath: need(ctx, "config"),
          commit: code.commit,
          tree: code.tree,
          runDir,
          runHash: directoryHash(runDir),
          logicalHash: ctx.opt("hash-logico") ?? null,
          pairsSeed: Number(need(ctx, "semilla-pares")),
          citationsSeed: Number(need(ctx, "semilla-citas")),
          approval: need(ctx, "aprobacion"),
        }),
      );
    }
    case "pairs": {
      const results = need(ctx, "resultados");
      return enter("v3_pairs", {
        motor: need(ctx, "motor"),
        resultados: { path: NodePath.resolve(results), sha256: fileSha256(results) },
        fila_5d: ctx.opt("fila-5d") ?? null,
      });
    }
    case "prospective": {
      const summary = need(ctx, "resumen");
      return enter("v3_prospective", {
        fecha: need(ctx, "fecha"),
        resumen: { path: NodePath.resolve(summary), sha256: fileSha256(summary) },
      });
    }
    case "stop":
      return enter("stop", { motivo: need(ctx, "motivo") });
    default:
      throw new Error(`unknown libro subcommand ${sub}`);
  }
}

/** A synthetic root with P3's last line and a v3 ledger up to v3_oracle, in a temporary directory. */
function syntheticRoot() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v3-dry-"));
  appendLedger(NodePath.join(root, "p3", "libro", "ledger-p3.jsonl"), {
    kind: "p3_open",
    synthetic: true,
  });
  const p3 = p3Closing(root);
  appendV3(root, "v3_open", { p3_entries: p3.entries, p3_last_sha256: p3.sha256, synthetic: true });
  appendV3(root, "exposicion", { texto: "Perfil v2 (sintético)" });
  appendV3(root, "v3_premanifest", {
    synthetic: true,
    oraculo_p4_borrador_sha256: oraclePayload(root).sha256,
  });
  appendV3(root, "v3_oracle", oraclePayload(root));
  return root;
}

export async function v3Command(
  command: string,
  rest: ReadonlyArray<string>,
  ctx: V3Context,
): Promise<number> {
  switch (command) {
    case "libro":
      return v3LibroCommand(rest[0] ?? "", ctx);
    case "evaluate": {
      if (ctx.flag("dry-run")) {
        const root = syntheticRoot();
        try {
          assertCanLabel(readV3Ledger(root));
          const paths = writeSyntheticV3(NodePath.join(root, "data"));
          const result = evaluateV3({
            corpus: paths.corpus,
            coverage: paths.coverage,
            bags: paths.bags,
            lists: paths.lists,
            judges: paths.judges,
          });
          const { labels: _labels, ...summary } = result;
          const out = NodePath.join(v3Dir(ctx.root), "d", "dry-run", "evaluacion-sintetica.json");
          writeJson(out, { synthetic: true, ...summary });
          console.log(
            JSON.stringify({
              dry_run: true,
              out,
              takeoffs: summary.takeoffs.length,
              decide_input: summary.decide_input,
            }),
          );
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
        return 0;
      }
      assertCanLabel(readV3Ledger(ctx.root));
      const out = ctx.opt("out") ?? NodePath.join(v3Dir(ctx.root), "d", "p4");
      const result = evaluateV3({
        corpus: need(ctx, "corpus"),
        coverage: need(ctx, "coverage"),
        bags: need(ctx, "bolsas"),
        lists: need(ctx, "listas"),
        judges: ctx.opt("jueces") ?? null,
      });
      const { labels, ...summary } = result;
      writeLabels(NodePath.join(out, "etiquetas"), labels);
      writeJson(NodePath.join(out, "metricas-desarrollo.json"), summary);
      console.log(
        JSON.stringify({
          out,
          takeoffs: summary.takeoffs.length,
          recall_evaluable: summary.recall_evaluable,
        }),
      );
      return 0;
    }
    case "pairs-draw": {
      const ledger = readV3Ledger(ctx.root);
      const freeze = ledger.find((e) => e.kind === "v3_freeze");
      if (!freeze) throw new Error("The v3 pairs are drawn on a frozen run: no v3_freeze.");
      const run = freeze["corrida"] as { dir: string; sha256: string };
      if (directoryHash(run.dir) !== run.sha256)
        throw new Error("The frozen run changed since v3_freeze.");
      const input = JSON.parse(NodeFS.readFileSync(need(ctx, "entrada"), "utf8")) as PairsInput;
      if (input.corrida !== NodePath.basename(run.dir))
        throw new Error(`The input names ${input.corrida}, not the frozen run.`);
      const out = need(ctx, "out");
      writeJson(out, drawPairs(input, Number(freeze["semilla_pares"])));
      console.log(JSON.stringify({ out, sha256: fileSha256(out) }));
      return 0;
    }
    case "blind-export": {
      const out = need(ctx, "out");
      writeJson(out, blindExport(JSON.parse(NodeFS.readFileSync(need(ctx, "entrada"), "utf8"))));
      console.log(JSON.stringify({ out, sha256: fileSha256(out) }));
      return 0;
    }
    default:
      throw new Error(`unknown v3 command ${command}`);
  }
}

export function gitIdentity(checkout: string) {
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opts = (name: string) =>
    argv.flatMap((a, k) => (a === `--${name}` && argv[k + 1] !== undefined ? [argv[k + 1]!] : []));
  const ctx: V3Context = {
    root: opts("root")[0] ?? DEFAULT_ROOT,
    opt: (name) => opts(name)[0],
    opts,
    flag: (name) => argv.includes(`--${name}`),
  };
  const [command, ...rest] = argv.filter(
    (a, k) =>
      !a.startsWith("--") &&
      !(
        k > 0 &&
        argv[k - 1]!.startsWith("--") &&
        !["--dry-run", "--tardio", "--fallido"].includes(argv[k - 1]!)
      ),
  );
  try {
    process.exitCode = await v3Command(command ?? "", rest, ctx);
  } catch (error) {
    console.error(
      error instanceof Error
        ? `${(error as { code?: string }).code ?? "error"}: ${error.message}`
        : String(error),
    );
    process.exitCode = 1;
  }
}
