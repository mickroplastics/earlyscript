// @effect-diagnostics nodeBuiltinImport:off -- the default corpus directory is derived from the home directory, and feed ids are hashed.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { CoverageStatus, UtcDay, type SourceId } from "@earlyscript/editorial-contracts/source";
import {
  isCatalogSourceId,
  SOURCE_CATALOG,
  SOURCE_IDS,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import type { RssFeed } from "@earlyscript/editorial-contracts/source";
import { RSS_FEEDS } from "@earlyscript/trend-engine/sources";
import {
  EditorialSourcesError,
  type EditorialAddFeedInput,
  type EditorialDefaultFeedInput,
  type EditorialFeedCheck,
  type EditorialRssFeed,
  type EditorialSourceBacktest,
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

import { checkFeed, normalizeHttpUrl } from "./feedCheck.ts";
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

/** What `record-source-backtest` stores; the service stamps `recordedAt`. */
export type SourceBacktestInput = Omit<EditorialSourceBacktest, "recordedAt">;

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
  /**
   * Records the backtest that lets `source` into the engine, with what the settings show of it;
   * null withdraws it and its `rank`. Only a `not-worse` backtest unlocks `rank`, and a
   * provisional one only when the operator recorded it on purpose.
   */
  readonly recordBacktest: (
    source: SourceId,
    backtest: SourceBacktestInput | null,
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
  readonly backtest: EditorialSourceBacktest | null;
}

interface BacktestRow {
  readonly source: string;
  readonly backtest_id: string;
  readonly logical_hash: string;
  readonly experiment_at: string;
  readonly cutoff_from: string;
  readonly cutoff_to: string;
  readonly status: EditorialSourceBacktest["status"];
  readonly verdict: EditorialSourceBacktest["verdict"];
  readonly complete_cutoffs: number;
  readonly partial_cutoffs: number;
  readonly p5_baseline: number | null;
  readonly p5_candidate: number | null;
  readonly lead_baseline: number | null;
  readonly lead_candidate: number | null;
  readonly partial_p5_baseline: number | null;
  readonly partial_p5_candidate: number | null;
  readonly allow_provisional: number;
  readonly recorded_at: string;
}

const backtestOfRow = (row: BacktestRow): EditorialSourceBacktest => ({
  backtestId: row.backtest_id,
  logicalHash: row.logical_hash,
  experimentAt: row.experiment_at,
  cutoffFrom: row.cutoff_from,
  cutoffTo: row.cutoff_to,
  status: row.status,
  verdict: row.verdict,
  completeCutoffs: row.complete_cutoffs,
  partialCutoffs: row.partial_cutoffs,
  p5Baseline: row.p5_baseline,
  p5Candidate: row.p5_candidate,
  leadBaseline: row.lead_baseline,
  leadCandidate: row.lead_candidate,
  partialP5Baseline: row.partial_p5_baseline,
  partialP5Candidate: row.partial_p5_candidate,
  allowProvisional: row.allow_provisional === 1,
  recordedAt: row.recorded_at,
});

const defaultSetting = (source: SourceId): Stored => {
  const baseline = SOURCE_CATALOG[source].engineBaseline;
  return {
    collect: baseline,
    rank: baseline,
    backtestRunId: null,
    updatedAt: null,
    backtest: null,
  };
};

/**
 * A backtest admits a source only when it is recorded with its summary, its verdict is
 * not-worse, and, when provisional, the operator recorded it with --allow-provisional. An id
 * recorded before 011, without a summary, no longer admits it.
 */
const backtestAdmits = (backtest: EditorialSourceBacktest | null): boolean =>
  backtest !== null &&
  backtest.verdict === "not-worse" &&
  (backtest.status === "final" || backtest.allowProvisional);

const rankBlockOf = (source: SourceId, setting: Stored): EditorialSourceEntry["rankBlocked"] => {
  const entry = SOURCE_CATALOG[source];
  if (entry.status !== "ready") return "not-ready";
  if (entry.engineBaseline) return null;
  return setting.backtestRunId !== null && backtestAdmits(setting.backtest) ? null : "no-backtest";
};

const collectBlockOf = (source: SourceId): EditorialSourceEntry["collectBlocked"] => {
  const status = SOURCE_CATALOG[source].status;
  return status === "ready" ? null : status;
};

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
  readonly acknowledged_at: string | null;
}

/** Stable across machines, so item ids (`itm_rss_<id>_<hash>`) stay the same. */
const userFeedId = (feedUrl: string) =>
  `user-${NodeCrypto.createHash("sha256").update(feedUrl).digest("hex").slice(0, 12)}`;

const userFeedLicense = (acknowledgedAt: string | null) =>
  acknowledgedAt === null
    ? "Publisher copyright; titles and excerpts as syndicated"
    : `Publisher copyright; titles and excerpts as syndicated; the operator accepted private analysis without republication on ${acknowledgedAt.slice(0, 10)}`;

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

  const readStored = Effect.all([
    sql<SettingRow>`
      SELECT source, collect, rank, backtest_run_id, updated_at FROM editorial_source_settings
    `,
    sql<BacktestRow>`SELECT * FROM editorial_source_backtests`,
  ]).pipe(
    Effect.map(([rows, backtestRows]) => {
      const backtests = new Map(backtestRows.map((row) => [row.source, backtestOfRow(row)]));
      const stored = new Map<SourceId, Stored>();
      for (const row of rows) {
        // A row from a build with more sources stays in the table untouched.
        if (!isCatalogSourceId(row.source)) continue;
        const backtest = backtests.get(row.source) ?? null;
        stored.set(row.source, {
          collect: row.collect === 1,
          rank: row.rank === 1,
          backtestRunId: row.backtest_run_id,
          updatedAt: row.updated_at,
          // The summary counts only while it names the recorded backtest.
          backtest: backtest?.backtestId === row.backtest_run_id ? backtest : null,
        });
      }
      return stored;
    }),
    Effect.mapError(storageError),
  );

  const settingOf = (stored: ReadonlyMap<SourceId, Stored>, source: SourceId) =>
    stored.get(source) ?? defaultSetting(source);

  const effective = (source: SourceId, setting: Stored) => {
    const rankBlocked = rankBlockOf(source, setting);
    const blocked = collectBlockOf(source);
    return {
      collect: setting.collect && blocked === null,
      rank: setting.rank && rankBlocked === null,
      rankBlocked,
      collectBlocked: blocked,
    };
  };

  const readUserFeeds = sql<UserFeedRow>`
    SELECT feed_url, feed_id, name, site_url, note, added_at, acknowledged_at
    FROM editorial_rss_feeds
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
      acknowledgedAt: null,
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
      acknowledgedAt: row.acknowledged_at,
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
            license: userFeedLicense(feed.acknowledgedAt),
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
        backtest: setting.backtest,
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
    if (!isCatalogSourceId(source)) {
      return yield* new EditorialSourcesError({
        reason: "unknown-source",
        message: `No source "${source}" in the catalog.`,
      });
    }
    const current = settingOf(yield* readStored, source);
    const collectBlocked = collectBlockOf(source);
    if (input.collect === true && collectBlocked !== null) {
      return yield* new EditorialSourcesError({
        reason: "collect-blocked",
        message:
          collectBlocked === "blocked"
            ? `${SOURCE_CATALOG[source].name} is blocked by its conditions of use.`
            : `The terms of ${SOURCE_CATALOG[source].name} have not been read yet.`,
      });
    }
    const rankBlocked = rankBlockOf(source, current);
    if (input.rank === true && rankBlocked !== null) {
      return yield* new EditorialSourcesError({
        reason: "rank-blocked",
        message:
          rankBlocked === "not-ready"
            ? `${SOURCE_CATALOG[source].name} has not passed its terms review.`
            : `${SOURCE_CATALOG[source].name} has no backtest recorded that shows it does not make the ranking worse.`,
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
    input: SourceBacktestInput | null,
  ) {
    const current = settingOf(yield* readStored, source);
    const recordedAt = yield* nowIso;
    const backtest = input === null ? null : { ...input, recordedAt };
    const next: Stored = { ...current, backtestRunId: input?.backtestId ?? null, backtest };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM editorial_source_backtests WHERE source = ${source}`;
          if (backtest !== null) {
            yield* sql`
            INSERT INTO editorial_source_backtests (
              source, backtest_id, logical_hash, experiment_at, cutoff_from, cutoff_to, status,
              verdict, complete_cutoffs, partial_cutoffs, p5_baseline, p5_candidate,
              lead_baseline, lead_candidate, partial_p5_baseline, partial_p5_candidate,
              allow_provisional, recorded_at
            )
            VALUES (
              ${source}, ${backtest.backtestId}, ${backtest.logicalHash}, ${backtest.experimentAt},
              ${backtest.cutoffFrom}, ${backtest.cutoffTo}, ${backtest.status},
              ${backtest.verdict}, ${backtest.completeCutoffs}, ${backtest.partialCutoffs},
              ${backtest.p5Baseline}, ${backtest.p5Candidate}, ${backtest.leadBaseline},
              ${backtest.leadCandidate}, ${backtest.partialP5Baseline},
              ${backtest.partialP5Candidate}, ${backtest.allowProvisional ? 1 : 0},
              ${backtest.recordedAt}
            )
          `;
          }
          yield* write(source, {
            ...next,
            rank: current.rank && rankBlockOf(source, next) === null,
          });
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
  });

  const validateFeed = checkFeed;

  const addFeed = Effect.fn("EditorialSourcesService.addFeed")(function* (
    input: EditorialAddFeedInput,
  ) {
    if (input.acknowledged !== true) {
      return yield* new EditorialSourcesError({
        reason: "not-acknowledged",
        message: "Adding a feed needs the operator's acceptance of private, non-republished use.",
      });
    }
    const normalized = normalizeHttpUrl(input.feedUrl);
    const givenSite = input.siteUrl?.trim() || null;
    const siteUrl = givenSite === null ? null : normalizeHttpUrl(givenSite);
    if (givenSite !== null && siteUrl === null) {
      return yield* new EditorialSourcesError({
        reason: "invalid-url",
        message: `The site URL is not an http or https URL: ${givenSite}`,
      });
    }
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
      INSERT INTO editorial_rss_feeds (
        feed_url, feed_id, name, site_url, note, added_at, acknowledged_at
      )
      VALUES (
        ${check.feedUrl}, ${userFeedId(check.feedUrl)}, ${name}, ${siteUrl ?? check.siteUrl},
        ${note}, ${addedAt}, ${addedAt}
      )
    `.pipe(Effect.mapError(storageError));
    return yield* list;
  });

  const removeFeed = Effect.fn("EditorialSourcesService.removeFeed")(function* (feedUrl: string) {
    const removed = yield* sql<{ readonly feed_url: string }>`
      DELETE FROM editorial_rss_feeds WHERE feed_url = ${normalizeHttpUrl(feedUrl) ?? feedUrl}
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
);

export const layerWithCorpusDir = (corpusDir: string) =>
  Layer.effect(EditorialSourcesService, makeWithCorpusDir(corpusDir));
