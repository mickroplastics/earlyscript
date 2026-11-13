import { CHANNEL_LANGUAGES, type EditorialProfileField } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { profileFieldId } from "../profile/ProfileForm";
import { topicCount, topicsFromText, type ProfileFormValues } from "../profile/profileForm.logic";
import { useProfileEditor, type ProfileEditor } from "../profile/useProfileEditor";
import { EXAMPLE_EXCLUDED_TREND, EXAMPLE_TREND } from "./onboardingExamples";
import type { OnboardingStepProps } from "./steps";
import { SectionLabel, StepLayout } from "./wizardLayout";

/** What the shell records when the step is accepted: the version and the engine's hash. */
export interface StudioAcceptance {
  readonly profileVersion: number;
  readonly profileHash: string;
}

function FieldError({ id, text }: { readonly id: string; readonly text: string | undefined }) {
  if (!text) return null;
  return (
    <p id={`${id}-error`} role="alert" className="text-xs text-destructive-foreground">
      {text}
    </p>
  );
}

/**
 * Topics one per row, each editable and removable, and a last row that adds one: Enter or a
 * pasted list adds them, one per line.
 */
function TopicRows({
  id,
  label,
  topics,
  onChange,
  invalid,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly topics: ReadonlyArray<string>;
  readonly onChange: (topics: ReadonlyArray<string>) => void;
  readonly invalid: boolean;
  readonly disabled: boolean;
}) {
  const [adding, setAdding] = useState("");
  const add = (text: string) => {
    const lines = topicsFromText(text);
    if (lines.length === 0) return;
    onChange([...topics, ...lines]);
    setAdding("");
  };
  return (
    <ul
      aria-label={label}
      className={cn(
        "divide-y overflow-hidden rounded-lg border bg-background",
        invalid && "border-destructive/36",
      )}
    >
      {topics.map((topic, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- rows are positional: row N is topic N
        <li key={index} className="flex items-start gap-1 pr-1.5 pl-3.5">
          <textarea
            id={index === 0 ? id : undefined}
            rows={1}
            value={topic}
            disabled={disabled}
            spellCheck={false}
            aria-label={`${label}: tema ${index + 1}`}
            aria-invalid={invalid ? true : undefined}
            className="field-sizing-content min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-snug text-foreground outline-none"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            onChange={(event) =>
              onChange(topics.map((current, at) => (at === index ? event.target.value : current)))
            }
          />
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            className="mt-0.5"
            disabled={disabled}
            aria-label={`Quitar «${topic}»`}
            onClick={() => onChange(topics.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
        </li>
      ))}
      <li className="flex items-center gap-2 px-3.5">
        <PlusIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {/* A textarea: an input would drop the line breaks of a pasted list. */}
        <textarea
          id={topics.length === 0 ? id : undefined}
          rows={1}
          value={adding}
          disabled={disabled}
          spellCheck={false}
          placeholder="Añadir un tema"
          aria-label={`${label}: tema nuevo`}
          className="field-sizing-content min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add(adding);
            }
          }}
          onBlur={() => add(adding)}
          onChange={(event) => {
            const value = event.target.value;
            if (value.includes("\n")) add(value);
            else setAdding(value);
          }}
        />
      </li>
    </ul>
  );
}

/** The channel's name, language, audience and topics: what picks the trends and whom it writes for. */
function ChannelForm({
  formId,
  values,
  onChange,
  errors,
  disabled,
}: {
  readonly formId: string;
  readonly values: ProfileFormValues;
  readonly onChange: (values: ProfileFormValues) => void;
  readonly errors: Partial<Record<EditorialProfileField, string>>;
  readonly disabled: boolean;
}) {
  const id = (field: EditorialProfileField) => profileFieldId(formId, field);
  const describedBy = (field: EditorialProfileField) =>
    errors[field] ? `${id(field)}-error` : undefined;
  const known = CHANNEL_LANGUAGES.some((item) => item.code === values.language);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const excludeId = useId();
  const included = topicCount(values.include);
  const excluded = topicCount(values.exclude);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("name")} className="text-sm text-foreground">
            Nombre
          </label>
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
          <FieldError id={id("name")} text={errors.name} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("language")} className="text-sm text-foreground">
            Idioma
          </label>
          <Select
            value={known ? values.language : values.language === "" ? null : values.language}
            onValueChange={(value) => {
              if (typeof value === "string") onChange({ ...values, language: value });
            }}
            disabled={disabled}
          >
            <SelectTrigger id={id("language")} aria-describedby={describedBy("language")}>
              <SelectValue>
                {CHANNEL_LANGUAGES.find((item) => item.code === values.language)?.label ??
                  values.language}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {CHANNEL_LANGUAGES.map((item) => (
                <SelectItem key={item.code} value={item.code}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <FieldError id={id("language")} text={errors.language} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id("audience")} className="text-sm text-foreground">
          Para quién es
        </label>
        <Textarea
          id={id("audience")}
          rows={2}
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
        <FieldError id={id("audience")} text={errors.audience} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-foreground">
          <label htmlFor={id("include")}>Temas que cubre</label>
          <span className="text-xs text-muted-foreground"> · {included}, en inglés</span>
        </p>
        <TopicRows
          id={id("include")}
          label="Temas que cubre"
          topics={values.include}
          onChange={(include) => onChange({ ...values, include })}
          invalid={Boolean(errors.include)}
          disabled={disabled}
        />
        <FieldError id={id("include")} text={errors.include} />
      </div>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          aria-expanded={excludeOpen || Boolean(errors.exclude)}
          aria-controls={excludeId}
          onClick={() => setExcludeOpen(!excludeOpen)}
          className="flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 transition-transform",
              (excludeOpen || errors.exclude) && "rotate-90",
            )}
          />
          Temas que no te interesan · {excluded}
        </button>
        {excludeOpen || errors.exclude ? (
          <div id={excludeId} className="flex flex-col gap-1.5">
            <TopicRows
              id={id("exclude")}
              label="Temas que no te interesan"
              topics={values.exclude}
              onChange={(exclude) => onChange({ ...values, exclude })}
              invalid={Boolean(errors.exclude)}
              disabled={disabled}
            />
            <FieldError id={id("exclude")} text={errors.exclude} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One trend in or out of the channel, on the right. */
function ChannelExample() {
  return (
    <div data-testid="channel-example">
      <SectionLabel tone="accent">Ejemplo</SectionLabel>
      <ul className="mt-2 border-t border-dashed">
        <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 border-b border-dashed py-3.5">
          <CheckIcon aria-label="Entra" className="mt-0.5 size-3.5 text-success" />
          <div>
            <p className="text-sm text-foreground">{EXAMPLE_TREND.shortTitle}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Entra por «{EXAMPLE_TREND.topic}»
            </p>
          </div>
        </li>
        <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 border-b border-dashed py-3.5">
          <MinusIcon aria-label="Queda fuera" className="mt-0.5 size-3.5 text-muted-foreground" />
          <div>
            <p className="text-sm text-muted-foreground">{EXAMPLE_EXCLUDED_TREND.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Queda fuera: «{EXAMPLE_EXCLUDED_TREND.topic}»
            </p>
          </div>
        </li>
      </ul>
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        Al redactar, el asistente escribe para la audiencia de arriba.
      </p>
    </div>
  );
}

export interface StudioStepViewProps {
  readonly editor: ProfileEditor;
  readonly formId: string;
  readonly onBack: (() => void) | null;
  readonly onContinue: (acceptance: StudioAcceptance) => void;
}

export function StudioStepView({ editor, formId, onBack, onContinue }: StudioStepViewProps) {
  const { view, values } = editor;
  const submit = async () => {
    const outcome = await editor.save();
    if (outcome._tag === "saved") {
      onContinue({ profileVersion: outcome.active.version, profileHash: outcome.active.hash });
    }
  };
  return (
    <StepLayout
      testId="studio-step"
      title="Tu canal"
      description="Con esto se eligen las tendencias de tu bandeja y el asistente sabe para quién escribe."
      aside={<ChannelExample />}
      footer={
        <>
          {onBack ? (
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeftIcon className="size-3.5" />
              Atrás
            </Button>
          ) : (
            <span />
          )}
          <div className="flex min-w-0 items-center gap-3">
            {editor.failure ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {editor.failure}
              </p>
            ) : null}
            <Button disabled={values === null || editor.saving} onClick={() => void submit()}>
              {editor.saving ? <Spinner size="sm" /> : null}
              {editor.edited ? "Guardar y continuar" : "Continuar"}
            </Button>
          </div>
        </>
      }
    >
      {view === null || values === null ? (
        editor.loadError ? (
          <div className="space-y-2 text-sm" role="alert">
            <p className="text-foreground">No se pudo leer el perfil del canal.</p>
            <p className="text-xs text-muted-foreground">{editor.loadError}</p>
            <Button size="xs" variant="outline" onClick={editor.retry}>
              Reintentar
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner size="sm" />
            Leyendo el perfil del canal…
          </p>
        )
      ) : (
        <ChannelForm
          formId={formId}
          values={values}
          onChange={editor.setValues}
          errors={editor.errors}
          disabled={editor.saving || editor.readOnly}
        />
      )}
    </StepLayout>
  );
}

/** Step 3 of the first-run wizard: the channel profile, saved as a new version when edited. */
export function StudioStep({ environmentId, onContinue, onBack }: OnboardingStepProps) {
  const formId = useId();
  const editor = useProfileEditor(environmentId, formId);
  return (
    <StudioStepView
      editor={editor}
      formId={formId}
      onBack={onBack}
      onContinue={(acceptance) => onContinue({ ...acceptance })}
    />
  );
}
