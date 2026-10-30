// Channel-profile affinity, ported from Earlywindow's src/engine/profile.ts (step 8):
// close to some included topic and far from every excluded one. Maximum, not mean.
import { dot } from "./cluster.ts";

export interface ProfileVectors {
  readonly include: ReadonlyArray<Float32Array>;
  readonly exclude: ReadonlyArray<Float32Array>;
}

export interface ProfileScore {
  readonly include_score: number;
  readonly exclude_score: number;
  readonly passes: boolean;
  /** Index of the include topic with the highest cosine. */
  readonly nearest_include: number;
}

export function scoreProfile(
  centroid: Float32Array,
  topics: ProfileVectors,
  includeMin: number,
  excludeMax: number,
): ProfileScore {
  let include_score = -Infinity;
  let nearest_include = -1;
  topics.include.forEach((topic, index) => {
    const cosine = dot(centroid, topic);
    if (cosine > include_score) {
      include_score = cosine;
      nearest_include = index;
    }
  });
  const exclude_score = topics.exclude.reduce(
    (best, topic) => Math.max(best, dot(centroid, topic)),
    topics.exclude.length === 0 ? 0 : -Infinity,
  );
  return {
    include_score,
    exclude_score,
    passes: include_score >= includeMin && exclude_score < excludeMax,
    nearest_include,
  };
}
