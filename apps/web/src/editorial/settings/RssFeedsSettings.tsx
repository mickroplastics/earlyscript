import type { EditorialFeedCheck, EditorialRssFeed } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";

export type FeedOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export interface RssFeedControls {
  readonly onExcludeDefault: (id: string, excluded: boolean) => void;
  readonly onAdd: (input: {
    readonly feedUrl: string;
    readonly name?: string;
    readonly siteUrl?: string;
    readonly note?: string;
    readonly acknowledged: true;
  }) => Promise<FeedOutcome<void>>;
  readonly onRemove: (feedUrl: string) => void;
  readonly onTest: (feedUrl: string) => Promise<FeedOutcome<EditorialFeedCheck>>;
}

const dateFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

function feedCheckText(check: EditorialFeedCheck): string {
  const entries = `${check.entries} ${check.entries === 1 ? "entrada" : "entradas"}`;
  return check.latestAt === null
    ? `Responde · ${entries}, sin fecha legible`
    : `Responde · ${entries}, la más reciente del ${dateFormat.format(new Date(check.latestAt))}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** "answer.ai/index.xml": the feed URL without its scheme. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "");

/** A folded block inside a source's record: a chevron, a title and a quiet summary. */
export function Fold({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  readonly title: string;
  readonly summary?: string;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md text-left text-sm text-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0">{title}</span>
        {summary ? (
          <span className="ml-auto min-w-0 truncate pl-4 text-xs text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-1 pb-2 pl-5">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The engine's curated feeds, folded, each with a switch to leave it out. */
export function DefaultFeeds({
  feeds,
  onExclude,
}: {
  readonly feeds: ReadonlyArray<EditorialRssFeed>;
  readonly onExclude: (id: string, excluded: boolean) => void;
}) {
  const included = feeds.filter((feed) => !feed.excluded);
  const names = included.slice(0, 4).map((feed) => feed.name);
  const summary = `${included.length === feeds.length ? "todos incluidos" : `${included.length} de ${feeds.length} incluidos`}${names.length > 0 ? ` · ${names.join(", ")}${included.length > names.length ? "…" : ""}` : ""}`;
  return (
    <Fold title={`${feeds.length} feeds por defecto`} summary={summary}>
      <ul className="space-y-1.5 text-xs text-muted-foreground">
        {feeds.map((feed) => (
          <li key={feed.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">{feed.name}</span>
              <span className="block truncate">
                {shortUrl(feed.feedUrl)}
                {feed.note ? ` · ${feed.note}` : ""}
              </span>
            </span>
            <Switch
              size="sm"
              checked={!feed.excluded}
              onCheckedChange={(checked) => onExclude(feed.id, !checked)}
              aria-label={`Incluir ${feed.name}`}
            />
          </li>
        ))}
      </ul>
    </Fold>
  );
}

function UserFeed({
  feed,
  controls,
}: {
  readonly feed: EditorialRssFeed;
  readonly controls: RssFeedControls;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<FeedOutcome<EditorialFeedCheck> | null>(null);
  const test = async () => {
    setTesting(true);
    setResult(await controls.onTest(feed.feedUrl));
    setTesting(false);
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="text-foreground">
          {feed.siteUrl ? (
            <a
              href={feed.siteUrl}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
            >
              {feed.name}
            </a>
          ) : (
            feed.name
          )}
        </span>
        <span className="ml-2 text-xs text-muted-foreground">{shortUrl(feed.feedUrl)}</span>
        {feed.note ? (
          <span className="block text-xs text-muted-foreground">{feed.note}</span>
        ) : null}
      </span>
      {result ? (
        <span
          role="status"
          className={cn(
            "flex items-center gap-1 text-xs",
            result.ok ? "text-success-foreground" : "text-destructive-foreground",
          )}
        >
          {result.ok ? <CheckIcon aria-hidden className="size-3" /> : null}
          {result.ok ? feedCheckText(result.value) : result.message}
        </span>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={testing}
        onClick={() => void test()}
        aria-label={`Probar ${feed.name}`}
      >
        {testing ? "Probando…" : "Probar"}
      </Button>
      <Button
        size="xs"
        variant="ghost-destructive"
        onClick={() => controls.onRemove(feed.feedUrl)}
        aria-label={`Quitar ${feed.name}`}
      >
        Quitar
      </Button>
    </li>
  );
}

function AddFeedForm({ onAdd }: { readonly onAdd: RssFeedControls["onAdd"] }) {
  const [feedUrl, setFeedUrl] = useState("");
  const [name, setName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!feedUrl.trim()) return;
    const invalid = [feedUrl, siteUrl].find((value) => value.trim() && !isHttpUrl(value));
    if (invalid !== undefined) {
      setError(`«${invalid.trim()}» no es una URL válida: debe empezar con http:// o https://.`);
      return;
    }
    setAdding(true);
    setError(null);
    const outcome = await onAdd({
      feedUrl: feedUrl.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(siteUrl.trim() ? { siteUrl: siteUrl.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      acknowledged: true,
    });
    setAdding(false);
    if (outcome.ok) {
      setFeedUrl("");
      setName("");
      setSiteUrl("");
      setNote("");
      setAcknowledged(false);
    } else {
      setError(outcome.message);
    }
  };
  // An error describes the URLs it was given; editing them retires it.
  const edit = (set: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    setError(null);
  };
  return (
    <form className="space-y-2 pt-2" noValidate onSubmit={(event) => void submit(event)}>
      <div className="flex gap-2">
        <Input
          size="sm"
          inputMode="url"
          value={feedUrl}
          onChange={edit(setFeedUrl)}
          placeholder="https://ejemplo.com/feed.xml"
          aria-label="URL del feed"
          aria-invalid={error !== null}
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          type="submit"
          disabled={adding || !feedUrl.trim() || !acknowledged}
        >
          {adding ? "Comprobando…" : "Probar y agregar"}
        </Button>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
        <span>Lo uso para análisis privado, sin republicar, y respeto los términos del sitio</span>
      </label>
      <Fold title="Nombre, sitio y nota (opcional)">
        <div className="grid gap-1.5 @min-[32rem]/settings-row:grid-cols-3">
          <Input
            size="sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nombre (se toma del feed)"
            aria-label="Nombre del feed"
          />
          <Input
            size="sm"
            inputMode="url"
            value={siteUrl}
            onChange={edit(setSiteUrl)}
            placeholder="URL del sitio (se toma del feed)"
            aria-label="URL del sitio"
          />
          <Input
            size="sm"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Nota"
            aria-label="Nota del feed"
          />
        </div>
      </Fold>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** The operator's feeds, each with «Probar» and «Quitar», and the form to add one. */
export function UserFeeds({
  feeds,
  controls,
}: {
  readonly feeds: ReadonlyArray<EditorialRssFeed>;
  readonly controls: RssFeedControls;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Tus feeds</p>
      {feeds.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no agregaste feeds.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {feeds.map((feed) => (
            <UserFeed key={feed.feedUrl} feed={feed} controls={controls} />
          ))}
        </ul>
      )}
      <AddFeedForm onAdd={controls.onAdd} />
      <p className="text-xs text-muted-foreground">
        Al agregar, se comprueba el robots.txt del sitio y se descarga el feed una vez.
      </p>
    </div>
  );
}
