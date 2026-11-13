import { CHANNEL_LANGUAGES } from "@t3tools/contracts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "../../components/ui/select";
import type {
  EditorialEngineScoring,
  EditorialProfileField,
  EditorialProfileVersion,
} from "@t3tools/contracts";
import { ChevronRightIcon, LockIcon, XIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import {
  PROFILE_READ_ONLY_TEXT,
  profileVersionLabel,
  scoringRows,
  topicCount,
  topicsFromText,
  type ProfileFormValues,
} from "./profileForm.logic";

/** The element id of a field, so a failed save can focus the first invalid one. */
export const profileFieldId = (formId: string, field: EditorialProfileField) =>
  `${formId}-${field}`;

function Field({
  id,
  label,
  hint,
  error,
  counter,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly error: string | undefined;
  readonly counter?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {counter ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{counter}</span>
        ) : null}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="text-xs leading-normal text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

const topicsLabel = (count: number) => (count === 1 ? "1 tema" : `${count} temas`);

/** The rows shown: the topics, then one empty row to add the next. */
const rowsOf = (topics: ReadonlyArray<string>): ReadonlyArray<string> =>
  topics.at(-1) === "" ? topics : [...topics, ""];

/** Without the empty rows at the end, which the list adds back by itself. */
const trimTrailing = (rows: ReadonlyArray<string>): ReadonlyArray<string> => {
  let end = rows.length;
  while (end > 0 && rows[end - 1]!.trim() === "") end -= 1;
  return rows.slice(0, end);
};

/**
 * One topic per row, each wrapping to its full length. Enter starts a topic below, Backspace
 * on an empty one removes it and pasted lines become one topic each. The last row is empty and
 * adds a topic as the operator types.
 */
function TopicList({
  id,
  label,
  topics,
  onChange,
  invalid,
  describedBy,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly topics: ReadonlyArray<string>;
  readonly onChange: (topics: ReadonlyArray<string>) => void;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly disabled: boolean;
}) {
  const rows = rowsOf(topics);
  const refs = useRef<Array<HTMLTextAreaElement | null>>([]);

  const replace = (index: number, inserted: ReadonlyArray<string>, removed = 1) =>
    trimTrailing([...rows.slice(0, index), ...inserted, ...rows.slice(index + removed)]);

  /** Commits the rows, then moves the caret to `row`, which may only exist after the commit. */
  const commitAndFocus = (next: ReadonlyArray<string>, row: number, at: "start" | "end") => {
    flushSync(() => onChange(next));
    const element = refs.current[row];
    if (!element) return;
    element.focus();
    const caret = at === "end" ? element.value.length : 0;
    element.setSelectionRange(caret, caret);
  };

  return (
    <ol
      aria-label={label}
      className={cn(
        "divide-y rounded-lg border bg-background dark:bg-input/32",
        invalid && "border-destructive/36",
        disabled && "opacity-64",
      )}
    >
      {rows.map((topic, index) => {
        const isNew = index === rows.length - 1;
        return (
          // oxlint-disable-next-line react/no-array-index-key -- rows are positional: row N is topic N
          <li key={index} className="flex items-start gap-1 pr-1 pl-3">
            <span
              aria-hidden
              className="w-4 shrink-0 pt-1.75 text-right text-xs text-muted-foreground tabular-nums"
            >
              {isNew ? "+" : index + 1}
            </span>
            <textarea
              ref={(element) => {
                refs.current[index] = element;
              }}
              id={index === 0 ? id : undefined}
              rows={1}
              value={topic}
              disabled={disabled}
              spellCheck={false}
              placeholder={isNew ? "Añadir un tema…" : undefined}
              aria-label={isNew ? `${label}: tema nuevo` : `${label}: tema ${index + 1}`}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={describedBy}
              className="field-sizing-content min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base leading-snug text-foreground outline-none placeholder:text-placeholder sm:text-sm"
              onChange={(event) => {
                const value = event.target.value;
                const pasted = value.includes("\n") ? topicsFromText(value) : [value];
                const lines = pasted.length > 0 ? pasted : [""];
                if (lines.length > 1) {
                  commitAndFocus(replace(index, lines), index + lines.length - 1, "end");
                } else {
                  onChange(replace(index, lines));
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (topic.trim() === "") return;
                  const caret = event.currentTarget.selectionStart;
                  commitAndFocus(
                    replace(index, [topic.slice(0, caret), topic.slice(caret)]),
                    index + 1,
                    "start",
                  );
                } else if (event.key === "Backspace" && topic === "" && index > 0) {
                  // An emptied topic goes away; the add row only hands the cursor back.
                  event.preventDefault();
                  commitAndFocus(isNew ? rows : replace(index, []), index - 1, "end");
                }
              }}
            />
            {isNew ? (
              <span className="size-7 shrink-0" />
            ) : (
              <Button
                size="icon-sm"
                variant="ghost-destructive"
                className="mt-px"
                disabled={disabled}
                aria-label={`Quitar «${topic}»`}
                onClick={() => onChange(replace(index, []))}
              >
                <XIcon className="size-3.5" />
              </Button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface ProfileFormProps {
  /** Prefix of the field ids; `profileFieldId` builds them. */
  readonly formId: string;
  readonly values: ProfileFormValues;
  readonly onChange: (values: ProfileFormValues) => void;
  /** One message per field; shown only once the operator tried to save. */
  readonly errors: Partial<Record<EditorialProfileField, string>>;
  /** The version the form started from. */
  readonly version: EditorialProfileVersion;
  /** True once the fields differ from that version. */
  readonly edited: boolean;
  readonly disabled?: boolean;
  /** The session cannot write: every field is off and the notice says why. */
  readonly readOnly?: boolean;
}

/** Channel name, audience and topic lists of the studio profile. */
export function ProfileForm({
  formId,
  values,
  onChange,
  errors,
  version,
  edited,
  disabled: busy = false,
  readOnly = false,
}: ProfileFormProps) {
  const [customLanguage, setCustomLanguage] = useState(false);
  const showCode =
    customLanguage || !CHANNEL_LANGUAGES.some((item) => item.code === values.language);
  const disabled = busy || readOnly;
  const id = (field: EditorialProfileField) => profileFieldId(formId, field);
  const describedBy = (field: EditorialProfileField) =>
    errors[field] ? `${id(field)}-error` : `${id(field)}-hint`;
  return (
    <div className="space-y-4">
      {readOnly ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-foreground"
        >
          <LockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          {PROFILE_READ_ONLY_TEXT}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground" data-testid="profile-version">
        {profileVersionLabel(version)}
        {edited ? <span className="text-foreground"> · con cambios sin guardar</span> : null}
      </p>
      <Field
        id={id("name")}
        label="Nombre del canal"
        hint="Como aparece en YouTube."
        error={errors.name}
      >
        <Input
          nativeInput
          id={id("name")}
          value={values.name}
          disabled={disabled}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy("name")}
          onChange={(event) => onChange({ ...values, name: event.target.value })}
        />
      </Field>
      <Field
        id={id("language")}
        label="Idioma del canal"
        hint="El asistente escribe los guiones en este idioma."
        error={errors.language}
      >
        <Select
          value={showCode ? "other" : values.language}
          onValueChange={(value) => {
            if (value !== null) {
              setCustomLanguage(value === "other");
              onChange({ ...values, language: value === "other" ? "" : value });
            }
          }}
          disabled={disabled}
        >
          <SelectTrigger id={id("language")} aria-describedby={describedBy("language")}>
            <SelectValue>
              {showCode
                ? "Otro"
                : CHANNEL_LANGUAGES.find((item) => item.code === values.language)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {CHANNEL_LANGUAGES.map((item) => (
              <SelectItem key={item.code} value={item.code}>
                {item.label}
              </SelectItem>
            ))}
            <SelectItem value="other">Otro</SelectItem>
          </SelectPopup>
        </Select>
        {showCode ? (
          <Input
            nativeInput
            aria-label="Código del idioma"
            value={values.language}
            disabled={disabled}
            placeholder="pt-BR"
            onChange={(event) => onChange({ ...values, language: event.target.value })}
          />
        ) : null}
      </Field>
      <Field
        id={id("audience")}
        label="Audiencia"
        hint="Una frase: para quién es el canal. El asistente la lee al redactar."
        error={errors.audience}
      >
        {/* One paragraph that wraps, so a long audience is readable on a phone. */}
        <Textarea
          id={id("audience")}
          size="sm"
          rows={1}
          value={values.audience}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={errors.audience ? true : undefined}
          aria-describedby={describedBy("audience")}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          onChange={(event) =>
            onChange({ ...values, audience: event.target.value.replace(/\s*\r?\n\s*/g, " ") })
          }
        />
      </Field>
      {(
        [
          [
            "include",
            "Temas que cubre",
            "En inglés: se comparan con publicaciones en inglés. Enter añade otro.",
          ],
          [
            "exclude",
            "Temas que deja fuera",
            "En inglés. Una tendencia parecida a alguno se descarta.",
          ],
        ] as const
      ).map(([field, label, hint]) => (
        <Field
          key={field}
          id={id(field)}
          label={label}
          hint={hint}
          error={errors[field]}
          counter={topicsLabel(topicCount(values[field]))}
        >
          <TopicList
            id={id(field)}
            label={label}
            topics={values[field]}
            onChange={(topics) => onChange({ ...values, [field]: topics })}
            invalid={Boolean(errors[field])}
            describedBy={describedBy(field)}
            disabled={disabled}
          />
        </Field>
      ))}
    </div>
  );
}

/** The engine's scoring parameters, folded and read only. */
export function EngineScoringPanel({
  scoring,
  note,
}: {
  readonly scoring: EditorialEngineScoring | null;
  readonly note: string;
}) {
  const panelId = useId();
  return (
    <div className="rounded-lg border">
      <Collapsible>
        <CollapsibleTrigger
          aria-controls={panelId}
          className="group/scoring flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/scoring:rotate-90"
          />
          <span className="min-w-0 flex-1">Pesos de la puntuación del motor</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">Solo lectura</span>
        </CollapsibleTrigger>
        <CollapsiblePanel id={panelId}>
          <div className="space-y-3 border-t px-3 pt-2.5 pb-3">
            {scoring === null ? (
              <p className="text-xs text-muted-foreground">
                El motor no está instalado en este servidor; sus pesos aparecerán cuando lo esté.
              </p>
            ) : (
              <>
                <dl className="divide-y">
                  {scoringRows(scoring).map((row) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-2"
                    >
                      <dt className="text-sm text-foreground">{row.label}</dt>
                      <dd className="row-span-2 text-sm font-medium text-foreground tabular-nums">
                        {row.value}
                      </dd>
                      {row.description ? (
                        <dd className="text-xs leading-normal text-muted-foreground">
                          {row.description}
                        </dd>
                      ) : null}
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">
                  Configuración <code className="font-mono">{scoring.configVersion}</code>. {note}
                </p>
              </>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** Versions of the profile, newest first, with the active one marked. */
export function ProfileHistoryList({
  versions,
  className,
}: {
  readonly versions: ReadonlyArray<EditorialProfileVersion>;
  readonly className?: string;
}) {
  return (
    <ol className={cn("divide-y", className)} aria-label="Versiones del perfil">
      {versions.map((version) => (
        <li key={version.version} className="space-y-0.5 py-2">
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-foreground">
            <span>{profileVersionLabel(version)}</span>
            {version.active ? (
              <Badge size="sm" variant="success">
                Activa
              </Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {topicsLabel(version.include.length)} que cubre, {version.exclude.length} fuera ·{" "}
            <code className="font-mono">{version.hash.slice("sha256:".length, 19)}</code>
          </p>
        </li>
      ))}
    </ol>
  );
}
