// @effect-diagnostics nodeBuiltinImport:off -- the default corpus directory is derived from the home directory, and feed ids are hashed.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { CoverageStatus, SourceId, UtcDay } from "@earlyscript/editorial-contracts/source";
import { SOURCE_CATALOG, SOURCE_IDS } from "@earlyscript/editorial-contracts/sourceCatalog";
import { RSS_FEEDS, type RssFeed } from "@earlyscript/trend-engine/sources/rss-feeds";
import {
  EditorialSourcesError,
  type EditorialAddFeedInput,
  type EditorialDefaultFeedInput,
  type EditorialFeedCheck,
  type EditorialRssFeed,
  type EditorialSourceEntry,
  type EditorialSourcesCorpus,
  type EditorialSourcesUpdateInput,
  type EditorialSourcesView,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkFeed, EditorialFeedFetcher, layerFetch, normalizeFeedUrl } from "./feedCheck.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { nowIso } from "./persistence/support.ts";
import { summarizeSourceCoverage, type CoverageRow } from "./sourceCoverage.ts";

const EDITORIAL_CORPUS_DIR_ENV = "EARLYSCRIPT_EDITORIAL_CORPUS_DIR";
const MANIFEST_FILE = "corpus-manifest.json";
const COVERAGE_FILE = "coverage.jsonl";

export interface EnabledSources {
  readonly collect: ReadonlyArray<SourceId>;
  readonly rank: ReadonlyArray<SourceId>;
  /** The `rss` source's feeds: the default ones not excluded, then the operator's. */
  readonly rssFeeds: ReadonlyArray<RssFeed>;
}

export interface EditorialSourcesServiceShape {
  readonly corpusDir: string;
  readonly list: Effect.Effect<EditorialSourcesView, EditorialSourcesError>;
  readonly update: (
    input: EditorialSourcesUpdateInput,
  ) => Effect.Effect<EditorialSourcesView, EditorialSourcesError>;
  /**
   * What a capture collects and what a run ranks with, in catalog order. The engine CLI keeps
   * its `--sources`; the server passes these when it launches a capture or a run.
   */
  readonly enabledSources: Effect.Effect<EnabledSources, EditorialSourcesError>;
  /** Default feeds not excluded plus the operator's, in the engine's `RssFeed` shape. */
  readonly rssFeeds: Effect.Effect<ReadonlyArray<RssFeed>, EditorialSourcesError>;
  readonly validateFeed: (
    feedUrl: string,
  ) => Effect.Effect<EditorialFeedCheck, EditorialSourcesError>;
  readonly addFeed: (
    input: EditorialAddFeedInput,
  ) => Effect.Effect<EditorialSourcesView, EditorialSourcesError>;
  readonly removeFeed: (
    feedUrl: string,
  ) => Effect.Effect<EditorialSourcesView, EditorialSourcesError>;
  readonly setDefaultFeedExcluded: (
    input: EditorialDefaultFeedInput,
  ) => Effect.Effect<EditorialSourcesView, EditorialSourcesError>;
  /** Names the backtest that lets `source` into the engine; null withdraws it and its `rank`. */
  readonly recordBacktest: (
    source: SourceId,
    runId: string | null,
  ) => Effect.Effect<void, EditorialSourcesError>;
}

/** Per source capture and engine switches over `editorial.sqlite`, and the corpus's coverage. */
export class EditorialSourcesService extends Context.Service<
  EditorialSourcesService,
  EditorialSourcesServiceShape
>()("t3/editorial/EditorialSourcesService") {}

interface SettingRow {
  readonly source: string;
  readonly collect: number;
  readonly rank: number;
  readonly backtest_run_id: string | null;
  readonly updated_at: string;
}

interface Stored {
  readonly collect: boolean;
  readonly rank: boolean;
  readonly backtestRunId: string | null;
  readonly updatedAt: string | null;
}

const defaultSetting = (source: SourceId): Stored => {
  const baseline = SOURCE_CATALOG[source].engineBaseline;
  return { collect: baseline, rank: baseline, backtestRunId: null, updatedAt: null };
};

const rankBlockOf = (
  source: SourceId,
  backtestRunId: string | null,
): EditorialSourceEntry["rankBlocked"] => {
  const entry = SOURCE_CATALOG[source];
  if (entry.status !== "ready") return "not-ready";
  return entry.engineBaseline || backtestRunId !== null ? null : "no-backtest";
};

const collectBlocked = (source: SourceId) => SOURCE_CATALOG[source].status === "blocked";

const isSourceId = Schema.is(SourceId);

const CorpusManifestHead = Schema.Struct({
  schema_version: Schema.Literal("corpus/1"),
  from_day: UtcDay,
  to_day: UtcDay,
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(CorpusManifestHead));

const CoverageLine = Schema.Struct({
  source: Schema.String,
  day: UtcDay,
  status: CoverageStatus,
  items: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  retrieved_at: Schema.String,
  note: Schema.NullOr(Schema.String),
});
const decodeCoverageLine = Schema.decodeUnknownEffect(Schema.fromJsonString(CoverageLine));

interface UserFeedRow {
  readonly feed_url: string;
  readonly feed_id: string;
  readonly name: string;
  readonly site_url: string | null;
  readonly note: string | null;
  readonly added_at: string;
}

/** Stable across machines, so item ids (`itm_rss_<id>_<hash>`) stay the same. */
const userFeedId = (feedUrl: string) =>
  `user-${NodeCrypto.createHash("sha256").update(feedUrl).digest("hex").slice(0, 12)}`;

const USER_FEED_LICENSE = "Not verified; publisher copyright assumed (added by the operator)";

interface CorpusRead {
  readonly corpus: EditorialSourcesCorpus;
  readonly rows: ReadonlyArray<CoverageRow>;
}

const storageError = (cause: unknown) =>
  new EditorialSourcesError({
    reason: "storage",
    message: `The source settings could not be read or written: ${String(cause)}`,
  });

const makeWithCorpusDir = Effect.fn("EditorialSourcesService.make")(function* (corpusDir: string) {
  const sql = yield* EditorialSql;
  const fetcher = yield* EditorialFeedFetcher;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readCorpus: Effect.Effect<CorpusRead> = Effect.gen(function* () {
    const missing = {
      corpus: {
        status: "missing",
        directory: corpusDir,
        fromDay: null,
        toDay: null,
        message: null,
      },
      rows: [],
    } satisfies CorpusRead;
    const manifestPath = path.join(corpusDir, MANIFEST_FILE);
    const exists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return missing;
    const manifest = yield* fs.readFileString(manifestPath).pipe(Effect.flatMap(decodeManifest));
    const coveragePath = path.join(corpusDir, COVERAGE_FILE);
    const hasCoverage = yield* fs.exists(coveragePath).pipe(Effect.orElseSucceed(() => false));
    const text = hasCoverage ? yield* fs.readFileString(coveragePath) : "";
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const rows = yield* Effect.forEach(lines, (line) => decodeCoverageLine(line));
    return {
      corpus: {
        status: "ready",
        directory: corpusDir,
        fromDay: manifest.from_day,
        toDay: manifest.to_day,
        message: null,
      },
      rows,
    } satisfies CorpusRead;
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        corpus: {
          status: "unreadable",
          directory: corpusDir,
          fromDay: null,
          toDay: null,
          message: String(cause),
        },
        rows: [],
      } satisfies CorpusRead),
    ),
  );

  const readStored = sql<SettingRow>`
    SELECT source, collect, rank, backtest_run_id, updated_at FROM editorial_source_settings
  `.pipe(
    Effect.map((rows) => {
      const stored = new Map<SourceId, Stored>();
      for (const row of rows) {
        // A row from a build with more sources stays in the table untouched.
        if (!isSourceId(row.source)) continue;
        stored.set(row.source, {
          collect: row.collect === 1,
          rank: row.rank === 1,
          backtestRunId: row.backtest_run_id,
          updatedAt: row.updated_at,
        });
      }
      return stored;
    }),
    Effect.mapError(storageError),
  );

  const settingOf = (stored: ReadonlyMap<SourceId, Stored>, source: SourceId) =>
    stored.get(source) ?? defaultSetting(source);

  const effective = (source: SourceId, setting: Stored) => {
    const rankBlocked = rankBlockOf(source, setting.backtestRunId);
    const blocked = collectBlocked(source);
    return {
      collect: setting.collect && !blocked,
      rank: setting.rank && rankBlocked === null,
      rankBlocked,
      collectBlocked: blocked,
    };
  };

  const readUserFeeds = sql<UserFeedRow>`
    SELECT feed_url, feed_id, name, site_url, note, added_at FROM editorial_rss_feeds
    ORDER BY added_at, feed_url
  `.pipe(Effect.mapError(storageError));

  const readExcluded = sql<{ readonly feed_id: string }>`
    SELECT feed_id FROM editorial_rss_default_exclusions
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.feed_id))),
    Effect.mapError(storageError),
  );

  const readFeeds = Effect.gen(function* () {
    const [user, excluded] = yield* Effect.all([readUserFeeds, readExcluded]);
    const defaults = RSS_FEEDS.map((feed): EditorialRssFeed => ({
      id: feed.id,
      name: feed.name,
      feedUrl: feed.feedUrl,
      siteUrl: feed.siteUrl,
      note: feed.license,
      origin: "default",
      excluded: excluded.has(feed.id),
      addedAt: null,
    }));
    const added = user.map((row): EditorialRssFeed => ({
      id: row.feed_id,
      name: row.name,
      feedUrl: row.feed_url,
      siteUrl: row.site_url,
      note: row.note,
      origin: "user",
      excluded: false,
      addedAt: row.added_at,
    }));
    return [...defaults, ...added];
  });

  const rssFeeds = readFeeds.pipe(
    Effect.map((feeds) =>
      feeds
        .filter((feed) => !feed.excluded)
        .map((feed): RssFeed => {
          const known = RSS_FEEDS.find((entry) => entry.id === feed.id);
          if (feed.origin === "default" && known) return known;
          return {
            id: feed.id,
            name: feed.name,
            feedUrl: feed.feedUrl,
            siteUrl: feed.siteUrl ?? `${new URL(feed.feedUrl).origin}/`,
            license: USER_FEED_LICENSE,
            why: feed.note ?? "Added by the operator in Settings.",
          };
        }),
    ),
    Effect.withSpan("EditorialSourcesService.rssFeeds"),
  );

  const list = Effect.gen(function* () {
    const [stored, corpus, feeds, asOf] = yield* Effect.all([
      readStored,
      readCorpus,
      readFeeds,
      nowIso,
    ]);
    const sources = SOURCE_IDS.map((source): EditorialSourceEntry => {
      const setting = settingOf(stored, source);
      const coverage =
        corpus.corpus.toDay === null
          ? { lastCapture: null, recentGaps: [] }
          : summarizeSourceCoverage(source, corpus.rows, corpus.corpus.toDay);
      return {
        source,
        ...effective(source, setting),
        backtestRunId: setting.backtestRunId,
        updatedAt: setting.updatedAt,
        ...coverage,
      };
    });
    return { corpus: corpus.corpus, sources, rssFeeds: feeds, asOf } satisfies EditorialSourcesView;
  }).pipe(Effect.withSpan("EditorialSourcesService.list"));

  const write = Effect.fn("EditorialSourcesService.write")(function* (
    source: SourceId,
    next: Stored,
  ) {
    const updatedAt = yield* nowIso;
    yield* sql`
      INSERT INTO editorial_source_settings (source, collect, rank, backtest_run_id, updated_at)
      VALUES (
        ${source}, ${next.collect ? 1 : 0}, ${next.rank ? 1 : 0}, ${next.backtestRunId},
        ${updatedAt}
      )
      ON CONFLICT (source) DO UPDATE SET
        collect = excluded.collect,
        rank = excluded.rank,
        backtest_run_id = excluded.backtest_run_id,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(storageError));
  });

  const update = Effect.fn("EditorialSourcesService.update")(function* (
    input: EditorialSourcesUpdateInput,
  ) {
    const source = input.source;
    if (!isSourceId(source)) {
      return yield* new EditorialSourcesError({
        reason: "unknown-source",
        message: `No source "${source}" in the catalog.`,
      });
    }
    const current = settingOf(yield* readStored, source);
    if (input.collect === true && collectBlocked(source)) {
      return yield* new EditorialSourcesError({
        reason: "collect-blocked",
        message: `${SOURCE_CATALOG[source].name} is blocked by its conditions of use.`,
      });
    }
    const rankBlocked = rankBlockOf(source, current.backtestRunId);
    if (input.rank === true && rankBlocked !== null) {
      return yield* new EditorialSourcesError({
        reason: "rank-blocked",
        message:
          rankBlocked === "not-ready"
            ? `${SOURCE_CATALOG[source].name} has not passed its terms review.`
            : `${SOURCE_CATALOG[source].name} has no backtest recorded.`,
      });
    }
    // The effective values are the base, so a stored flag the source no longer allows drops out.
    const base = effective(source, current);
    yield* write(source, {
      ...current,
      collect: input.collect ?? base.collect,
      rank: input.rank ?? base.rank,
    });
    return yield* list;
  });

  const enabledSources = Effect.all([readStored, rssFeeds]).pipe(
    Effect.map(([stored, feeds]) => {
      const values = SOURCE_IDS.map((source) => ({
        source,
        ...effective(source, settingOf(stored, source)),
      }));
      return {
        collect: values.filter((value) => value.collect).map((value) => value.source),
        rank: values.filter((value) => value.rank).map((value) => value.source),
        rssFeeds: feeds,
      } satisfies EnabledSources;
    }),
    Effect.withSpan("EditorialSourcesService.enabledSources"),
  );

  const recordBacktest = Effect.fn("EditorialSourcesService.recordBacktest")(function* (
    source: SourceId,
    runId: string | null,
  ) {
    const current = settingOf(yield* readStored, source);
    yield* write(source, {
      ...current,
      backtestRunId: runId,
      rank: current.rank && rankBlockOf(source, runId) === null,
    });
  });

  const validateFeed = (feedUrl: string) =>
    checkFeed(feedUrl).pipe(Effect.provideService(EditorialFeedFetcher, fetcher));

  const addFeed = Effect.fn("EditorialSourcesService.addFeed")(function* (
    input: EditorialAddFeedInput,
  ) {
    const normalized = normalizeFeedUrl(input.feedUrl);
    const feeds = yield* readFeeds;
    if (normalized !== null && feeds.some((feed) => feed.feedUrl === normalized)) {
      return yield* new EditorialSourcesError({
        reason: "duplicate-feed",
        message: `${normalized} is already in the list.`,
      });
    }
    const check = yield* validateFeed(input.feedUrl);
    const name =
      input.name?.trim() || check.title || new URL(check.feedUrl).hostname.replace(/^www\./, "");
    const note = input.note?.trim() || null;
    const addedAt = yield* nowIso;
    yield* sql`
      INSERT INTO editorial_rss_feeds (feed_url, feed_id, name, site_url, note, added_at)
      VALUES (
        ${check.feedUrl}, ${userFeedId(check.feedUrl)}, ${name}, ${check.siteUrl}, ${note},
        ${addedAt}
      )
    `.pipe(Effect.mapError(storageError));
    return yield* list;
  });

  const removeFeed = Effect.fn("EditorialSourcesService.removeFeed")(function* (feedUrl: string) {
    const removed = yield* sql<{ readonly feed_url: string }>`
      DELETE FROM editorial_rss_feeds WHERE feed_url = ${normalizeFeedUrl(feedUrl) ?? feedUrl}
      RETURNING feed_url
    `.pipe(Effect.mapError(storageError));
    if (removed.length === 0) {
      return yield* new EditorialSourcesError({
        reason: "unknown-feed",
        message: `${feedUrl} is not a feed the operator added.`,
      });
    }
    return yield* list;
  });

  const setDefaultFeedExcluded = Effect.fn("EditorialSourcesService.setDefaultFeedExcluded")(
    function* (input: EditorialDefaultFeedInput) {
      if (!RSS_FEEDS.some((feed) => feed.id === input.id)) {
        return yield* new EditorialSourcesError({
          reason: "unknown-feed",
          message: `No default feed "${input.id}".`,
        });
      }
      const excludedAt = yield* nowIso;
      yield* (
        input.excluded
          ? sql`
              INSERT INTO editorial_rss_default_exclusions (feed_id, excluded_at)
              VALUES (${input.id}, ${excludedAt})
              ON CONFLICT (feed_id) DO NOTHING
            `
          : sql`DELETE FROM editorial_rss_default_exclusions WHERE feed_id = ${input.id}`
      ).pipe(Effect.mapError(storageError));
      return yield* list;
    },
  );

  return EditorialSourcesService.of({
    corpusDir,
    list,
    update,
    enabledSources,
    rssFeeds,
    validateFeed,
    addFeed,
    removeFeed,
    setDefaultFeedExcluded,
    recordBacktest,
  });
});

/** `EARLYSCRIPT_EDITORIAL_CORPUS_DIR`, or `~/earlyscript-data/live`, where captures write. */
const resolveCorpusDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.String(EDITORIAL_CORPUS_DIR_ENV).pipe(Config.option);
  return Option.match(configured, {
    onNone: () => path.join(NodeOS.homedir(), "earlyscript-data", "live"),
    onSome: (dir) => path.resolve(dir),
  });
});

export const layer = Layer.effect(
  EditorialSourcesService,
  resolveCorpusDir.pipe(Effect.orDie, Effect.flatMap(makeWithCorpusDir)),
).pipe(Layer.provide(layerFetch));

export const layerWithCorpusDir = (corpusDir: string) =>
  Layer.effect(EditorialSourcesService, makeWithCorpusDir(corpusDir));
