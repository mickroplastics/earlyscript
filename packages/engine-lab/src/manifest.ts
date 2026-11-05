// An engine manifest: everything that decides what a nightly run emits, by hash. A candidate is
// a manifest; the active engine is a pointer to one. Two equal manifests hash equally.
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { canonicalJson, sha256 } from "./hash.ts";
import { configHash } from "./policy.ts";

export const MANIFEST_SCHEMA = "earlyscript.engine-manifest/1";

export type ManifestKind = "installed" | "config" | "code";

export interface ManifestCode {
  /** `ENGINE_SOURCE_HASH` of the sources the run executes. */
  readonly engine_source_hash: string;
  /** The installed engine's source hash a patch applies to; equal to the above when none. */
  readonly base_source_hash: string;
  readonly patch_sha256: string | null;
  /** Patched files (repository paths) and the sha256 of their new contents. */
  readonly files: Readonly<Record<string, string>>;
}

export interface EngineManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly kind: ManifestKind;
  /** The manifest hash this one was derived from; null for the installed engine. */
  readonly parent: string | null;
  /** The whole configuration the nightly run writes for the engine, sources included. */
  readonly config: EngineConfig;
  readonly config_hash: string;
  readonly profile_hash: string;
  readonly sources: {
    readonly rank: ReadonlyArray<string>;
    readonly collect: ReadonlyArray<string>;
  };
  /** sha256 of the canonical RSS feed list: a feed changes what `rss` captures. */
  readonly feeds_hash: string;
  readonly model: {
    readonly embedder: string;
    readonly relevance: { readonly model: string; readonly sha256: string } | null;
  };
  readonly code: ManifestCode;
}

export const manifestHash = (manifest: EngineManifest) => sha256(canonicalJson(manifest));

export const feedsHash = (feeds: unknown) => sha256(canonicalJson(feeds));

const embedderOf = (config: EngineConfig) =>
  `${config.embedder.model}@${config.embedder.revision}/${config.embedder.dtype}/${config.embedder.pooling}`;

/** The manifest of what runs today: `config` as the nightly plan builds it. */
export function installedManifest(input: {
  readonly config: EngineConfig;
  readonly profileHash: string;
  readonly sources: EngineManifest["sources"];
  readonly feeds: unknown;
  readonly engineSourceHash: string;
}): EngineManifest {
  return {
    schema: MANIFEST_SCHEMA,
    kind: "installed",
    parent: null,
    config: input.config,
    config_hash: configHash(input.config),
    profile_hash: input.profileHash,
    sources: { rank: [...input.sources.rank], collect: [...input.sources.collect] },
    feeds_hash: feedsHash(input.feeds),
    model: {
      embedder: embedderOf(input.config),
      relevance:
        input.config.relevance === undefined
          ? null
          : { model: input.config.relevance.model, sha256: input.config.relevance.sha256 },
    },
    code: {
      engine_source_hash: input.engineSourceHash,
      base_source_hash: input.engineSourceHash,
      patch_sha256: null,
      files: {},
    },
  };
}

/** `parent` with a new configuration: same profile, sources, feeds, model and code. */
export function configCandidate(parent: EngineManifest, config: EngineConfig): EngineManifest {
  return {
    ...parent,
    kind: "config",
    parent: manifestHash(parent),
    config,
    config_hash: configHash(config),
  };
}

/** `parent` with patched engine files: same configuration and inputs, other code. */
export function codeCandidate(
  parent: EngineManifest,
  code: {
    readonly engineSourceHash: string;
    readonly patch: string;
    readonly files: Readonly<Record<string, string>>;
  },
): EngineManifest {
  return {
    ...parent,
    kind: "code",
    parent: manifestHash(parent),
    code: {
      engine_source_hash: code.engineSourceHash,
      base_source_hash: parent.code.base_source_hash,
      patch_sha256: sha256(code.patch),
      files: code.files,
    },
  };
}

export interface ManifestDiff {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** Leaf differences between two manifests, by dotted path, for the operator and the model. */
export function diffManifests(from: EngineManifest, to: EngineManifest): Array<ManifestDiff> {
  const out: Array<ManifestDiff> = [];
  const walk = (path: string, a: unknown, b: unknown) => {
    if (canonicalJson(a) === canonicalJson(b)) return;
    const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (isObject(a) && isObject(b)) {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const key of [...keys].toSorted()) {
        walk(
          path ? `${path}.${key}` : key,
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        );
      }
      return;
    }
    out.push({ path, from: a ?? null, to: b ?? null });
  };
  walk("", { ...from, parent: null, kind: null }, { ...to, parent: null, kind: null });
  return out;
}

export interface ProductContext {
  readonly profileHash: string;
  readonly rank: ReadonlyArray<string>;
  readonly collect: ReadonlyArray<string>;
  readonly feedsHash: string;
  readonly engineSourceHash: string;
}

/**
 * Why `manifest` no longer describes what the product would run: the profile, the source
 * switches or the feeds changed through another flow, or another engine is installed.
 */
export function staleReasons(manifest: EngineManifest, context: ProductContext): Array<string> {
  const reasons: Array<string> = [];
  if (manifest.profile_hash !== context.profileHash) reasons.push("profile");
  if (canonicalJson(manifest.sources.rank) !== canonicalJson(context.rank))
    reasons.push("rank-sources");
  if (canonicalJson(manifest.sources.collect) !== canonicalJson(context.collect)) {
    reasons.push("collect-sources");
  }
  if (manifest.feeds_hash !== context.feedsHash) reasons.push("rss-feeds");
  if (manifest.code.engine_source_hash !== context.engineSourceHash) reasons.push("engine-code");
  return reasons;
}
