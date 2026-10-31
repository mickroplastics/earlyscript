// Retrospective label and ranking metrics, ported from early-window/scripts/backtest.ts
// (assignStories, crossingLabel, precisionAt, median, rankingMetrics; backtest.v0.02). Only the
// original label: the three variants of C04 (exclude_cutoff_day, growth_2x, high_threshold)
// are not part of the source gate.
import { LABEL_RULE } from "./backtest-report.ts";
import { dot } from "./cluster.ts";
import { DAY_MS, dayOf, dayStart } from "./days.ts";

export interface Story {
  readonly id: string;
  readonly publishedMs: number;
  readonly author: string | null;
  readonly vector: Float32Array;
}

export interface Candidate {
  readonly id: string;
  readonly centroid: Float32Array;
}

export interface Label {
  readonly positive: boolean;
  readonly event_day: string | null;
  readonly lead_days: number | null;
  readonly followup_stories: number;
  readonly followup_authors: number;
}

/** Each story in [startMs, endMs) joins the candidate with the highest cosine above the threshold; ties to the smaller id. */
export function assignStories(
  candidates: ReadonlyArray<Candidate>,
  stories: ReadonlyArray<Story>,
  startMs: number,
  endMs: number,
  threshold: number,
): Map<string, Array<Story>> {
  const tails = new Map(candidates.map((c) => [c.id, [] as Array<Story>]));
  for (const story of stories) {
    if (story.publishedMs < startMs || story.publishedMs >= endMs) continue;
    let best: Candidate | undefined;
    let bestCosine = threshold;
    for (const c of candidates) {
      const cosine = dot(story.vector, c.centroid);
      if (cosine > bestCosine || (best && cosine === bestCosine && c.id < best.id)) {
        best = c;
        bestCosine = cosine;
      }
    }
    if (best) tails.get(best.id)!.push(story);
  }
  for (const tail of tails.values()) {
    tail.sort((a, b) => a.publishedMs - b.publishedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return tails;
}

/** Positive on the first day whose end brings the tail to eventStories stories from eventAuthors authors. */
export function crossingLabel(
  tail: ReadonlyArray<Story>,
  cutoffMs: number,
  eventStories: number,
  eventAuthors: number,
): Label {
  const authors = new Set<string>();
  let label: Label = {
    positive: false,
    event_day: null,
    lead_days: null,
    followup_stories: tail.length,
    followup_authors: 0,
  };
  tail.forEach((story, k) => {
    if (story.author !== null) authors.add(story.author);
    const day = dayOf(story.publishedMs);
    const lastOfDay = k === tail.length - 1 || dayOf(tail[k + 1]!.publishedMs) !== day;
    if (!label.positive && lastOfDay && k + 1 >= eventStories && authors.size >= eventAuthors) {
      label = {
        ...label,
        positive: true,
        event_day: day,
        lead_days: (dayStart(day) - cutoffMs) / DAY_MS,
      };
    }
  });
  return { ...label, followup_authors: authors.size };
}

export function labelCandidates(
  candidates: ReadonlyArray<Candidate>,
  stories: ReadonlyArray<Story>,
  cutoffMs: number,
  threshold: number,
): Map<string, Label> {
  const tails = assignStories(
    candidates,
    stories,
    cutoffMs,
    cutoffMs + LABEL_RULE.followup_days * DAY_MS,
    threshold,
  );
  return new Map(
    candidates.map(({ id }) => [
      id,
      crossingLabel(tails.get(id)!, cutoffMs, LABEL_RULE.event_stories, LABEL_RULE.event_authors),
    ]),
  );
}

/** Precision at k with denominator min(k, candidates); null when there is nothing to rank. */
export function precisionAt(ordered: ReadonlyArray<boolean>, k: number): number | null {
  const n = Math.min(k, ordered.length);
  return n === 0 ? null : ordered.slice(0, n).filter(Boolean).length / n;
}

export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const s = values.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface RankingMetrics {
  readonly p_at_5: number | null;
  readonly p_at_10: number | null;
  readonly evaluated_at_5: number;
  readonly evaluated_at_10: number;
  readonly median_lead_days_at_5: number | null;
  readonly lead_days_at_5: ReadonlyArray<number>;
}

export function rankingMetrics(ordered: ReadonlyArray<Label>): RankingMetrics {
  const leads = (k: number) =>
    ordered.slice(0, k).flatMap((label) => (label.lead_days === null ? [] : [label.lead_days]));
  const positives = ordered.map((label) => label.positive);
  return {
    p_at_5: precisionAt(positives, 5),
    p_at_10: precisionAt(positives, 10),
    evaluated_at_5: Math.min(5, ordered.length),
    evaluated_at_10: Math.min(10, ordered.length),
    median_lead_days_at_5: median(leads(5)),
    lead_days_at_5: leads(5),
  };
}

