import type {
  EditorialResultsStage,
  EditorialVideoState,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";

/** The three stages of a manual thread, in work order, as the workspace's selector shows them. */
export const MANUAL_STAGES = ["explore", "write", "decide"] as const;
export type ManualStage = (typeof MANUAL_STAGES)[number];

export const MANUAL_STAGE_LABEL: Readonly<Record<ManualStage, string>> = {
  explore: "Explorar",
  write: "Escribir",
  decide: "Decidir",
};

const isManualStage = (stage: EditorialResultsStage): stage is ManualStage =>
  (MANUAL_STAGES as ReadonlyArray<string>).includes(stage);

/**
 * The stage the workspace shows: Decidir once decided, else the clock's stage, else the last
 * stage the clock recorded (a stopped clock after a restart), else Explorar.
 */
export function manualStageOf(video: EditorialVideoState): ManualStage {
  if (video.decision !== null) return "decide";
  const { state, stages } = video.clock;
  if (state._tag !== "idle" && isManualStage(state.stage)) return state.stage;
  const last = stages.findLast((entry) => isManualStage(entry.stage))?.stage;
  return last !== undefined && isManualStage(last) ? last : "explore";
}

/** The page a capture takes: the active tab's address and title once it has started loading. */
export interface CapturablePage {
  readonly url: string;
  readonly title: string;
}

export function capturablePageOf(snapshot: PreviewSessionSnapshot | null): CapturablePage | null {
  if (snapshot === null) return null;
  const { navStatus } = snapshot;
  if (navStatus._tag === "Idle" || !/^https?:\/\//i.test(navStatus.url)) return null;
  return { url: navStatus.url, title: navStatus.title.trim() };
}

/** `news.ycombinator.com`, without `www.`; the raw text when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Sites the operator usually goes through by hand, offered while no page is open. */
export const USUAL_SITES: ReadonlyArray<string> = [
  "https://x.com/",
  "https://news.ycombinator.com/",
  "https://github.com/trending",
  "https://www.threads.net/",
];
