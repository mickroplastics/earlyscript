import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  exhaustedUsageWindow,
} from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  TrendPresentationGenerationInput,
  TrendPresentationGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateTrendPresentation";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);
// Earlyscript: trend titles and summaries fall back only to the local Claude and Codex CLIs.
const TREND_PRESENTATION_DRIVERS = new Set(["codex", "claudeAgent"]);

// Earlyscript, reversible heuristic: the Claude and Codex CLIs report a spent plan only as text
// in a failed command, so match that text. Format errors, timeouts and cancellations never match.
const CLI_COMMAND_FAILURE = /^(?:Claude|Codex) CLI command failed: /;
const USAGE_LIMIT_TEXT = new RegExp(
  [
    "usage limit",
    "rate limit",
    "hit your limit",
    "quota",
    "\\b429\\b",
    "too many requests",
    "resource_exhausted",
    CHATGPT_USAGE_LIMIT_CODE,
    CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  ].join("|"),
  "i",
);

/** @internal Exported for tests. */
export const isUsageLimitError = (error: TextGenerationError): boolean =>
  CLI_COMMAND_FAILURE.test(error.detail) && USAGE_LIMIT_TEXT.test(error.detail);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Picks another eligible instance; `exclude` holds instances already ruled out.
  const pickFallback = Effect.fn("TextGeneration.pickFallback")(function* (
    operation: TextGenerationOp,
    exclude: ReadonlySet<ProviderInstanceId>,
    snapshots: ReadonlyArray<ServerProvider>,
    now: number,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not read fallback model settings.",
            cause,
          }),
      ),
    );
    return fallbackTextGenerationModelSelection(
      settings.providerInstances,
      (instanceId, driver) => {
        const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
        return (
          !exclude.has(instanceId) &&
          provider?.enabled === true &&
          resolveProjectProviderInstanceEnabled(settings, null, instanceId) &&
          provider.installed &&
          provider.auth.status !== "unauthenticated" &&
          isProviderAvailable(provider) &&
          isProviderTextGenerationCapable(provider) &&
          (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
          (operation !== "generateTrendPresentation" || TREND_PRESENTATION_DRIVERS.has(driver)) &&
          !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
        );
      },
      { includeConfiguredInstances: true },
    );
  });
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const limited = exhaustedUsageWindow(
      snapshots.find((provider) => provider.instanceId === selection.instanceId),
      now,
      selection.model,
    );
    if (limited) {
      selection =
        (yield* pickFallback(operation, new Set([selection.instanceId]), snapshots, now)) ??
        selection;
    }
    const attempt = (modelSelection: ModelSelection) =>
      resolveInstance(registry, operation, modelSelection.instanceId).pipe(
        Effect.flatMap((service) => invoke(service, modelSelection)),
      );
    if (operation !== "generateTrendPresentation") return yield* attempt(selection);
    // Earlyscript: a usage limit found only at run time gets one retry on another Claude or Codex.
    const first = selection;
    return yield* attempt(first).pipe(
      Effect.catchIf(isUsageLimitError, (error) =>
        Effect.gen(function* () {
          const fallback = yield* pickFallback(
            operation,
            new Set([first.instanceId]),
            snapshots,
            now,
          );
          if (fallback === null) {
            yield* Effect.logWarning("trend presentation hit a usage limit; no fallback left", {
              instanceId: first.instanceId,
              model: first.model,
            });
            return yield* error;
          }
          yield* Effect.logWarning("trend presentation hit a usage limit; retrying once", {
            from: { instanceId: first.instanceId, model: first.model },
            to: { instanceId: fallback.instanceId, model: fallback.model },
          });
          return yield* attempt(fallback);
        }),
      ),
    );
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate("generateCommitMessage", input.modelSelection, (service, modelSelection) =>
        service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate("generatePrContent", input.modelSelection, (service, modelSelection) =>
        service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate("generateBranchName", input.modelSelection, (service, modelSelection) =>
        service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate("generateReviewGuide", input.modelSelection, (service, modelSelection) =>
        service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateTrendPresentation: Effect.fn("TextGeneration.generateTrendPresentation")(
      function (input) {
        return generate(
          "generateTrendPresentation",
          input.modelSelection,
          (service, modelSelection) =>
            service.generateTrendPresentation({ ...input, modelSelection }),
        );
      },
    ),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
