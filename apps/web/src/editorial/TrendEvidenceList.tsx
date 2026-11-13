import type { EditorialEvidenceItem, EditorialTrendDossier } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useId, type MouseEvent } from "react";

import { useOpenLink } from "../browser/useOpenLink";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { evidenceLinks, evidenceRangeText, formatDate, sourceName } from "./editorial.logic";
import { DOSSIER_EVIDENCE_ALL_LIMIT } from "./presentationState";
import { EVIDENCE_PREVIEW_COUNT, shownEvidence } from "./trendDossier.logic";

const evidenceAnchorId = (itemId: string) => `evidence-${itemId}`;

const twoDigits = (value: number) => String(value).padStart(2, "0");

function EvidenceRow({
  item,
  number,
  alsoIn,
  open,
}: {
  readonly item: EditorialEvidenceItem;
  readonly number: number;
  readonly alsoIn: ReadonlyArray<string> | undefined;
  readonly open: (event: MouseEvent<HTMLAnchorElement>, url: string) => void;
}) {
  const links = evidenceLinks(item);
  const url = links.title;
  const discussion = links.discussion;
  return (
    <li
      id={evidenceAnchorId(item.itemId)}
      data-evidence-number={number}
      className="group/evidence-row grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-b border-border/60 py-3"
    >
      <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">{twoDigits(number)}</span>
      <div className="flex min-w-0 flex-col gap-1">
        {url ? (
          <a
            href={url}
            onClick={(event) => open(event, url)}
            className="inline-flex min-w-0 items-baseline gap-1 self-start rounded-sm text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span className="min-w-0">{item.title}</span>
            <ExternalLinkIcon
              aria-hidden
              className="size-3 shrink-0 translate-y-0.5 text-muted-foreground"
            />
          </a>
        ) : (
          <span className="text-sm font-medium text-foreground">{item.title}</span>
        )}
        {item.excerpt ? (
          <p className="line-clamp-2 text-xs text-foreground/80">{item.excerpt}</p>
        ) : null}
        <p className="flex flex-wrap items-baseline gap-x-1 text-xs text-muted-foreground">
          <span>
            {sourceName(item.source)} · {formatDate(item.publishedAt)}
            {item.author ? ` · ${item.author}` : null}
          </span>
          {discussion ? (
            <span>
              {"· "}
              <a
                href={discussion}
                onClick={(event) => open(event, discussion)}
                className="inline-flex items-baseline gap-0.5 rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                discusión
                <ExternalLinkIcon aria-hidden className="size-2.5 shrink-0" />
              </a>
            </span>
          ) : null}
          {alsoIn && alsoIn.length > 0 ? (
            <span>· también en {alsoIn.map(sourceName).join(", ")}</span>
          ) : null}
          <code className="invisible ms-auto font-mono text-2xs text-muted-foreground/70 group-focus-within/evidence-row:visible group-hover/evidence-row:visible">
            {item.itemId}
          </code>
        </p>
      </div>
    </li>
  );
}

/**
 * "Lee la evidencia": three items, then every one of them on request. Numbers are the
 * dossier's evidence order, the same the summary's citations use.
 */
export function TrendEvidenceList({
  dossier,
  allEvidence,
  expanded,
  onExpandedChange,
  onPage,
  alsoIn,
}: {
  readonly dossier: EditorialTrendDossier;
  /** Every item (or the current page of fifty); `null` until it loads. */
  readonly allEvidence: EditorialTrendDossier | null;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onPage: (offset: number) => void;
  readonly alsoIn: ReadonlyMap<string, ReadonlyArray<string>>;
}) {
  const headingId = useId();
  const openLink = useOpenLink(null);
  const open = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    openLink(url, { event }).catch((error: unknown) => {
      console.error("Could not open the evidence link.", error);
    });
  };
  const total = dossier.evidenceTotal;
  const items = shownEvidence(dossier.evidence, allEvidence?.evidence ?? null, expanded);
  const offset = expanded && allEvidence !== null ? allEvidence.evidenceOffset : 0;
  const range = evidenceRangeText(dossier.evidenceRange);
  const loading = expanded && allEvidence === null;
  const paged = expanded && allEvidence !== null && total > DOSSIER_EVIDENCE_ALL_LIMIT;
  const to = offset + items.length;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1 border-t border-border pt-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          Lee la evidencia <span className="font-normal text-muted-foreground">· {total}</span>
        </h2>
        {range === null ? null : <span className="text-xs text-muted-foreground">{range}</span>}
      </div>
      {total === 0 ? (
        <p className="pt-2 text-sm text-muted-foreground">Esta ficha no trae evidencia.</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item, index) => (
            <EvidenceRow
              key={item.itemId}
              item={item}
              number={offset + index + 1}
              alsoIn={alsoIn.get(item.itemId)}
              open={open}
            />
          ))}
        </ul>
      )}
      {total > EVIDENCE_PREVIEW_COUNT ? (
        <div className="flex flex-wrap items-center gap-2 pt-3">
          {expanded ? (
            <Button
              size="sm"
              variant="ghost-muted"
              onClick={() => {
                onExpandedChange(false);
                if (offset > 0) onPage(0);
              }}
            >
              Mostrar solo tres
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onExpandedChange(true)}>
              Ver toda la evidencia ({total})
            </Button>
          )}
          {loading ? <Spinner size="sm" tone="muted" aria-label="Cargando la evidencia" /> : null}
          {paged ? (
            <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {offset + 1}–{to} de {total}
              </span>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={offset === 0}
                onClick={() => onPage(Math.max(0, offset - DOSSIER_EVIDENCE_ALL_LIMIT))}
              >
                Anteriores
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={to >= total}
                onClick={() => onPage(offset + DOSSIER_EVIDENCE_ALL_LIMIT)}
              >
                Siguientes
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
