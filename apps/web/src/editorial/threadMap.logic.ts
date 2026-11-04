import { parseScript } from "@earlyscript/editorial-script";
import type { EditorialEvidenceItem, EditorialVideoState } from "@t3tools/contracts";

export type MapStop = 1 | 2 | 3 | 4;
export function activeMapStop(
  video: EditorialVideoState,
  contents: string,
  requested: boolean,
): MapStop {
  if (video.decision !== null) return 4;
  if (video.clock.state._tag !== "idle" && video.clock.state.stage === "decide") return 4;
  if (parseScript(contents).sections.some((s) => s.kind !== "sources" && s.paragraphs.length > 0))
    return 3;
  if (requested || (video.clock.state._tag !== "idle" && video.clock.state.stage === "write"))
    return 2;
  return 1;
}

export function mapScript(contents: string, evidence: readonly EditorialEvidenceItem[]) {
  const ast = parseScript(contents);
  const sections = ast.sections.filter((s) => s.kind !== "sources");
  const citations = ast.citations.filter((c) =>
    sections.some((s) =>
      s.paragraphs.some((p) => c.line >= p.line && c.line < p.line + p.text.split("\n").length),
    ),
  );
  const ids = [...new Set(citations.map((c) => c.id))];
  return {
    sections,
    citations,
    sources: ids.map((id, index) => ({
      id,
      number: index + 1,
      evidence: evidence.find((e) => e.itemId === id) ?? null,
    })),
  };
}

/** The selected stop determines the panel even after a final decision. */
export function mapPanel(stop: MapStop, active: MapStop, decided: boolean) {
  if (stop === 1) return "topic";
  if (stop === 4) return "decision";
  if (stop === 2 && active <= 2 && !decided) return "empty";
  return "script";
}
