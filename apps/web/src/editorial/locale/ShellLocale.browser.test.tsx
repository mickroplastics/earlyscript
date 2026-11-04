import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { WorkingTimelineRow } from "../../components/chat/TimelineWorkGroupRows";
import {
  TimelineRowActivityCtx,
  type TimelineRowActivityState,
} from "../../components/chat/timelineRowContext";
import { makeTranslator, useScopedLocale, type ScopedLocaleOptions } from "./scopedLocale";
import {
  SIDEBAR_LOCALE,
  THREAD_LOCALE,
  useSidebarLocale,
  useThreadAreaLocale,
} from "./ShellLocale";

/** Counts every MutationObserver callback the page runs while `body` executes. */
async function countObserverCallbacks(body: () => Promise<void>): Promise<number> {
  const Native = window.MutationObserver;
  let callbacks = 0;
  window.MutationObserver = class extends Native {
    constructor(callback: MutationCallback) {
      super((records, observer) => {
        callbacks += 1;
        if (callbacks > 500) {
          observer.disconnect();
          return;
        }
        callback(records, observer);
      });
    }
  };
  try {
    await body();
  } finally {
    window.MutationObserver = Native;
  }
  return callbacks;
}

/** The shape of upstream's sidebar: the editorial wrapper inside `[data-app-sidebar]`. */
const NO_ANCHOR = { current: null };

function SidebarDouble({
  rows = 1,
  localized = true,
}: {
  readonly rows?: number;
  readonly localized?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  useSidebarLocale(localized ? anchor : NO_ANCHOR);
  return (
    <>
      <nav data-app-sidebar="" aria-label="Threads" data-testid="sidebar">
        <div ref={anchor} className="contents">
          <input aria-label="Search threads" placeholder="Search" defaultValue="Settled" />
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} data-thread-item="" data-testid={`row-${index}`}>
              {/* Thread titles are user text: upstream marks them with `dir`. */}
              <span dir="auto">Settled</span>
              <span className="sr-only">Settled</span>
              <span data-testid={`time-${index}`}>42m</span>
              <button type="button" aria-label="Snooze thread">
                Settle
              </button>
            </div>
          ))}
          <span data-testid="section">Settled</span>
          {/* As `EditorialSidebar.tsx`: upstream's header, the trend list, upstream's footer. */}
          <div data-editorial-space="trends">
            <div>
              <a href="/" aria-label="Go to threads" data-testid="trends-header">
                Earlyscript
              </a>
            </div>
            <div>
              <span data-testid="trend">Settled</span>
            </div>
            <div>
              <button type="button" aria-label="Settings" data-testid="trends-footer" />
            </div>
          </div>
        </div>
      </nav>
      <div data-sidebar-control="">
        <button type="button" aria-label="Toggle main sidebar" />
      </div>
      <p data-testid="outside">Settled</p>
    </>
  );
}

function ThreadDouble({ mode }: { readonly mode?: string }) {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  useThreadAreaLocale(area);
  return (
    <div ref={setArea} className="contents" data-testid="thread" data-editorial-thread-mode={mode}>
      <p>Send a message to start the conversation.</p>
      <div data-timeline-row-id="message-1">
        <p data-testid="message">Settled</p>
      </div>
      {/* Rows as upstream renders them: its own words around the message bodies. */}
      <div data-timeline-row-id="message-2" data-timeline-row-kind="message">
        <h3 data-testid="author">You</h3>
        <div data-user-message-body="true" data-thread-find-text="true">
          <p data-testid="user-body">Done</p>
        </div>
        <button type="button" data-slot="tooltip-trigger" aria-label="Copy message" />
      </div>
      <div data-timeline-row-id="turn-fold:1" data-timeline-row-kind="turn-fold">
        <button type="button">
          <span data-testid="fold">Worked for 35s</span>
        </button>
      </div>
      <div data-timeline-row-id="message-3" data-timeline-row-kind="message">
        <div data-thread-find-text="true">
          <h3 data-testid="agent-heading">Done</h3>
          <button type="button" data-slot="tooltip-trigger" aria-label="Copy message">
            Copy
          </button>
        </div>
      </div>
      <div contentEditable suppressContentEditableWarning aria-label="Message New thread">
        Settled
      </div>
      <div>Ask anything. @ files, $ skills, / commands</div>
    </div>
  );
}

const WORKING_NOW = new Date("2026-11-04T12:00:10.000Z");

const WORKING_ACTIVITY: TimelineRowActivityState = {
  isWorking: true,
  isCompacting: false,
  isRevertingCheckpoint: false,
  awaitingUser: false,
  isPreparingWorktree: false,
  latestRunId: null,
  backgroundWorktreeSetup: null,
};

/** The thread area with upstream's running-turn row, as `MessagesTimeline` wraps it. */
function WorkingDouble({ createdAt }: { readonly createdAt: string | null }) {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  useThreadAreaLocale(area);
  return (
    <div ref={setArea} className="contents" data-testid="thread">
      <TimelineRowActivityCtx value={WORKING_ACTIVITY}>
        <div data-timeline-row-id="working-indicator-row" data-timeline-row-kind="working">
          <WorkingTimelineRow row={{ kind: "working", id: "working-indicator-row", createdAt }} />
        </div>
      </TimelineRowActivityCtx>
    </div>
  );
}

/** Ends a batch: the observer's microtask was queued by the first mutation, so it runs first. */
const endBatch = () => Promise.resolve();

describe("shell locale scopes", () => {
  it("translates the sidebar and its toggle, keeps user text, and restores on unmount", async () => {
    let screen: Awaited<ReturnType<typeof render>> | undefined;
    const callbacks = await countObserverCallbacks(async () => {
      screen = await render(<SidebarDouble />);
      const root = screen.getByTestId("sidebar").element();
      await vi.waitFor(() =>
        expect(screen!.getByTestId("section").element().textContent).toBe("Resueltos"),
      );
      // Nodes React adds later, and a minute tick rewriting the time in place.
      const added = ["Pinned", "Unknown upstream text", "Snoozed"].map((label) => {
        const span = root.appendChild(document.createElement("span"));
        span.textContent = label;
        return span;
      });
      await vi.waitFor(() => expect(added[2]!.textContent).toBe("Pospuestos"));
      expect(added[0]!.textContent).toBe("Fijados");
      expect(added[1]!.textContent).toBe("Unknown upstream text");
      screen.getByTestId("time-0").element().firstChild!.nodeValue = "43m";
      await vi.waitFor(() =>
        expect(screen!.getByTestId("time-0").element().textContent).toBe("43 min"),
      );
      // Upstream's context menu: built by hand, appended to body, focus moved into it at once.
      root
        .querySelector("[data-thread-item]")!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const menu = document.body.appendChild(document.createElement("div"));
      menu.tabIndex = -1;
      menu.innerHTML = "<button>Pin thread</button><button>Delete</button>";
      menu.focus();
      await vi.waitFor(() => expect(menu.textContent).toBe("Fijar el hiloBorrar"));
      // A portal opened after a press elsewhere is not the sidebar's.
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const other = document.body.appendChild(document.createElement("div"));
      other.textContent = "Delete";
      const marker = root.appendChild(document.createElement("span"));
      marker.textContent = "Working";
      await vi.waitFor(() => expect(marker.textContent).toBe("En curso"));
      expect(other.textContent).toBe("Delete");
      // The app's toast viewport mounts after the sidebar: titles in Spanish, descriptions
      // (which can carry the server's words) as sent.
      const portal = document.body.appendChild(document.createElement("div"));
      portal.innerHTML =
        '<div data-slot="toast-viewport"><h2 data-slot="toast-title">Path copied</h2>' +
        '<p data-slot="toast-description">Path copied</p></div>';
      await vi.waitFor(() => expect(portal.querySelector("h2")!.textContent).toBe("Ruta copiada"));
      expect(portal.querySelector("p")!.textContent).toBe("Path copied");
      const later = portal.firstElementChild!.appendChild(document.createElement("h2"));
      later.textContent = "Failed to copy path";
      await vi.waitFor(() => expect(later.textContent).toBe("No se copió la ruta"));
      for (const node of [...added, marker, menu, other, portal]) node.remove();
    });
    // A handful of batches, not a loop.
    expect(callbacks).toBeLessThanOrEqual(14);

    const view = screen!;
    const row = view.getByTestId("row-0").element();
    expect(row.querySelector("[dir]")!.textContent).toBe("Settled");
    expect(row.querySelector(".sr-only")!.textContent).toBe("Settled");
    expect(row.querySelector("button")!.textContent).toBe("Resolver");
    expect(row.querySelector("button")!.getAttribute("aria-label")).toBe("Posponer el hilo");
    expect(view.getByTestId("trend").element().textContent).toBe("Settled");
    expect(view.getByTestId("trends-header").element().getAttribute("aria-label")).toBe(
      "Ir a los hilos",
    );
    expect(view.getByTestId("trends-footer").element().getAttribute("aria-label")).toBe("Ajustes");
    expect(view.getByTestId("outside").element().textContent).toBe("Settled");
    const input = view.getByTestId("sidebar").element().querySelector("input")!;
    expect(input.placeholder).toBe("Buscar");
    expect(input.value).toBe("Settled");
    const toggle = document.querySelector("[data-sidebar-control] button")!;
    expect(toggle.getAttribute("aria-label")).toBe("Mostrar u ocultar la barra lateral");
    const nav = view.getByTestId("sidebar").element();
    expect(nav.getAttribute("aria-label")).toBe("Hilos");

    const section = view.getByTestId("section").element();
    await view.unmount();
    expect(section.textContent).toBe("Settled");
    expect(input.placeholder).toBe("Search");
    expect(toggle.getAttribute("aria-label")).toBe("Toggle main sidebar");
  });

  it("leaves messages and the editor alone while an agent streams", async () => {
    await using screen = await render(<ThreadDouble />);
    const thread = screen.getByTestId("thread").element();
    await vi.waitFor(() =>
      expect(thread.firstElementChild!.textContent).toBe(
        "Escribe un mensaje para empezar la conversación.",
      ),
    );
    expect(thread.lastElementChild!.textContent).toBe(
      "Pregunta lo que quieras. @ archivos, $ habilidades, / órdenes",
    );
    const message = screen.getByTestId("message").element();
    const editor = thread.querySelector("[contenteditable]")!;
    expect(message.textContent).toBe("Settled");
    expect(editor.textContent?.trim()).toBe("Settled");
    expect(editor.getAttribute("aria-label")).toBe("Message New thread");

    // An agent streaming 120 batches into a message, ten nodes each.
    const text = message.appendChild(document.createTextNode(""));
    for (let batch = 0; batch < 120; batch += 1) {
      for (let token = 0; token < 10; token += 1) {
        text.nodeValue = `${text.nodeValue ?? ""} Settled`;
        message.appendChild(document.createElement("span")).textContent = "Delete";
      }
      await endBatch();
    }
    expect(
      [...message.querySelectorAll("span")].every((span) => span.textContent === "Delete"),
    ).toBe(true);
    expect(text.nodeValue?.startsWith(" Settled Settled")).toBe(true);
  });

  it("translates upstream's words in timeline rows and leaves the message bodies", async () => {
    await using screen = await render(<ThreadDouble />);
    await vi.waitFor(() => expect(screen.getByTestId("author").element().textContent).toBe("Tú"));
    expect(screen.getByTestId("fold").element().textContent).toBe("Trabajó durante 35s");
    const thread = screen.getByTestId("thread").element();
    const rowButton = thread.querySelector('[data-timeline-row-id="message-2"] > button')!;
    expect(rowButton.getAttribute("aria-label")).toBe("Copiar el mensaje");
    // What the operator and the agent wrote, headings and buttons inside it included.
    expect(screen.getByTestId("user-body").element().textContent).toBe("Done");
    expect(screen.getByTestId("agent-heading").element().textContent).toBe("Done");
    const bodyButton = thread.querySelector('[data-timeline-row-id="message-3"] button')!;
    expect(bodyButton.getAttribute("aria-label")).toBe("Copy message");
    expect(bodyButton.textContent).toBe("Copy");
    expect(screen.getByTestId("message").element().textContent).toBe("Settled");
    // A fold that updates in place stays in Spanish.
    screen.getByTestId("fold").element().firstChild!.nodeValue = "Worked for 1m 2s";
    await vi.waitFor(() =>
      expect(screen.getByTestId("fold").element().textContent).toBe("Trabajó durante 1m 2s"),
    );
  });

  it("translates the running turn's indicator as upstream renders it, timer apart", async () => {
    using _timers = fakeTimers();
    vi.setSystemTime(WORKING_NOW);
    // Upstream's own row (`WorkingTimelineRow`) inside the row wrapper of `MessagesTimeline`:
    // «Working for » is a text node and the timer a sibling span that ticks every second.
    await using screen = await render(<WorkingDouble createdAt="2026-11-04T12:00:03.000Z" />);
    const row = screen.getByTestId("thread").element();
    const timer = row.querySelector('[data-timeline-row-kind="working"] span.tabular-nums')!;
    const label = timer.parentElement!;
    await act(async () => {
      await endBatch();
    });
    expect(label.firstChild!.nodeValue).toBe("Trabajando desde hace ");
    expect(timer.textContent).toBe("7s");
    // The timer keeps ticking in upstream's format; the words stay in Spanish.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(timer.textContent).toBe("9s");
    expect(label.textContent).toBe("Trabajando desde hace 9s");
  });

  it("translates the running turn's indicator before its start time is known", async () => {
    await using screen = await render(<WorkingDouble createdAt={null} />);
    const row = screen.getByTestId("thread").element();
    await vi.waitFor(() =>
      expect(row.querySelector('[data-timeline-row-kind="working"]')!.textContent).toBe(
        "Trabajando…",
      ),
    );
  });

  it("runs at most once per batch while content streams into a scope", async () => {
    let fresh: Awaited<ReturnType<typeof render>> | undefined;
    let callbacks = 0;
    callbacks = await countObserverCallbacks(async () => {
      fresh = await render(<ThreadDouble />);
      const message = fresh.getByTestId("message").element();
      await endBatch();
      for (let frame = 0; frame < 60; frame += 1) {
        for (let token = 0; token < 10; token += 1) {
          message.appendChild(document.createElement("span")).textContent = "Settled";
        }
        await endBatch();
      }
      expect(message.lastElementChild!.textContent).toBe("Settled");
    });
    // One per frame at most (plus mount), never one per mutation.
    expect(callbacks).toBeLessThanOrEqual(62);
    await fresh!.unmount();
  });

  it("walks a 500-row sidebar once on mount and writes only what it knows", async () => {
    let view: Awaited<ReturnType<typeof render>> | undefined;
    const callbacks = await countObserverCallbacks(async () => {
      view = await render(<SidebarDouble rows={500} />);
      await vi.waitFor(() =>
        expect(view!.getByTestId("time-499").element().textContent).toBe("42 min"),
      );
      await endBatch();
    });
    // The mount translates synchronously in the effect; React's own commits are the only batches.
    expect(callbacks).toBeLessThanOrEqual(2);
    const rows = view!.getByTestId("sidebar").element().querySelectorAll("[data-thread-item]");
    expect([...rows].every((row) => row.querySelector("[dir]")!.textContent === "Settled")).toBe(
      true,
    );
    await view!.unmount();
  });
  it("restores upstream's latest value, not the first one it translated", async () => {
    const target = document.body.appendChild(document.createElement("div"));
    target.innerHTML = '<span>Delete</span><input title="Delete" aria-label="Delete">';
    const options: ScopedLocaleOptions = {
      translate: makeTranslator([
        { text: { Delete: "Borrar", Settings: "Ajustes", Copy: "Copiar" } },
      ]),
      roots: () => [target],
    };
    function Harness() {
      useScopedLocale(target, options);
      return null;
    }
    const text = target.querySelector("span")!.firstChild as Text;
    const input = target.querySelector("input")!;
    const view = await render(<Harness />);
    await vi.waitFor(() => expect(text.nodeValue).toBe("Borrar"));
    expect(input.title).toBe("Borrar");
    // Two upstream changes between known keys, then one to a string no table knows.
    for (const [english, spanish] of [
      ["Settings", "Ajustes"],
      ["Copy", "Copiar"],
    ] as const) {
      text.nodeValue = english;
      input.title = english;
      input.setAttribute("aria-label", english);
      await vi.waitFor(() => expect(text.nodeValue).toBe(spanish));
      expect(input.title).toBe(spanish);
      expect(input.getAttribute("aria-label")).toBe(spanish);
    }
    input.setAttribute("aria-label", "Something new");
    await endBatch();
    await view.unmount();
    expect(text.nodeValue).toBe("Copy");
    expect(input.title).toBe("Copy");
    expect(input.getAttribute("aria-label")).toBe("Something new");
    target.remove();
  });

  it("translates an ordinary thread too, and leaves no observer once unmounted", async () => {
    const Native = window.MutationObserver;
    let active = 0;
    window.MutationObserver = class extends Native {
      #observing = false;
      override observe(target: Node, options?: MutationObserverInit) {
        if (!this.#observing) active += 1;
        this.#observing = true;
        super.observe(target, options);
      }
      override disconnect() {
        if (this.#observing) active -= 1;
        this.#observing = false;
        super.disconnect();
      }
    };
    try {
      const view = await render(<ThreadDouble mode="other" />);
      const thread = view.getByTestId("thread").element();
      // The whole shell is Earlyscript's: an ordinary (non-editorial) thread is in Spanish too.
      await vi.waitFor(() =>
        expect(thread.firstElementChild!.textContent).toBe(
          "Escribe un mensaje para empezar la conversación.",
        ),
      );
      expect(active).toBe(1);
      await view.unmount();
      expect(active).toBe(0);
    } finally {
      window.MutationObserver = Native;
    }
  });
  describe("authorship by mutation records, not by value", () => {
    const options: ScopedLocaleOptions = {
      translate: makeTranslator([{ text: { Delete: "Borrar", Settings: "Ajustes" } }]),
      roots: (anchor) => [anchor],
    };
    async function mountTarget() {
      const target = document.body.appendChild(document.createElement("div"));
      target.innerHTML = '<span>Delete</span><button title="Delete" aria-label="Delete"></button>';
      function Harness() {
        useScopedLocale(target, options);
        return null;
      }
      const view = await render(<Harness />);
      const text = target.querySelector("span")!.firstChild as Text;
      const button = target.querySelector("button")!;
      await vi.waitFor(() => expect(text.nodeValue).toBe("Borrar"));
      expect(button.title).toBe("Borrar");
      expect(button.getAttribute("aria-label")).toBe("Borrar");
      return { target, view, text, button };
    }
    const writeAll = (text: Text, button: HTMLButtonElement, value: string) => {
      text.nodeValue = value;
      button.title = value;
      button.setAttribute("aria-label", value);
    };

    it("keeps an external write equal to its own translation (Sol's case c)", async () => {
      const { target, view, text, button } = await mountTarget();
      writeAll(text, button, "Borrar");
      await endBatch();
      await view.unmount();
      expect(text.nodeValue).toBe("Borrar");
      expect(button.title).toBe("Borrar");
      expect(button.getAttribute("aria-label")).toBe("Borrar");
      target.remove();
    });

    it("translates again after an external English write, and restores it", async () => {
      const { target, view, text, button } = await mountTarget();
      writeAll(text, button, "Borrar");
      await endBatch();
      writeAll(text, button, "Delete");
      await vi.waitFor(() => expect(text.nodeValue).toBe("Borrar"));
      expect(button.title).toBe("Borrar");
      expect(button.getAttribute("aria-label")).toBe("Borrar");
      await view.unmount();
      expect(text.nodeValue).toBe("Delete");
      expect(button.title).toBe("Delete");
      expect(button.getAttribute("aria-label")).toBe("Delete");
      target.remove();
    });

    it("reads a batch once per node: several writes, a move and a re-add", async () => {
      const { target, view, text, button } = await mountTarget();
      const span = text.parentElement!;
      // One batch: two external writes on the same text, then upstream moves the node.
      text.nodeValue = "Settings";
      text.nodeValue = "Borrar";
      button.title = "Settings";
      button.title = "Borrar";
      target.appendChild(span);
      await endBatch();
      expect(text.nodeValue).toBe("Borrar");
      expect(button.title).toBe("Borrar");
      // A move alone is not a write: the node holding our translation stays ours.
      text.nodeValue = "Delete";
      await vi.waitFor(() => expect(text.nodeValue).toBe("Borrar"));
      target.insertBefore(span, button);
      await endBatch();
      await view.unmount();
      expect(text.nodeValue).toBe("Delete");
      expect(button.title).toBe("Borrar");
      target.remove();
    });

    it("keeps a write made just before unmounting, still undelivered", async () => {
      const { target, view, text, button } = await mountTarget();
      writeAll(text, button, "Borrar");
      await view.unmount();
      expect(text.nodeValue).toBe("Borrar");
      expect(button.title).toBe("Borrar");
      target.remove();
    });

    it("stays bounded through 200 fast alternations", async () => {
      let mounted: Awaited<ReturnType<typeof mountTarget>> | undefined;
      const callbacks = await countObserverCallbacks(async () => {
        mounted = await mountTarget();
        for (let index = 0; index < 200; index += 1) {
          writeAll(mounted.text, mounted.button, index % 2 === 0 ? "Settings" : "Delete");
          await endBatch();
        }
      });
      const { target, view, text, button } = mounted!;
      // One callback per batch at most, never one per own write.
      expect(callbacks).toBeLessThanOrEqual(202);
      expect(text.nodeValue).toBe("Borrar");
      expect(button.title).toBe("Borrar");
      await view.unmount();
      expect(text.nodeValue).toBe("Delete");
      expect(button.getAttribute("aria-label")).toBe("Delete");
      target.remove();
    });
  });
  describe("a scope restores only what it still observes", () => {
    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    // The real sidebar and thread scopes, their roots narrowed to two test containers.
    const scopeA: ScopedLocaleOptions = { ...SIDEBAR_LOCALE, roots: () => [containerA] };
    const scopeB: ScopedLocaleOptions = { ...THREAD_LOCALE, roots: () => [containerB] };
    function ScopeA() {
      useScopedLocale(containerA, scopeA);
      return null;
    }
    function ScopeB() {
      useScopedLocale(containerB, scopeB);
      return null;
    }
    const press = (target: Element) =>
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const makePortal = () => {
      const portal = document.createElement("div");
      portal.innerHTML = '<span>Delete</span><button title="Delete" aria-label="Delete"></button>';
      return {
        portal,
        text: portal.querySelector("span")!.firstChild as Text,
        button: portal.querySelector("button")!,
      };
    };
    const values = (text: Text, button: HTMLButtonElement) => [
      text.nodeValue,
      button.title,
      button.getAttribute("aria-label"),
    ];
    async function mountBoth() {
      document.body.append(containerA, containerB);
      const a = await render(<ScopeA />);
      const b = await render(<ScopeB />);
      return { a, b };
    }
    const cleanUp = (...nodes: Element[]) => {
      for (const node of [containerA, containerB, ...nodes]) node.remove();
      containerA.replaceChildren();
      containerB.replaceChildren();
    };

    it("keeps upstream's Spanish when a portal moves from A to B and back to body", async () => {
      const { a, b } = await mountBoth();
      const { portal, text, button } = makePortal();
      press(containerA);
      document.body.append(portal);
      await vi.waitFor(() => expect(values(text, button)).toEqual(["Borrar", "Borrar", "Borrar"]));
      containerB.append(portal);
      await endBatch();
      press(containerB);
      document.body.append(portal);
      await endBatch();
      text.nodeValue = "Borrar";
      button.title = "Borrar";
      button.setAttribute("aria-label", "Borrar");
      await endBatch();
      await a.unmount();
      expect(values(text, button)).toEqual(["Borrar", "Borrar", "Borrar"]);
      await endBatch();
      await b.unmount();
      expect(values(text, button)).toEqual(["Borrar", "Borrar", "Borrar"]);
      cleanUp(portal);
    });

    it("leaves a portal nobody adopts as it is, and never touches it again", async () => {
      const { a, b } = await mountBoth();
      const { portal, text, button } = makePortal();
      press(containerA);
      document.body.append(portal);
      await vi.waitFor(() => expect(text.nodeValue).toBe("Borrar"));
      // A press elsewhere, then out of body into a plain container no scope observes.
      press(document.body);
      const elsewhere = document.body.appendChild(document.createElement("section"));
      elsewhere.append(portal);
      await endBatch();
      button.title = "Settings";
      await endBatch();
      await a.unmount();
      await b.unmount();
      // Still translated where A left it, upstream's later write untouched.
      expect(values(text, button)).toEqual(["Borrar", "Settings", "Borrar"]);
      cleanUp(elsewhere);
    });

    it("forgets a node that leaves the DOM; it is new to the scope when it returns", async () => {
      const { a, b } = await mountBoth();
      const { portal: row, text, button } = makePortal();
      containerA.append(row);
      await vi.waitFor(() => expect(text.nodeValue).toBe("Borrar"));
      row.remove();
      await endBatch();
      // Back with what A wrote: A cannot tell it from upstream's Spanish, so it keeps it.
      containerA.append(row);
      await endBatch();
      // Out again, upstream writes English while nobody watches, and it returns.
      row.remove();
      await endBatch();
      text.nodeValue = "Delete";
      containerA.append(row);
      await vi.waitFor(() => expect(text.nodeValue).toBe("Borrar"));
      await a.unmount();
      expect(text.nodeValue).toBe("Delete");
      expect(button.title).toBe("Borrar");
      await b.unmount();
      cleanUp();
    });
  });
});
