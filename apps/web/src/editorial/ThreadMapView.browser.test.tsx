import { useState } from "react";
import { useThreadAreaLocale } from "./locale/ShellLocale";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { ThreadMapView } from "./ThreadMapView";
import { ThreadMapScript } from "./ThreadMapScript";
import { WRITING, DECIDED } from "./videoThread.fixture";
it("keeps the conversation mounted while visiting completed stops and requesting changes", async () => {
  localStorage.clear();
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
      onToggleCohort={vi.fn()}
    />,
  );
  await expect.element(screen.getByRole("link", { name: "Fuente 1" })).toBeVisible();
  await screen.getByRole("button", { name: /① Leer el tema/ }).click();
  await expect.element(screen.getByText("Tema de prueba")).toBeVisible();
  await expect.element(screen.getByLabelText("Conversación")).toHaveValue("Cambio pendiente");
  await screen.getByRole("button", { name: /③ Revisar/ }).click();
  await screen.getByRole("button", { name: "Plegar conversación" }).click();
  await expect.element(screen.getByLabelText("Conversación")).not.toBeVisible();
  await screen.getByRole("button", { name: "Pedir un cambio" }).click();
  await expect.element(screen.getByLabelText("Conversación")).toBeVisible();
  await expect.element(screen.getByLabelText("Conversación")).toHaveValue("Cambio pendiente");
  expect(change).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: /④ Decidir/ }).click();
  await expect.element(screen.getByText("Decisión", { exact: true })).toBeVisible();
  expect(screen.getByTestId("map-reading-panel").element().firstElementChild?.textContent).toBe(
    "Decisión",
  );
  await screen.getByRole("button", { name: "Plegar conversación" }).click();
  expect(localStorage.getItem(`earlyscript:map-chat:${WRITING.thread.threadId}`)).toBe("closed");
});

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
      <ThreadMapScript contents={"# Close\n\nA final sentence without evidence."} evidence={[]} />
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

it("opens the decision first and returns to the topic after deciding", async () => {
  localStorage.clear();
  await using screen = await render(
    <ThreadMapView
      video={DECIDED}
      active={4}
      receivedAtMs={0}
      nowMs={0}
      topic={<p>Tema conservado</p>}
      script={<p>Guion conservado</p>}
      decision={<p>Registro de decisión</p>}
      result={<input aria-label="Vistas" />}
      unresolved={null}
      conversation={<textarea aria-label="Conversación" />}
      onRead={vi.fn()}
      onRequest={vi.fn()}
      onChange={vi.fn()}
      onEdit={vi.fn()}
      onDecide={vi.fn()}
      onToggleCohort={vi.fn()}
    />,
  );
  await expect.element(screen.getByText("Registro de decisión")).toBeVisible();
  const panel = screen.getByTestId("map-reading-panel").element();
  expect(panel.textContent?.indexOf("Registro de decisión")).toBeLessThan(
    panel.textContent?.indexOf("Guion conservado") ?? 0,
  );
  await expect.element(screen.getByLabelText("Vistas")).not.toBeVisible();
  await screen.getByText("Métricas del video publicado").click();
  await expect.element(screen.getByLabelText("Vistas")).toBeVisible();
  await screen.getByRole("button", { name: /① Leer el tema/ }).click();
  await expect.element(screen.getByText("Tema conservado")).toBeVisible();
  await expect.element(screen.getByText("Guion conservado")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: /④ Decidir/ }).click();
  await expect.element(screen.getByText("Registro de decisión")).toBeVisible();
  await expect.element(screen.getByLabelText("Vistas")).not.toBeVisible();
});
