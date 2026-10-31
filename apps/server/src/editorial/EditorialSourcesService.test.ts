// @effect-diagnostics nodeBuiltinImport:off - the tests write a corpus/1 fixture and serve feeds over local HTTP.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
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

import { RSS_FEEDS } from "@earlyscript/trend-engine/sources";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as EditorialSourcesService from "./EditorialSourcesService.ts";
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

/** The body runs with the Sources handlers over a fresh database and `corpusDir`. */
const withSources = <A, E>(
  corpusDir: string,
  body: Effect.Effect<A, E, EditorialSourcesService.EditorialSourcesService | Scope.Scope>,
) => {
  const service = EditorialSourcesService.layerWithCorpusDir(corpusDir);
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
        assert.strictEqual(entryOf(view, "wikipedia").rankBlocked, "no-backtest");
        assert.strictEqual(entryOf(view, "stackexchange").rankBlocked, "not-ready");
        assert.strictEqual(entryOf(view, "lobsters").collectBlocked, "blocked");
        assert.strictEqual(entryOf(view, "bluesky").collectBlocked, "pending-review");
        assert.strictEqual(entryOf(view, "stackexchange").collectBlocked, "pending-review");
        assert.isNull(entryOf(view, "arxiv").collectBlocked);
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
        const notReady = yield* Effect.flip(update({ source: "stackexchange", rank: true }));
        assert.strictEqual(reasonOf(notReady), "rank-blocked");
        // Captures need the terms read too, not only the engine.
        const unread = yield* Effect.flip(update({ source: "stackexchange", collect: true }));
        assert.strictEqual(reasonOf(unread), "collect-blocked");
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

const MIB = 1024 * 1024;
const OVERSIZED_BYTES = 64 * MIB;

interface LocalWeb {
  readonly base: string;
  /** Paths requested, in order. */
  readonly requests: Array<string>;
  /** Bytes of /oversized the server managed to write before the client went away. */
  readonly oversizedSent: () => number;
}

/** Writes a feed-shaped body far over the 4 MiB limit in 64 KiB chunks, honoring backpressure. */
function streamOversized(response: NodeHttp.ServerResponse, sent: { bytes: number }) {
  response.writeHead(200, { "Content-Type": "application/rss+xml" });
  const chunk = Buffer.alloc(64 * 1024, "a");
  // Stops once the client cancels: the socket is destroyed and `drain` never comes.
  const pump = () => {
    while (sent.bytes < OVERSIZED_BYTES) {
      if (response.destroyed) return;
      sent.bytes += chunk.length;
      if (!response.write(chunk)) return void response.once("drain", pump);
    }
    response.end();
  };
  pump();
}

/** A local site: robots.txt keeps /private out, /feed redirects into it, and the rest answer. */
const localWeb = (robots: { readonly status: number; readonly body: string }) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly web: LocalWeb; readonly server: NodeHttp.Server }>((resume) => {
      const requests: Array<string> = [];
      const sent = { bytes: 0 };
      const server = NodeHttp.createServer((request, response) => {
        const path = request.url ?? "/";
        requests.push(path);
        const send = (status: number, body: string, type = "application/xml") =>
          response.writeHead(status, { "Content-Type": type }).end(body);
        if (path === "/robots.txt") return send(robots.status, robots.body, "text/plain");
        if (path === "/feed.xml" || path === "/private/feed.xml") return send(200, RSS_DOC);
        if (path === "/atom") return send(200, ATOM_DOC);
        if (path === "/page") return send(200, "<!doctype html><html><body>Hi</body></html>");
        if (path === "/feed") {
          return response.writeHead(302, { Location: "/private/feed.xml" }).end();
        }
        if (path === "/oversized") return streamOversized(response, sent);
        return send(404, "not found", "text/plain");
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as NodeNet.AddressInfo;
        resume(
          Effect.succeed({
            server,
            web: { base: `http://127.0.0.1:${port}`, requests, oversizedSent: () => sent.bytes },
          }),
        );
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(({ web }) => web));

const ROBOTS = { status: 200, body: "User-agent: *\nDisallow: /private\n" };

describe("editorial RSS feeds", () => {
  it.live("validates RSS and Atom feeds and reports their entries, site and latest date", () =>
    Effect.gen(function* () {
      const web = yield* localWeb(ROBOTS);
      yield* withSources(
        makeTempDir(),
        Effect.gen(function* () {
          const validate = (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.validateFeed];
          const rss = yield* validate({ feedUrl: `${web.base}/feed.xml` });
          assert.strictEqual(rss.title, "Example Engineering");
          assert.strictEqual(rss.siteUrl, "https://blog.example.com/");
          assert.strictEqual(rss.entries, 2);
          assert.strictEqual(rss.latestAt, "2026-10-30T08:30:00.000Z");
          const atom = yield* validate({ feedUrl: `${web.base}/atom` });
          assert.strictEqual(atom.siteUrl, "https://notes.example.org/");
          assert.strictEqual(atom.entries, 1);
          assert.strictEqual(atom.latestAt, "2026-10-31T09:00:00.000Z");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("refuses a page that is not a feed, a disallowed path and a redirect into one", () =>
    Effect.gen(function* () {
      const web = yield* localWeb(ROBOTS);
      yield* withSources(
        makeTempDir(),
        Effect.gen(function* () {
          const validate = (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.validateFeed];
          const html = yield* Effect.flip(validate({ feedUrl: `${web.base}/page` }));
          assert.strictEqual(reasonOf(html), "not-a-feed");
          const direct = yield* Effect.flip(validate({ feedUrl: `${web.base}/private/feed.xml` }));
          assert.strictEqual(reasonOf(direct), "robots-disallowed");
          // /feed answers 302 to /private/feed.xml: robots is checked again for the new hop.
          const redirected = yield* Effect.flip(validate({ feedUrl: `${web.base}/feed` }));
          assert.strictEqual(reasonOf(redirected), "robots-disallowed");
          assert.notInclude(web.requests, "/private/feed.xml");
          const bad = yield* Effect.flip(validate({ feedUrl: "ftp://example.com/feed" }));
          assert.strictEqual(reasonOf(bad), "invalid-url");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("cuts an oversized feed while reading instead of downloading it whole", () =>
    Effect.gen(function* () {
      const web = yield* localWeb(ROBOTS);
      yield* withSources(
        makeTempDir(),
        Effect.gen(function* () {
          const validate = (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.validateFeed];
          const error = yield* Effect.flip(validate({ feedUrl: `${web.base}/oversized` }));
          assert.strictEqual(reasonOf(error), "too-large");
        }),
      );
      // Socket buffers let a few MiB more through; the whole 64 MiB never is.
      assert.isBelow(web.oversizedSent(), 16 * MIB);
    }).pipe(Effect.scoped),
  );

  it.live("reports a robots.txt that does not answer and a host that is down", () =>
    Effect.gen(function* () {
      const broken = yield* localWeb({ status: 503, body: "" });
      const down = yield* localWeb(ROBOTS);
      const downBase = down.base;
      yield* withSources(
        makeTempDir(),
        Effect.gen(function* () {
          const validate = (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.validateFeed];
          const robots = yield* Effect.flip(validate({ feedUrl: `${broken.base}/feed.xml` }));
          assert.strictEqual(reasonOf(robots), "robots-unavailable");
          assert.notInclude(broken.requests, "/feed.xml");
          const missing = yield* Effect.flip(validate({ feedUrl: `${downBase}/gone.xml` }));
          assert.strictEqual(reasonOf(missing), "unreachable");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("adds, lists, excludes and removes feeds, and hands the engine the result", () =>
    Effect.gen(function* () {
      const web = yield* localWeb(ROBOTS);
      const FEED = `${web.base}/feed.xml`;
      yield* withSources(
        makeTempDir(),
        Effect.gen(function* () {
          const client = yield* operator;
          const sources = yield* EditorialSourcesService.EditorialSourcesService;
          const added = yield* client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({
            feedUrl: FEED,
            acknowledged: true,
          });
          const mine = added.rssFeeds.filter((feed) => feed.origin === "user");
          assert.strictEqual(mine.length, 1);
          assert.isNotNull(mine[0]!.acknowledgedAt);
          assert.strictEqual(mine[0]!.name, "Example Engineering");
          assert.strictEqual(mine[0]!.siteUrl, "https://blog.example.com/");
          assert.match(mine[0]!.id, /^user-[0-9a-f]{12}$/);
          assert.strictEqual(
            added.rssFeeds.filter((feed) => feed.origin === "default").length,
            RSS_FEEDS.length,
          );

          const named = yield* client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({
            feedUrl: `${web.base}/atom`,
            acknowledged: true,
            name: "Mis notas",
            siteUrl: "https://notas.example.net/",
            note: "Probando",
          });
          assert.strictEqual(named.rssFeeds.at(-1)!.name, "Mis notas");
          assert.strictEqual(named.rssFeeds.at(-1)!.siteUrl, "https://notas.example.net/");
          assert.strictEqual(named.rssFeeds.at(-1)!.note, "Probando");
          const badSite = yield* Effect.flip(
            client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({
              feedUrl: `${web.base}/page`,
              acknowledged: true,
              siteUrl: "notas",
            }),
          );
          assert.strictEqual(reasonOf(badSite), "invalid-url");
          const duplicate = yield* Effect.flip(
            client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({ feedUrl: FEED, acknowledged: true }),
          );
          assert.strictEqual(reasonOf(duplicate), "duplicate-feed");
          const refused = yield* Effect.flip(
            client[EDITORIAL_SOURCES_WS_METHODS.addFeed]({
              feedUrl: `${web.base}/feed`,
              acknowledged: true,
            }),
          );
          assert.strictEqual(reasonOf(refused), "robots-disallowed");

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
      );
    }).pipe(Effect.scoped),
  );

  it.live("refuses a feed added without the operator's acceptance, before fetching it", () =>
    Effect.gen(function* () {
      const web = yield* localWeb(ROBOTS);
      yield* withSources(
        makeTempDir(),
        Effect.gen(function* () {
          const add = (yield* operator)[EDITORIAL_SOURCES_WS_METHODS.addFeed];
          const missing = yield* Effect.flip(add({ feedUrl: `${web.base}/feed.xml` }));
          assert.strictEqual(reasonOf(missing), "not-acknowledged");
          const declined = yield* Effect.flip(
            add({ feedUrl: `${web.base}/feed.xml`, acknowledged: false }),
          );
          assert.strictEqual(reasonOf(declined), "not-acknowledged");
          assert.deepStrictEqual(web.requests, []);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses feed changes from a read-only session", () =>
    withSources(
      makeTempDir(),
      Effect.gen(function* () {
        const client = yield* reader;
        const error = yield* Effect.flip(
          client[EDITORIAL_SOURCES_WS_METHODS.validateFeed]({ feedUrl: "https://example.com/f" }),
        );
        assert.strictEqual(error._tag, "EnvironmentAuthorizationError");
      }),
    ).pipe(Effect.scoped),
  );
});
