// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - test fixtures over the real engine.
// A synthetic corpus, the installed engine's manifest over it, and job specs for tests and the
// end-to-end command. Synthetic: it exercises the mechanism, never editorial quality.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { engineSourceHash, sha256 } from "./hash.ts";
import {
  codeCandidate,
  configCandidate,
  type EngineManifest,
  installedManifest,
  manifestHash,
} from "./manifest.ts";
import { applyFilePatch, parsePatch } from "./patch.ts";
import { applyConfigChange } from "./policy.ts";
import { JOB_SPEC_SCHEMA, type JobSpec } from "./result.ts";
import { type SyntheticCorpus, writeSyntheticCorpus } from "./synthetic.ts";

/** The checkout this package belongs to: its packages/trend-engine is the installed engine. */
export const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
export const ENGINE_SRC = NodePath.join(REPO_ROOT, "packages/trend-engine/src");

export interface LabFixture extends SyntheticCorpus {
  readonly dir: string;
  readonly config: EngineConfig;
  readonly installed: EngineManifest;
}

export function labFixture(
  dir: string,
  input: { readonly fromDay?: string; readonly days?: number } = {},
): LabFixture {
  const corpus = writeSyntheticCorpus({
    dir,
    fromDay: input.fromDay ?? "2026-12-01",
    days: input.days ?? 24,
  });
  const config = JSON.parse(NodeFS.readFileSync(corpus.config_path, "utf8")) as EngineConfig;
  const installed = installedManifest({
    config,
    profileHash: corpus.profile_hash,
    sources: { rank: ["hn", "github"], collect: [] },
    feeds: [],
    engineSourceHash: engineSourceHash(ENGINE_SRC),
  });
  return { ...corpus, dir, config, installed };
}

export const weightCandidate = (fixture: LabFixture, weights: Record<string, number>) =>
  configCandidate(fixture.installed, applyConfigChange(fixture.config, { weights }).config);

/** A code candidate of `patch` over the installed engine, with its files' contents. */
export function patchCandidate(
  fixture: LabFixture,
  patch: string,
): { manifest: EngineManifest; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const file of parsePatch(patch)) {
    files[file.path] = applyFilePatch(
      NodeFS.readFileSync(NodePath.join(REPO_ROOT, file.path), "utf8"),
      file,
    );
  }
  const overrides = new Map(
    Object.entries(files).map(([path, text]) => [
      path.replace("packages/trend-engine/src/", ""),
      text,
    ]),
  );
  const manifest = codeCandidate(fixture.installed, {
    engineSourceHash: engineSourceHash(ENGINE_SRC, overrides),
    patch,
    files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256(text)])),
  });
  return { manifest, files };
}

export function jobSpec(
  fixture: LabFixture,
  input: {
    readonly token: string;
    readonly candidate: EngineManifest;
    readonly files?: Record<string, string>;
    readonly cutoffs?: ReadonlyArray<string>;
    readonly secret?: string;
  },
): JobSpec {
  return {
    schema: JOB_SPEC_SCHEMA,
    token: input.token,
    secret: input.secret ?? "test-secret",
    kind: "development",
    cutoffs: input.cutoffs ?? fixture.cutoffs.slice(0, 3),
    input_roots: [fixture.dir],
    corpus_dir: fixture.corpus_dir,
    profile_path: fixture.profile_path,
    profile_hash: fixture.profile_hash,
    cache_file: null,
    cache_only: false,
    models_dir: null,
    embedder: "synthetic",
    workers: 1,
    top: 10,
    sandbox: input.files === undefined ? "if-available" : "required",
    reference: {
      manifest_hash: manifestHash(fixture.installed),
      manifest: fixture.installed,
      files: {},
    },
    candidate: {
      manifest_hash: manifestHash(input.candidate),
      manifest: input.candidate,
      files: input.files ?? {},
    },
  };
}
