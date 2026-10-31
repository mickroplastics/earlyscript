// @effect-diagnostics nodeBuiltinImport:off - the tests write a corpus/1 fixture to a temp directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EDITORIAL_SOURCES_WS_METHODS,
  EditorialSourcesRpcGroup,
  RpcScopeAuthorization,
  type EditorialSourceEntry,
  type EditorialSourcesView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import type * as Scope from "effect/Scope";

import { RSS_FEEDS } from "@earlyscript/trend-engine/sources/rss-feeds";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as EditorialSourcesService from "./EditorialSourcesService.ts";
import { EditorialFeedFetcher, FEED_USER_AGENT, type FetchedPage } from "./feedCheck.ts";
import { makeTempDir, withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";
import { summarizeSourceCoverage, type CoverageRow } from "./sourceCoverage.ts";
import * as EditorialSourcesRpc from "./sourcesRpc.ts";

const group = EditorialSourcesRpcGroup.middleware(RpcScopeAuthorization);

const row = (
  source: string,
  day: string,
  status: CoverageRow["status"],
  items: number,
): CoverageRow => ({
  source,
  day,
  status,
  items,
  retrieved_at: `${day}T23:00:00.000Z`,
  note: null,
});

/** A corpus/1 directory with only the files the settings read: manifest and coverage. */
const writeCorpus = (rows: ReadonlyArray<CoverageRow>, fromDay: string, toDay: string) => {
  const dir = makeTempDir();
  NodeFS.writeFileSync(
    NodePath.join(dir, "corpus-manifest.json"),
    JSON.stringify({ schema_version: "corpus/1", from_day: fromDay, to_day: toDay, files: [] }),
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "coverage.jsonl"),
    rows.map((entry) => JSON.stringify(entry) + "\n").join(""),
  );
  return dir;
};

const CORPUS_ROWS = [
  ...["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-28", "2026-10-29"].map((day) =>
    row("hn", day, "complete", 1000),
  ),
  row("hn", "2026-10-30", "rate_limited", 412),
  ...["2026-10-28", "2026-10-29", "2026-10-30"].map((day) => row("github", day, "partial", 12)),
  row("arxiv", "2026-10-30", "partial", 300),
  // A source a later build knows: read past, never shown.
  row("youtube", "2026-10-30", "complete", 5),
];

/** A web of canned answers; a URL it does not hold does not answer. Records every request. */
const fetcherOf = (pages: Readonly<Record<string, FetchedPage>>, requests: Array<string> = []) =>
  Layer.succeed(
    EditorialFeedFetcher,
    EditorialFeedFetcher.of({
      get: (url) => {
        requests.push(url);
        const page = pages[url];
        return page ? Effect.succeed(page) : Effect.fail("connection refused");
      },
    }),
  );

/** The body runs with the Sources handlers over a fresh database and `corpusDir`. */
const withSources = <A, E>(
  corpusDir: string,
  body: Effect.Effect<A, E, EditorialSourcesService.EditorialSourcesService | Scope.Scope>,
  web: Layer.Layer<EditorialFeedFetcher> = fetcherOf({}),
) => {
  const service = EditorialSourcesService.layerWithCorpusDir(corpusDir).pipe(Layer.provide(web));
  const handlers = Layer.effect(
    EditorialSourcesRpc.EditorialSourcesRpcHandlers,
    EditorialSourcesRpc.makeHandlers,
  ).pipe(Layer.provideMerge(service));
  return withEditorialDatabase(
    body.pipe(Effect.provide(handlers.pipe(Layer.provide(NodeServices.layer)))),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(corpusDir, { recursive: true }))));
};

const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const handlers = yield* EditorialSourcesRpc.EditorialSourcesRpcHandlers;
    return yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(group.toLayer(handlers), RpcAuthorization.layer(scopes))),
    );
  });

const operator = clientWith([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
const reader = clientWith([AuthOrchestrationReadScope]);

const entryOf = (view: EditorialSourcesView, source: string): EditorialSourceEntry =>
  view.sources.find((entry) => entry.source === source)!;

const reasonOf = (error: { readonly _tag: string }) =>
  "reason" in error ? (error as { readonly reason: string }).reason : error._tag;

describe("editorial sources RPC", () => {
  it("reads with orchestration:read and writes with orchestration:operate", () => {
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_SOURCES_WS_METHODS.list),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      RpcAuthorization.requiredScopeForRpcMethod(EDITORIAL_SOURCES_WS_METHODS.update),
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("starts from the catalog defaults: the engine baseline on, the rest off", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const client = yield* operator;
        const view = yield* client[EDITORIAL_SOURCES_WS_METHODS.list]({});
        assert.deepStrictEqual(
          view.sources.filter((entry) => entry.collect).map((entry) => entry.source),
          ["hn", "github"],
        );
        assert.deepStrictEqual(
          view.sources.filter((entry) => entry.rank).map((entry) => entry.source),
          ["hn", "github"],
        );
        assert.strictEqual(entryOf(view, "hn").rankBlocked, null);
        assert.strictEqual(entryOf(view, "arxiv").rankBlocked, "no-backtest");
        assert.strictEqual(entryOf(view, "wikipedia").rankBlocked, "not-ready");
        assert.isTrue(entryOf(view, "bluesky").collectBlocked);
        assert.strictEqual(entryOf(view, "hn").updatedAt, null);
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("writes the capture switch and refuses the engine switch without a backtest", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const client = yield* operator;
        const update = client[EDITORIAL_SOURCES_WS_METHODS.update];
        const view = yield* update({ source: "arxiv", collect: true });
        assert.isTrue(entryOf(view, "arxiv").collect);
        assert.isFalse(entryOf(view, "arxiv").rank);
        assert.isNotNull(entryOf(view, "arxiv").updatedAt);

        const refused = yield* Effect.flip(update({ source: "arxiv", rank: true }));
        assert.strictEqual(reasonOf(refused), "rank-blocked");
        const notReady = yield* Effect.flip(update({ source: "wikipedia", rank: true }));
        assert.strictEqual(reasonOf(notReady), "rank-blocked");
        const blocked = yield* Effect.flip(update({ source: "bluesky", collect: true }));
        assert.strictEqual(reasonOf(blocked), "collect-blocked");
        const unknown = yield* Effect.flip(update({ source: "youtube", collect: true }));
        assert.strictEqual(reasonOf(unknown), "unknown-source");

        const off = yield* update({ source: "github", collect: false, rank: false });
        assert.isFalse(entryOf(off, "github").collect);
        assert.isFalse(entryOf(off, "github").rank);
        const again = yield* client[EDITORIAL_SOURCES_WS_METHODS.list]({});
        assert.isFalse(entryOf(again, "github").rank);

        const sources = yield* EditorialSourcesService.EditorialSourcesService;
        const enabled = yield* sources.enabledSources;
        assert.deepStrictEqual(enabled.collect, ["hn", "arxiv"]);
        assert.deepStrictEqual(enabled.rank, ["hn"]);
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("lets a source into the engine once its backtest is recorded, and out without it", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const sources = yield* EditorialSourcesService.EditorialSourcesService;
        const client = yield* operator;
        const update = client[EDITORIAL_SOURCES_WS_METHODS.update];
        yield* sources.recordBacktest("arxiv", "backtest_20261031_arxiv");
        const view = yield* update({ source: "arxiv", collect: true, rank: true });
        assert.isTrue(entryOf(view, "arxiv").rank);
        assert.strictEqual(entryOf(view, "arxiv").backtestRunId, "backtest_20261031_arxiv");
        assert.strictEqual(entryOf(view, "arxiv").rankBlocked, null);

        yield* sources.recordBacktest("arxiv", null);
        const withdrawn = yield* client[EDITORIAL_SOURCES_WS_METHODS.list]({});
        assert.isFalse(entryOf(withdrawn, "arxiv").rank);
        assert.strictEqual(entryOf(withdrawn, "arxiv").rankBlocked, "no-backtest");
        assert.deepStrictEqual((yield* sources.enabledSources).rank, ["hn", "github"]);
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("refuses a write from a read-only session", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const client = yield* reader;
        const error = yield* Effect.flip(
          client[EDITORIAL_SOURCES_WS_METHODS.update]({ source: "arxiv", collect: true }),
        );
        assert.strictEqual(error._tag, "EnvironmentAuthorizationError");
        const view = yield* client[EDITORIAL_SOURCES_WS_METHODS.list]({});
        assert.isFalse(entryOf(view, "arxiv").collect);
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("reads the last capture of each source from the corpus coverage", () =>
    withSources(
      writeCorpus(CORPUS_ROWS, "2026-10-24", "2026-10-31"),
      Effect.gen(function* () {
        const client = yield* operator;
        const view = yield* client[EDITORIAL_SOURCES_WS_METHODS.list]({});
        assert.strictEqual(view.corpus.status, "ready");
        assert.strictEqual(view.corpus.toDay, "2026-10-31");
        assert.deepStrictEqual(entryOf(view, "hn").lastCapture, {
          day: "2026-10-30",
          status: "rate_limited",
          items: 412,
          retrievedAt: "2026-10-30T23:00:00.000Z",
          note: null,
        });
        assert.deepStrictEqual(entryOf(view, "hn").recentGaps, [
          { day: "2026-10-27", reason: "not_collected" },
          { day: "2026-10-30", reason: "rate_limited" },
        ]);
        // A sample source's partial day is its full collection.
        assert.deepStrictEqual(entryOf(view, "github").recentGaps, []);
        assert.strictEqual(entryOf(view, "github").lastCapture?.items, 12);
        assert.strictEqual(entryOf(view, "arxiv").lastCapture?.status, "partial");
        assert.deepStrictEqual(entryOf(view, "arxiv").recentGaps, [
          { day: "2026-10-30", reason: "partial" },
        ]);
        assert.isNull(entryOf(view, "wikipedia").lastCapture);
        assert.isFalse(view.sources.some((entry) => entry.source === "youtube"));
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("reports a missing or unreadable corpus without inventing captures", () =>
    Effect.gen(function* () {
      const empty = yield* withSources(
        makeTempDir(),
        Effect.gen(function* () {
          return yield* (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.list]({});
        }),
      ).pipe(Effect.scoped);
      assert.strictEqual(empty.corpus.status, "missing");
      assert.isTrue(empty.sources.every((entry) => entry.lastCapture === null));

      const broken = writeCorpus([], "2026-10-24", "2026-10-31");
      NodeFS.appendFileSync(NodePath.join(broken, "coverage.jsonl"), "{not json\n");
      const unreadable = yield* withSources(
        broken,
        Effect.gen(function* () {
          return yield* (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.list]({});
        }),
      ).pipe(Effect.scoped);
      assert.strictEqual(unreadable.corpus.status, "unreadable");
      assert.isNotNull(unreadable.corpus.message);
      assert.isTrue(unreadable.sources.every((entry) => entry.lastCapture === null));
    }),
  );
});

describe("source coverage summary", () => {
  it("does not count days before the source's first capture as gaps", () => {
    const summary = summarizeSourceCoverage(
      "hn",
      [row("hn", "2026-10-29", "complete", 10), row("hn", "2026-10-30", "complete", 11)],
      "2026-10-31",
    );
    assert.deepStrictEqual(summary.recentGaps, []);
    assert.strictEqual(summary.lastCapture?.day, "2026-10-30");
  });
});

const RSS_DOC = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Engineering</title><link>https://blog.example.com/</link>
  <item><title>One</title><link>https://blog.example.com/1</link>
    <pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate></item>
  <item><title>Two</title><link>https://blog.example.com/2</link>
    <pubDate>Thu, 30 Oct 2026 08:30:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM_DOC = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Notes</title>
  <link rel="alternate" href="https://notes.example.org/"/>
  <entry><title>A</title><updated>2026-10-31T09:00:00Z</updated></entry>
</feed>`;

const ok = (body: string): FetchedPage => ({ status: 200, body });
const FEED = "https://blog.example.com/feed.xml";
const WEB = {
  "https://blog.example.com/robots.txt": ok("User-agent: *\nDisallow: /private/\n"),
  [FEED]: ok(RSS_DOC),
  "https://blog.example.com/page": ok("<!doctype html><html><body>Hi</body></html>"),
  "https://blog.example.com/private/feed.xml": ok(RSS_DOC),
  "https://notes.example.org/robots.txt": { status: 404, body: "" },
  "https://notes.example.org/atom": ok(ATOM_DOC),
  "https://down.example.net/robots.txt": { status: 404, body: "" },
};

describe("editorial RSS feeds", () => {
  it("names the engine's collector in every request", () => {
    assert.match(FEED_USER_AGENT, /^Earlyscript\//);
  });

  it.effect("validates RSS and Atom feeds and reports their entries and latest date", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const validate = (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.validateFeed];
        const rss = yield* validate({ feedUrl: FEED });
        assert.strictEqual(rss.format, "rss");
        assert.strictEqual(rss.title, "Example Engineering");
        assert.strictEqual(rss.siteUrl, "https://blog.example.com/");
        assert.strictEqual(rss.entries, 2);
        assert.strictEqual(rss.latestAt, "2026-10-30T08:30:00.000Z");
        const atom = yield* validate({ feedUrl: "https://notes.example.org/atom" });
        assert.strictEqual(atom.format, "atom");
        assert.strictEqual(atom.entries, 1);
        assert.strictEqual(atom.latestAt, "2026-10-31T09:00:00.000Z");
      }),
      fetcherOf(WEB),
    ).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a page that is not a feed, a path robots.txt disallows and a dead host",
    () => {
      const requests: Array<string> = [];
      return withSources(
        makeTempDir(),
        Effect.gen(function* () {
          const validate = (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.validateFeed];
          const html = yield* Effect.flip(validate({ feedUrl: "https://blog.example.com/page" }));
          assert.strictEqual(reasonOf(html), "not-a-feed");
          const robots = yield* Effect.flip(
            validate({ feedUrl: "https://blog.example.com/private/feed.xml" }),
          );
          assert.strictEqual(reasonOf(robots), "robots-disallowed");
          // robots.txt is read first: a disallowed feed is never downloaded.
          assert.notInclude(requests, "https://blog.example.com/private/feed.xml");
          const down = yield* Effect.flip(validate({ feedUrl: "https://down.example.net/rss" }));
          assert.strictEqual(reasonOf(down), "unreachable");
          const noRobots = yield* Effect.flip(validate({ feedUrl: "https://nobody.example/rss" }));
          assert.strictEqual(reasonOf(noRobots), "robots-unavailable");
          const bad = yield* Effect.flip(validate({ feedUrl: "ftp://blog.example.com/feed" }));
          assert.strictEqual(reasonOf(bad), "invalid-url");
        }),
        fetcherOf(WEB, requests),
      ).pipe(Effect.scoped);
    },
  );

  it.effect("adds, lists, excludes and removes feeds, and hands the engine the result", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const client = yield* operator;
        const sources = yield* EditorialSourcesService.EditorialSourcesService;
        const added = yield* client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({ feedUrl: FEED });
        const mine = added.rssFeeds.filter((feed) => feed.origin === "user");
        assert.strictEqual(mine.length, 1);
        assert.strictEqual(mine[0]!.name, "Example Engineering");
        assert.strictEqual(mine[0]!.siteUrl, "https://blog.example.com/");
        assert.match(mine[0]!.id, /^user-[0-9a-f]{12}$/);
        assert.strictEqual(
          added.rssFeeds.filter((feed) => feed.origin === "default").length,
          RSS_FEEDS.length,
        );

        const named = yield* client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({
          feedUrl: "https://notes.example.org/atom",
          name: "Mis notas",
          note: "Probando",
        });
        assert.strictEqual(named.rssFeeds.at(-1)!.name, "Mis notas");
        assert.strictEqual(named.rssFeeds.at(-1)!.note, "Probando");
        const duplicate = yield* Effect.flip(
          client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({ feedUrl: FEED }),
        );
        assert.strictEqual(reasonOf(duplicate), "duplicate-feed");
        const refused = yield* Effect.flip(
          client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({
            feedUrl: "https://blog.example.com/page",
          }),
        );
        assert.strictEqual(reasonOf(refused), "not-a-feed");

        const first = RSS_FEEDS[0]!;
        yield* client[EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded]({
          id: first.id,
          excluded: true,
        });
        const engine = (yield* sources.enabledSources).rssFeeds;
        assert.notInclude(
          engine.map((feed) => feed.id),
          first.id,
        );
        assert.strictEqual(engine.length, RSS_FEEDS.length - 1 + 2);
        assert.strictEqual(engine.at(-2)!.feedUrl, FEED);
        assert.strictEqual(engine.at(-1)!.why, "Probando");

        const removed = yield* client[EDITORIAL_SOURCES_WS_METHODS.removeFeed]({ feedUrl: FEED });
        assert.isFalse(removed.rssFeeds.some((feed) => feed.feedUrl === FEED));
        const again = yield* Effect.flip(
          client[EDITORIAL_SOURCES_WS_METHODS.removeFeed]({ feedUrl: FEED }),
        );
        assert.strictEqual(reasonOf(again), "unknown-feed");
        const restored = yield* client[EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded]({
          id: first.id,
          excluded: false,
        });
        assert.isFalse(restored.rssFeeds[0]!.excluded);
        assert.strictEqual((yield* sources.rssFeeds).length, RSS_FEEDS.length + 1);
      }),
      fetcherOf(WEB),
    ).pipe(Effect.scoped),
  );

  it.effect("refuses feed changes from a read-only session", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const client = yield* reader;
        const error = yield* Effect.flip(
          client[EDITORIAL_SOURCES_WS_METHODS.validateFeed]({ feedUrl: FEED }),
        );
        assert.strictEqual(error._tag, "EnvironmentAuthorizationError");
      }),
      fetcherOf(WEB),
    ).pipe(Effect.scoped),
  );
});
