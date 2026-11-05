// @effect-diagnostics nodeBuiltinImport:off - the lab's fixtures lay out a synthetic corpus and its job files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { labFixture, REPO_ROOT, type LabFixture } from "@earlyscript/engine-lab/testkit";
import { SYNTHETIC_PROFILE } from "@earlyscript/engine-lab/synthetic";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { EditorialProfileService } from "./EditorialProfileService.ts";
import * as EditorialProfile from "./EditorialProfileService.ts";
import * as EditorialSourcesService from "./EditorialSourcesService.ts";
import * as EngineChangeService from "./EngineChangeService.ts";
import * as EngineExperimentService from "./EngineExperimentService.ts";
import * as EnginePromotionService from "./EnginePromotionService.ts";
import {
  DEFAULT_LAB_TIMING,
  type EngineLabOptionsShape,
  layerOptionsWith,
} from "./engineLabSupport.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";

export const TEST_PROJECT = "project:engine-lab";
export const OTHER_PROJECT = "project:other";

export interface LabHarness {
  readonly dir: string;
  readonly db: string;
  readonly fixture: LabFixture;
  readonly options: EngineLabOptionsShape;
  /** The product's active profile file, as the campaigns hand it to the worker. */
  readonly profilePath: string;
}

export function labHarness(
  dir: string,
  overrides: Partial<EngineLabOptionsShape> = {},
): LabHarness {
  const fixture = labFixture(NodePath.join(dir, "fixture"), { days: 26 });
  return {
    dir,
    db: NodePath.join(dir, "editorial.sqlite"),
    fixture,
    profilePath: NodePath.join(dir, "profile.json"),
    options: {
      engine: Result.succeed({
        cli: NodePath.join(REPO_ROOT, "packages/trend-engine/src/cli.ts"),
        defaultConfig: fixture.config_path,
      }),
      engineRoot: REPO_ROOT,
      jobsRoot: NodePath.join(dir, "jobs"),
      remote: null,
      ...DEFAULT_LAB_TIMING,
      ...overrides,
    },
  };
}

/** The lab services over the harness's database file; a new layer is a server restart. */
export const labLayer = (harness: LabHarness) =>
  Layer.merge(EngineChangeService.layer, EngineExperimentService.layer).pipe(
    Layer.provideMerge(EnginePromotionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        layerOptionsWith(harness.options),
        EditorialSourcesService.layerWithCorpusDir(harness.fixture.corpus_dir),
        EditorialProfile.layer,
      ),
    ),
    Layer.provideMerge(EditorialDatabase.layerFromPath(harness.db)),
    Layer.provideMerge(NodeServices.layer),
  );

/**
 * The product's profile becomes the synthetic channel's, and its file is written where the
 * campaigns point: the worker checks it has the active profile's hash.
 */
export const useSyntheticProfile = (harness: LabHarness) =>
  Effect.gen(function* () {
    const profiles = yield* EditorialProfileService;
    yield* profiles.update({
      name: SYNTHETIC_PROFILE.name,
      audience: SYNTHETIC_PROFILE.audience,
      language: "en",
      include: [...SYNTHETIC_PROFILE.include],
      exclude: [...SYNTHETIC_PROFILE.exclude],
    });
    const active = yield* profiles.activeFile;
    NodeFS.writeFileSync(harness.profilePath, active.bytes);
    return active.hash;
  });

/** A development campaign over the synthetic corpus and its labels. */
export const syntheticPolicy = (
  harness: LabHarness,
  cutoffs = harness.fixture.cutoffs.slice(0, 3),
) => ({
  cutoffs,
  executor: "local" as const,
  corpus_dir: harness.fixture.corpus_dir,
  profile_path: harness.profilePath,
  cache_file: null,
  cache_only: false,
  models_dir: null,
  embedder: "synthetic" as const,
  workers: 1,
  labels: { cards: harness.fixture.cards_path, labels: harness.fixture.labels_path },
  judge: null,
  input_roots: [harness.dir],
  label_roots: [harness.dir],
});
