import type { EditorialFeedCheck, EditorialRssFeed } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState, type ChangeEvent, type FormEvent } from "react";

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
    ? `${entries}, sin fecha legible.`
    : `${entries}, la más reciente del ${dateFormat.format(new Date(check.latestAt))}.`;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function FeedLine({ feed }: { readonly feed: EditorialRssFeed }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-foreground">
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
      <span className="block truncate">{feed.feedUrl}</span>
      {feed.origin === "default" && feed.note ? (
        <span className="block truncate">{feed.note}</span>
      ) : null}
    </span>
  );
}

function DefaultFeeds({
  feeds,
  onExclude,
}: {
  readonly feeds: ReadonlyArray<EditorialRssFeed>;
  readonly onExclude: (id: string, excluded: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const included = feeds.filter((feed) => !feed.excluded).length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-8 items-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        Feeds por defecto ({included} de {feeds.length} incluidos)
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="space-y-1.5 pb-2 text-xs text-muted-foreground">
          {feeds.map((feed) => (
            <li key={feed.id} className="flex items-center gap-3">
              <FeedLine feed={feed} />
              <Switch
                size="sm"
                checked={!feed.excluded}
                onCheckedChange={(checked) => onExclude(feed.id, !checked)}
                aria-label={`Incluir ${feed.name}`}
              />
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
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
    <li className="space-y-1">
      <div className="flex items-center gap-2">
        <FeedLine feed={feed} />
        <Button
          size="xs"
          variant="outline"
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
      </div>
      {feed.note ? <p>{feed.note}</p> : null}
      {result ? (
        <p role="status" className={result.ok ? undefined : "text-destructive-foreground"}>
          {result.ok ? feedCheckText(result.value) : result.message}
        </p>
      ) : null}
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
    <form className="space-y-1.5" noValidate onSubmit={(event) => void submit(event)}>
      <div className="grid gap-1.5 @min-[32rem]/settings-row:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Input
          size="sm"
          inputMode="url"
          value={feedUrl}
          onChange={edit(setFeedUrl)}
          placeholder="https://ejemplo.com/feed.xml"
          aria-label="URL del feed"
          aria-invalid={error !== null}
        />
        <Input
          size="sm"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nombre (opcional)"
          aria-label="Nombre del feed"
        />
      </div>
      <div className="grid gap-1.5 @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          size="sm"
          inputMode="url"
          value={siteUrl}
          onChange={edit(setSiteUrl)}
          placeholder="URL del sitio (opcional, se toma del feed)"
          aria-label="URL del sitio"
        />
        <Input
          size="sm"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Nota (opcional)"
          aria-label="Nota del feed"
        />
        <Button size="sm" type="submit" disabled={adding || !feedUrl.trim() || !acknowledged}>
          {adding ? "Comprobando…" : "Agregar feed"}
        </Button>
      </div>
      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
        <span>Uso para análisis privado, sin republicar; respeto los términos de este sitio</span>
      </label>
      {error ? (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Inside the RSS source row: the engine's feeds, the operator's, and the form to add one. */
export function RssFeedsSettings({
  feeds,
  controls,
}: {
  readonly feeds: ReadonlyArray<EditorialRssFeed>;
  readonly controls: RssFeedControls;
}) {
  const defaults = feeds.filter((feed) => feed.origin === "default");
  const mine = feeds.filter((feed) => feed.origin === "user");
  return (
    <div className="space-y-2 pb-1 text-xs text-muted-foreground">
      <DefaultFeeds feeds={defaults} onExclude={controls.onExcludeDefault} />
      <div className="space-y-1.5">
        <p className="font-medium text-foreground">Tus feeds</p>
        {mine.length === 0 ? (
          <p>Todavía no agregaste feeds.</p>
        ) : (
          <ul className="space-y-2">
            {mine.map((feed) => (
              <UserFeed key={feed.feedUrl} feed={feed} controls={controls} />
            ))}
          </ul>
        )}
        <AddFeedForm onAdd={controls.onAdd} />
        <p>
          Al agregar, el servidor comprueba el robots.txt del sitio y descarga el feed una vez con
          la identidad del motor.
        </p>
      </div>
    </div>
  );
}
