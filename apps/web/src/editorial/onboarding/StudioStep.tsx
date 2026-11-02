import type { OnboardingStepProps } from "./steps";

/** Placeholder: replaced by the stream that owns this step (see README.md). */
export function StudioStep({ onContinue }: OnboardingStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">Paso «estudio» en construcción.</p>
      <button type="button" onClick={() => onContinue({ placeholder: true })}>
        Continuar
      </button>
    </div>
  );
}
