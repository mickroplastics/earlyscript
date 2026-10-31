// @effect-diagnostics globalDate:off - plain async library with native fetch and UTC timestamps.
// Hugging Face Hub: models created on the day ranked by present-day likes, plus that day's Daily Papers.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { githubEntity, itemBody, markdownText, plainText, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

/** Models kept per day: the most liked among those created that day, with at least one like. */
export const HF_MODELS_PER_DAY = 50;
const MODELS_PAGE = 1000;
/** About 3500 models are created per day, so this bounds one run to roughly two months back. */
const MAX_MODEL_PAGES = 200;
const PAPERS_PAGE = 100;
const MAX_PAPER_PAGES = 5;
const HUB = "https://huggingface.co";

export const HF_SELECTION =
  `models: createdAt in the UTC day, likes>=1, sort present-day likes then downloads, first ${HF_MODELS_PER_DAY}, ` +
  "body = model card README as plain text (front matter, code, images and table rules removed), " +
  "cut to 4000 chars; without a usable card (absent, empty, refused by robots.txt, over 2 MiB) " +
  "body = the model tags without a namespace; papers: every Daily Papers entry submitted that " +
  "day (date=day)";

// Public Hub responses validated at the adapter boundary; unknown keys are ignored.
const HfModels = Schema.Array(
  Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
    createdAt: Schema.optionalKey(Schema.String),
    likes: Schema.optionalKey(Schema.Number),
    downloads: Schema.optionalKey(Schema.Number),
    tags: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const HfDailyPapers = Schema.Array(
  Schema.Struct({
    paper: Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[\w.-]+$/)),
      title: Schema.String,
      summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
      submittedOnDailyAt: Schema.optionalKey(Schema.String),
      githubRepo: Schema.optionalKey(Schema.NullOr(Schema.String)),
      submittedOnDailyBy: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ user: Schema.optionalKey(Schema.String) })),
      ),
    }),
  }),
);
const isModels = Schema.is(HfModels);
const isPapers = Schema.is(HfDailyPapers);

interface ModelEntry {
  readonly id: string;
  readonly created: number;
  readonly likes: number;
  readonly downloads: number;
  readonly tags: ReadonlyArray<string>;
  readonly observed: string;
}

export function hfModelsUrl(): string {
  const params = new URLSearchParams({
    sort: "createdAt",
    direction: "-1",
    limit: String(MODELS_PAGE),
  });
  return `${HUB}/api/models?${params}`;
}
export function hfPapersUrl(day: string, page: number): string {
  const params = new URLSearchParams({ date: day, limit: String(PAPERS_PAGE), p: String(page) });
  return `${HUB}/api/daily_papers?${params}`;
}
const readmeUrl = (id: string) =>
  `${HUB}/${id.split("/").map(encodeURIComponent).join("/")}/resolve/main/README.md`;

/**
 * The model listing has no date filter: it is walked newest first with the Hub cursor and kept
 * between days, so a range of days walks it once. Only liked models are kept in memory.
 */
function modelStream() {
  const liked = new Map<string, ModelEntry>();
  let next: string | null = hfModelsUrl();
  let oldest = Infinity;
  let pages = 0;
  return async (start: number, get: GetResponse, notes: Array<string>) => {
    while (oldest >= start && next) {
      if (++pages > MAX_MODEL_PAGES)
        throw new SourceFailure("Model listing page limit reached before the day");
      const response = await get(next);
      if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
      if (!isModels(response.body)) throw new SourceFailure("Invalid Hub model listing");
      const following = response.next ?? null;
      if (following !== null && !following.startsWith(`${HUB}/api/models?`))
        throw new SourceFailure("Unexpected Hub pagination link");
      for (const model of response.body) {
        const created = Date.parse(model.createdAt ?? "");
        if (!Number.isFinite(created)) continue;
        oldest = Math.min(oldest, created);
        if ((model.likes ?? 0) >= 1)
          liked.set(model.id, {
            id: model.id,
            created,
            likes: model.likes ?? 0,
            downloads: model.downloads ?? 0,
            tags: model.tags ?? [],
            observed: response.observed_at,
          });
      }
      next = response.body.length ? following : null;
    }
    if (oldest >= start) notes.push("model listing ended before the day start");
    return [...liked.values()];
  };
}

async function modelItems(
  day: string,
  getText: GetResponse,
  robots: RobotsGate,
  models: ReadonlyArray<ModelEntry>,
  notes: Array<string>,
): Promise<Array<Item>> {
  const start = dayStart(day);
  const chosen = models
    .filter((model) => model.created >= start && model.created < start + DAY_MS)
    .toSorted((a, b) => b.likes - a.likes || b.downloads - a.downloads || a.id.localeCompare(b.id))
    .slice(0, HF_MODELS_PER_DAY);
  let missingCards = 0;
  const items: Array<Item> = [];
  for (const model of chosen) {
    let text = "";
    let retrievedAt = model.observed;
    try {
      const url = readmeUrl(model.id);
      const refusal = await robots(url);
      if (refusal) throw new SourceFailure(refusal);
      const response = await getText(url);
      retrievedAt = response.observed_at;
      if (response.status === 200 && typeof response.body === "string")
        text = markdownText(response.body);
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      notes.push(`model card: ${error.message}`);
    }
    if (!text) {
      missingCards++;
      // No card: the pipeline and library tags still say what the model is.
      text = model.tags.filter((tag) => !tag.includes(":")).join(", ");
    }
    items.push({
      id: `itm_hf_model_${model.id}`,
      source: "huggingface",
      permalink: `${HUB}/${model.id}`,
      external_url: null,
      published_at: new Date(model.created).toISOString(),
      author: model.id.split("/")[0]!,
      title: model.id,
      ...itemBody(text),
      retrieved_at: retrievedAt,
      entities: [],
    });
  }
  notes.push(`models: selected=${chosen.length}, cards missing=${missingCards}`);
  return items;
}

async function paperItems(day: string, get: GetResponse, notes: Array<string>) {
  const start = dayStart(day);
  const items = new Map<string, Item>();
  let outside = 0;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAPER_PAGES) throw new SourceFailure("Daily Papers page limit reached");
    const response = await get(hfPapersUrl(day, page));
    if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
    if (!isPapers(response.body)) throw new SourceFailure("Invalid Daily Papers response");
    for (const { paper } of response.body) {
      const listed = Date.parse(paper.submittedOnDailyAt ?? "");
      if (!Number.isFinite(listed) || listed < start || listed >= start + DAY_MS) {
        outside++;
        continue;
      }
      const text = plainText(paper.summary ?? "");
      const id = `itm_hf_paper_${paper.id}`;
      items.set(id, {
        id,
        source: "huggingface",
        permalink: `${HUB}/papers/${paper.id}`,
        external_url: /^\d{4}\.\d{4,5}$/.test(paper.id)
          ? `https://arxiv.org/abs/${paper.id}`
          : null,
        published_at: new Date(listed).toISOString(),
        author: paper.submittedOnDailyBy?.user ?? null,
        title: plainText(paper.title),
        ...itemBody(text),
        retrieved_at: response.observed_at,
        entities: githubEntity(paper.githubRepo ?? null),
      });
    }
    if (response.body.length < PAPERS_PAGE) break;
  }
  notes.push(`papers: ${items.size}${outside ? `, outside the day=${outside}` : ""}`);
  return [...items.values()];
}

/**
 * A sample by design: models are a popularity selection, so a full day is `partial`; the day is
 * `unavailable` only when neither the model listing nor Daily Papers answered. robots.txt is
 * read before the first request of the day; a refusal of either endpoint leaves the day
 * `unavailable` without requesting data. Model cards are checked one by one.
 */
export function huggingfaceCollector(): (
  day: string,
  get: GetResponse,
  robots: RobotsGate,
  getText: GetResponse,
) => Promise<DayResult> {
  const reachBefore = modelStream();
  return async (day, get, robots, getText) => {
    const refusal = (await robots(hfModelsUrl())) ?? (await robots(hfPapersUrl(day, 0)));
    if (refusal)
      return {
        items: [],
        coverage: {
          source: "huggingface",
          day,
          status: "unavailable",
          items: 0,
          retrieved_at: new Date().toISOString(),
          note: refusal,
        },
      };
    const notes: Array<string> = [];
    const items: Array<Item> = [];
    let failures = 0;
    try {
      items.push(
        ...(await modelItems(
          day,
          getText,
          robots,
          await reachBefore(dayStart(day), get, notes),
          notes,
        )),
      );
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      failures++;
      notes.push(`models unavailable: ${error.message}`);
    }
    try {
      items.push(...(await paperItems(day, get, notes)));
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      failures++;
      notes.push(`papers unavailable: ${error.message}`);
    }
    const retrievedAt =
      items
        .map((item) => item.retrieved_at)
        .toSorted()
        .at(-1) ?? new Date().toISOString();
    return {
      items: sortItems(items),
      coverage: {
        source: "huggingface",
        day,
        status: failures === 2 ? "unavailable" : "partial",
        items: items.length,
        retrieved_at: retrievedAt,
        note: [...new Set(notes)].join("; "),
      },
    };
  };
}
