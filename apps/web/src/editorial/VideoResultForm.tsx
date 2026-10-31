import type { EditorialVideoResult } from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  RESULT_METRICS,
  parseResultDraft,
  type ResultDraft,
  type ResultDraftParse,
} from "./videoThread.logic";

export interface VideoResultControls {
  readonly busy: boolean;
  readonly onDraftChange: (draft: ResultDraft) => void;
  readonly onSubmit: (input: Extract<ResultDraftParse, { _tag: "ok" }>["input"]) => void;
}

const formatCount = (value: number | null) =>
  value === null ? "sin dato" : value.toLocaleString("es");

/**
 * Video metrics typed by hand on a decided thread. Each save is one observation with its date;
 * the most recent ones are listed above the form. Descriptive only: a view count does not say
 * what the system did.
 */
export function VideoResultForm({
  results,
  draft,
  controls,
}: {
  readonly results: ReadonlyArray<EditorialVideoResult>;
  readonly draft: ResultDraft;
  readonly controls: VideoResultControls;
}) {
  const parsed = parseResultDraft(draft);
  const blank = RESULT_METRICS.every(({ key }) => draft.metrics[key].trim() === "");
  return (
    <form
      className="flex flex-col gap-2 px-2.5"
      aria-label="Resultado del video"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed._tag === "ok") controls.onSubmit(parsed.input);
      }}
    >
      {results.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Observaciones guardadas">
          {results.slice(0, 3).map((result) => (
            <li key={result.resultId} className="text-muted-foreground">
              {result.observedAt.slice(0, 10)}:{" "}
              {RESULT_METRICS.map(({ key, label }) => `${label} ${formatCount(result[key])}`).join(
                " · ",
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        {RESULT_METRICS.map(({ key, label }) => (
          <label key={key} className="flex flex-col gap-0.5 text-muted-foreground text-xs">
            {label}
            <Input
              size="compact"
              inputMode="numeric"
              value={draft.metrics[key]}
              onChange={(event) =>
                controls.onDraftChange({
                  ...draft,
                  metrics: { ...draft.metrics, [key]: event.currentTarget.value },
                })
              }
            />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-0.5 text-muted-foreground text-xs">
        Fecha de la observación
        <Input
          size="compact"
          type="date"
          value={draft.observedOn}
          onChange={(event) =>
            controls.onDraftChange({ ...draft, observedOn: event.currentTarget.value })
          }
        />
      </label>
      {parsed._tag === "invalid" && !blank ? (
        <p className="text-muted-foreground text-xs">{parsed.problem}</p>
      ) : null}
      <Button
        type="submit"
        size="xs"
        variant="outline"
        className="self-start"
        disabled={parsed._tag !== "ok" || controls.busy}
      >
        Guardar resultado
      </Button>
      <p className="text-muted-foreground text-xs">
        Descriptivo, no atribuido al sistema: las métricas dependen de mucho más que el guion.
      </p>
    </form>
  );
}
