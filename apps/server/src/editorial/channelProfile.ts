// @effect-diagnostics nodeBuiltinImport:off -- the profile hash is a pure sha256 of fixed bytes.
import * as NodeCrypto from "node:crypto";

import type { TrendPresentationProfile } from "@t3tools/provider-core/server/textGeneration";

/**
 * Bytes of Earlywindow's `profiles/singularidev.v1.json` (profile/1, version 1). The engine
 * hashes the file bytes, so `sha256` of this string equals `profile.hash` in the dossiers
 * of runs scored with it. Only the seed of `editorial_profiles` (migration EditorialProfile)
 * and tests read it; the server takes the active profile from `EditorialProfileService`.
 */
export const SINGULARIDEV_PROFILE_V1 =
  '{\n  "schema_version": "profile/1",\n  "name": "SingulariDev",\n  "audience": "Solo founders and developers building products with AI agents and automation, in English",\n  "include": [\n    "AI coding agents and agent harnesses for developers",\n    "local and open-weight language models running on personal hardware",\n    "automation of software and content workflows with LLM tools",\n    "developer tooling, SDKs and protocols for building AI products",\n    "one-person startups shipping AI products"\n  ],\n  "exclude": [\n    "consumer gadget reviews and smartphone launches",\n    "cryptocurrency prices and token trading",\n    "politics, elections and legislation without a developer angle",\n    "video game releases and esports"\n  ]\n}\n';

interface ProfileFile {
  readonly name: string;
  readonly audience: string;
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

/** The profile as the prompt reads it: plain lines instead of JSON. */
function profileText(profile: ProfileFile): string {
  return [
    `Channel: ${profile.name}`,
    `Audience: ${profile.audience}`,
    "Topics the channel covers:",
    ...profile.include.map((topic) => `- ${topic}`),
    "Topics the channel leaves out:",
    ...profile.exclude.map((topic) => `- ${topic}`),
  ].join("\n");
}

export function presentationProfileFromBytes(
  bytes: string,
  version: number,
): TrendPresentationProfile {
  const hash = NodeCrypto.createHash("sha256").update(bytes, "utf8").digest("hex");
  return { version, hash: `sha256:${hash}`, text: profileText(JSON.parse(bytes) as ProfileFile) };
}
