import { useState } from "react";
import { useThreadAreaLocale } from "./locale/ShellLocale";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { ThreadMapView } from "./ThreadMapView";
import { ThreadMapScript } from "./ThreadMapScript";
import { WRITING } from "./videoThread.fixture";
it("keeps the conversation mounted while visiting completed stops and requesting changes", async () => {
  const change = vi.fn();
  await using screen = await render(
    <ThreadMapView
      video={WRITING}
      active={3}
      receivedAtMs={0}
      nowMs={0}
      topic={<p>Tema de prueba</p>}
      script={
        <ThreadMapScript
          contents={"# Hook\n\nA claim with source [itm_hn_missing]."}
          evidence={[]}
        />
      }
      decision={<p>Decisión</p>}
      result={null}
      unresolved={null}
      conversation={<textarea aria-label="Conversación" defaultValue="Cambio pendiente" />}
      onRead={vi.fn()}
      onRequest={vi.fn()}
      onChange={change}
      onEdit={vi.fn()}
      onDecide={vi.fn()}
    />,
  );
  await expect.element(screen.getByRole("link", { name: "Fuente 1" })).toBeVisible();
  await screen.getByRole("button", { name: /① Leer el tema/ }).click();
  await expect.element(screen.getByText("Tema de prueba")).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "Conversación" }))
    .toHaveValue("Cambio pendiente");
  await screen.getByRole("button", { name: /③ Revisar/ }).click();
  await screen.getByRole("button", { name: "Pedir un cambio" }).click();
  expect(change).toHaveBeenCalledOnce();
});

function LocalizedScript() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useThreadAreaLocale(root, true);
  return (
    <div ref={setRoot}>
      <span>Close</span>
      <ThreadMapScript contents={"# Close\n\nA final sentence without evidence."} evidence={[]} />
    </div>
  );
}
it("translates shell controls without translating the script", async () => {
  await using screen = await render(<LocalizedScript />);
  await expect.element(screen.getByText("Cerrar", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Close", exact: true })).toBeVisible();
});
