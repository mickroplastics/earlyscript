import { useState } from "react";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useThreadAreaLocale } from "../locale/ShellLocale";
import { ScriptView } from "./ScriptView";

function LocalizedScript() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useThreadAreaLocale(root, true);
  return (
    <div ref={setRoot}>
      <span>Close</span>
      <div data-timeline-row-id="timestamp">
        <p data-slot="tooltip-trigger" className="tabular-nums">
          yesterday at 7:54 PM
        </p>
        <p data-thread-find-text>yesterday at 7:54 PM</p>
      </div>
      <ScriptView
        contents={"# Close\n\nA final sentence without evidence."}
        sources={[]}
        notices={[]}
        uncited={new Set()}
        activeNoticeLine={null}
        highlightSource={null}
        activeCitationKey={null}
        onOpenSource={() => {}}
      />
    </div>
  );
}

it("translates shell controls without translating the script", async () => {
  await using screen = await render(<LocalizedScript />);
  await expect.element(screen.getByText("ayer, 19:54", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("yesterday at 7:54 PM", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Cerrar", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Close", exact: true })).toBeVisible();
});
