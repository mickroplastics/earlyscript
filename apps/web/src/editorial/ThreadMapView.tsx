import type { EditorialVideoState } from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { videoDeveloperToolsHidden } from "../earlyscript/hiddenFeatures";
import { Button } from "../components/ui/button";
import { ACTION_LABEL, formatClock, stageClockMs, interpolateClock } from "./videoThread.logic";
import { mapPanel, type MapStop } from "./threadMap.logic";
import "./threadMap.css";

const STOPS = [1, 2, 3, 4] as const;
const LABELS = ["Leer el tema", "Pedir el borrador", "Revisar el guion", "Decidir"];
export function ThreadMapView({
  video,
  active,
  working = false,
  receivedAtMs,
  nowMs,
  topic,
  script,
  decision,
  result,
  unresolved,
  conversation,
  onRead,
  onRequest,
  onChange,
  onEdit,
  onDecide,
  onToggleCohort,
}: {
  readonly video: EditorialVideoState;
  readonly active: MapStop;
  readonly working?: boolean;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly topic: ReactNode;
  readonly script: ReactNode;
  readonly decision: ReactNode;
  readonly result: ReactNode;
  readonly unresolved: ReactNode;
  readonly conversation: ReactNode;
  readonly onRead: () => void;
  readonly onRequest: () => void;
  readonly onChange: () => void;
  readonly onEdit: () => void;
  readonly onDecide: () => void;
  /** Marks the thread as a trial (kept as evidence, out of Results) or back as human work. */
  readonly onToggleCohort: () => void;
}) {
  const readingPanel = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ active: MapStop; stop: MapStop } | null>(null);
  const stop = selection?.active === active ? selection.stop : active;
  const [tab, setTab] = useState("script");
  const decided = video.decision;
  const storageKey = `earlyscript:map-chat:${video.thread.threadId}`;
  const [chatOpen, setChatOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== "closed";
    } catch {
      return true;
    }
  });
  const toggleChat = (open: boolean) => {
    setChatOpen(open);
    if (!open) setTab("script");
    try {
      localStorage.setItem(storageKey, open ? "open" : "closed");
    } catch {
      /* Storage is optional. */
    }
  };
  const panel = mapPanel(stop, active, decided !== null);
  // Visiting «② Pedir el borrador» once the draft exists shows the script, not the empty state.
  const drafted = active > 2;
  const focusChat = () => {
    toggleChat(true);
    setTab("chat");
    onChange();
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-map-quiet={videoDeveloperToolsHidden()}
      data-testid="thread-map"
      data-stop={stop}
    >
      <style>{`[data-map-quiet="true"] [data-chat-provider-model-picker], [data-map-quiet="true"] [data-composer-shortcut~="composer.effort"] { display: none; }`}</style>
      <header className="space-y-4 border-b p-4">
        <div className="flex flex-wrap justify-between gap-2 pr-16">
          <h1 className="font-semibold">{video.thread.trendTitle ?? "Mapa del video"}</h1>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            {video.thread.cohort === "trial" ? (
              <span className="rounded border px-1.5 text-xs" data-testid="map-trial-badge">
                Ensayo
              </span>
            ) : null}
            Con asistente ·{" "}
            {formatClock(interpolateClock(video.clock, receivedAtMs, nowMs).activeMs)}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={working}
              title="Un ensayo se conserva como evidencia pero no cuenta en Resultados."
              onClick={onToggleCohort}
            >
              {video.thread.cohort === "trial" ? "Quitar marca de ensayo" : "Marcar como ensayo"}
            </Button>
          </span>
        </div>
        <nav aria-label="Mapa del video" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {STOPS.map((n) => (
            <button
              type="button"
              key={n}
              aria-current={n === stop ? "step" : undefined}
              className={`rounded-lg border p-3 text-left text-sm ${n === stop ? "border-primary bg-primary/5" : "text-muted-foreground"}`}
              onClick={() => {
                readingPanel.current?.scrollTo({ top: 0 });
                setTab("script");
                setSelection({ active, stop: n });
                if (n === 4 && !decided) onDecide();
              }}
            >
              <span className="block font-medium">
                {["①", "②", "③", "④"][n - 1]} {LABELS[n - 1]}
              </span>
              <span className="text-xs">
                {decided || n < active ? "Hecha" : n === active ? "Ahora" : "Después"}
                {n === 2
                  ? ""
                  : ` · ${formatClock(stageClockMs(video.clock, n === 1 ? "read" : n === 3 ? "write" : "decide", receivedAtMs, nowMs))}`}
              </span>
            </button>
          ))}
        </nav>
        <p className="text-sm">
          {decided
            ? `Decidido: ${ACTION_LABEL[decided.action]} · utilidad ${decided.utility} de 5 · ${decided.durations.totalMs === null ? "Tiempo pendiente" : formatClock(decided.durations.totalMs)} en total.`
            : stop === 1
              ? "Lee de qué va el tema y por qué está aquí."
              : stop === 2
                ? drafted
                  ? "El borrador ya está escrito. Sigue en «Revisar el guion»."
                  : working
                    ? "El asistente está escribiendo el borrador."
                    : "Prepara la petición y envíala desde la conversación para pedir el borrador."
                : stop === 3
                  ? "Lee el guion. Si quieres cambios, díselos al asistente o edítalo tú."
                  : "Decide qué hacer con este guion."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" aria-expanded={chatOpen} onClick={() => toggleChat(!chatOpen)}>
            {chatOpen ? "Plegar conversación" : "Abrir conversación"}
          </Button>
          {decided ? null : stop === 1 ? (
            <Button
              onClick={() => {
                setSelection({ active, stop: 2 });
                onRead();
              }}
            >
              Ya lo leí, pedir el borrador
            </Button>
          ) : stop === 2 && drafted ? (
            <Button variant="outline" onClick={() => setSelection({ active, stop: 3 })}>
              Ver el guion
            </Button>
          ) : stop === 2 ? (
            <Button
              disabled={working}
              onClick={() => {
                toggleChat(true);
                setTab("chat");
                onRequest();
              }}
            >
              Pedir un borrador
            </Button>
          ) : stop === 3 ? (
            <>
              <Button onClick={focusChat}>Pedir un cambio</Button>
              <Button variant="outline" onClick={onEdit}>
                Editar yo mismo
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSelection({ active, stop: 4 });
                  onDecide();
                }}
              >
                Decidir →
              </Button>
            </>
          ) : null}
        </div>
        {unresolved}
      </header>
      <div
        className="flex gap-2 border-b p-2 lg:hidden"
        role="tablist"
        aria-label="Panel del video"
      >
        <button role="tab" aria-selected={tab === "script"} onClick={() => setTab("script")}>
          Guion
        </button>
        <button
          role="tab"
          aria-selected={tab === "chat"}
          onClick={() => {
            toggleChat(true);
            setTab("chat");
          }}
        >
          Conversación
        </button>
      </div>
      <div className={`grid min-h-0 flex-1 ${chatOpen ? "lg:grid-cols-2" : ""}`}>
        <div
          key={stop}
          ref={readingPanel}
          data-testid="map-reading-panel"
          className={`${tab === "script" ? "flex" : "hidden"} min-h-0 flex-col gap-5 overflow-auto border-r p-5 lg:flex`}
        >
          {panel === "topic" ? (
            topic
          ) : panel === "empty" ? (
            <p className="text-muted-foreground">
              Todavía no hay guion. Aparecerá aquí cuando el asistente lo escriba.
            </p>
          ) : panel === "decision" ? (
            <>
              {decision}
              {decided ? (
                <details>
                  <summary className="cursor-pointer font-medium">
                    Métricas del video publicado
                  </summary>
                  {result}
                </details>
              ) : null}
              <section className="space-y-4" aria-label="Guion evaluado">
                <h2 className="font-semibold">
                  {decided ? "Guion de la versión decidida" : "Guion evaluado"}
                </h2>
                {script}
              </section>
            </>
          ) : (
            script
          )}
        </div>
        <div
          data-map-conversation
          style={chatOpen ? undefined : { display: "none" }}
          className={`${chatOpen ? (tab === "chat" ? "flex lg:flex" : "hidden lg:flex") : "hidden"} min-h-0 min-w-0 flex-col`}
        >
          <h2 className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
            CONVERSACIÓN CON EL ASISTENTE
          </h2>
          {conversation}
        </div>
      </div>
    </div>
  );
}
