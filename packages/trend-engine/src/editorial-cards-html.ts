// The blind labelling page: one self-contained HTML file (no network, no dependencies) that
// shows one card at a time, saves answers in localStorage and exports labels.json. Interface in
// Spanish; headlines stay in their original language. Topic and item cards share the page.

export interface CardsPageMeta {
  readonly setName: string;
  readonly title: string;
  readonly cardsHash: string;
  readonly universeHash: string | null;
}

export const LABELS_SCHEMA_VERSION = "earlyscript.editorial-labels/1";
export const TOPIC_QUESTION = "¿SingulariDev haría un video sobre este tema en los próximos 7 días?";
export const ITEM_QUESTION = "¿Este ítem trata algo sobre lo que SingulariDev haría un video?";

/** JSON safe inside a <script> element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function renderCardsHtml(cards: ReadonlyArray<unknown>, meta: CardsPageMeta): string {
  const data = {
    schema_version: LABELS_SCHEMA_VERSION,
    set_name: meta.setName,
    cards_hash: meta.cardsHash,
    universe_hash: meta.universeHash,
    questions: { topic: TOPIC_QUESTION, item: ITEM_QUESTION },
    cards,
  };
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
:root { --bg:#f7f7f5; --card:#fff; --fg:#1d1d1f; --muted:#6b6b70; --line:#e2e2e0; --accent:#2f6fed; --yes:#1f8a4c; --no:#c0392b; --unsure:#8a6d1f; }
@media (prefers-color-scheme: dark) { :root { --bg:#161617; --card:#202022; --fg:#ececee; --muted:#9a9aa0; --line:#333336; --accent:#6d9bff; --yes:#3fbf73; --no:#ef6b5d; --unsure:#d6b45a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 20px 16px 48px; }
header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:12px; }
h1 { font-size: 18px; margin:0; }
.muted { color: var(--muted); font-size: 14px; }
.bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin: 8px 0 16px; }
.bar > div { height:100%; background:var(--accent); width:0; transition: width .2s; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }
.meta { display:flex; flex-wrap:wrap; gap:8px 16px; font-size:14px; color:var(--muted); margin-bottom:12px; }
.terms { display:flex; flex-wrap:wrap; gap:6px; margin: 0 0 16px; padding:0; list-style:none; }
.terms li { background:var(--bg); border:1px solid var(--line); border-radius:999px; padding:2px 10px; font-size:14px; }
ol.headlines { margin:0 0 8px; padding-left: 20px; }
ol.headlines li { margin-bottom: 10px; }
.src { font-size:13px; color:var(--muted); }
.excerpt { white-space: pre-wrap; color: var(--fg); font-size: 15px; margin-top: 8px; }
.question { font-weight:600; margin: 18px 0 12px; }
.buttons { display:flex; flex-wrap:wrap; gap:8px; }
button { font: inherit; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); padding:8px 14px; cursor:pointer; }
button.sel-yes { border-color:var(--yes); color:var(--yes); font-weight:600; }
button.sel-no { border-color:var(--no); color:var(--no); font-weight:600; }
button.sel-unsure { border-color:var(--unsure); color:var(--unsure); font-weight:600; }
kbd { font-size:12px; border:1px solid var(--line); border-radius:4px; padding:0 4px; color:var(--muted); }
.nav { display:flex; justify-content:space-between; gap:8px; margin-top:16px; flex-wrap:wrap; }
.status { font-size:14px; margin-top:8px; min-height: 1.5em; }
input[type=text] { font:inherit; padding:6px 8px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); width: 10em; }
.done { text-align:center; padding: 32px 16px; }
</style>
</head>
<body>
<main>
<header>
  <h1>${escapeHtml(meta.title)}</h1>
  <label class="muted">Etiquetador <input type="text" id="labeler" value="miguel" autocomplete="off"></label>
</header>
<div class="muted" id="progress"></div>
<div class="bar"><div id="bar"></div></div>
<section class="card" id="card" aria-live="polite"></section>
<div class="nav">
  <button id="prev">← Anterior</button>
  <button id="next-open">Siguiente sin responder</button>
  <button id="next">Siguiente →</button>
</div>
<div class="nav">
  <span class="muted">Teclas: <kbd>s</kbd> sí · <kbd>n</kbd> no · <kbd>?</kbd> no sé · <kbd>←</kbd> <kbd>→</kbd> moverse</span>
  <button id="export">Exportar etiquetas</button>
</div>
<div class="status" id="status"></div>
</main>
<script id="data" type="application/json">${scriptJson(data)}</script>
<script>
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("data").textContent);
  var cards = data.cards;
  var storeKey = "earlyscript-labels:" + data.set_name + ":" + data.cards_hash;
  var labels = {};
  var index = 0;
  var storageOk = true;
  try {
    var saved = JSON.parse(window.localStorage.getItem(storeKey) || "null");
    if (saved && saved.labels) labels = saved.labels;
    if (saved && typeof saved.index === "number") index = Math.min(Math.max(0, saved.index), cards.length - 1);
    if (saved && saved.labeler) document.getElementById("labeler").value = saved.labeler;
  } catch (e) { storageOk = false; }
  var NAMES = { yes: "Sí", no: "No", unsure: "No sé" };
  function save() {
    try {
      window.localStorage.setItem(storeKey, JSON.stringify({ labels: labels, index: index, labeler: labeler() }));
    } catch (e) { storageOk = false; }
  }
  function labeler() { return (document.getElementById("labeler").value || "miguel").trim(); }
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fmtDate(iso) { return iso ? String(iso).slice(0, 10) : ""; }
  function render() {
    var count = Object.keys(labels).length;
    document.getElementById("progress").textContent =
      "Tarjeta " + (index + 1) + " de " + cards.length + " · respondidas " + count + " de " + cards.length +
      (storageOk ? "" : " · aviso: el navegador no guarda el avance; exporta antes de cerrar");
    document.getElementById("bar").style.width = (cards.length ? (100 * count / cards.length) : 0) + "%";
    var box = document.getElementById("card");
    box.textContent = "";
    var card = cards[index];
    if (!card) { box.appendChild(el("p", { class: "done" }, "No hay tarjetas.")); return; }
    var meta = el("div", { class: "meta" });
    if (card.cutoff) meta.appendChild(el("span", null, "Fecha del corte: " + fmtDate(card.cutoff)));
    meta.appendChild(el("span", null, card.unit === "item" ? "Tarjeta de ítem" : "Tarjeta de tema"));
    box.appendChild(meta);
    if (card.unit === "item") {
      box.appendChild(el("h2", { style: "font-size:18px;margin:0" }, card.title));
      box.appendChild(el("div", { class: "src" }, card.source + " · " + fmtDate(card.published_at)));
      if (card.excerpt) box.appendChild(el("div", { class: "excerpt" }, card.excerpt));
    } else {
      var terms = el("ul", { class: "terms", "aria-label": "Términos del tema" });
      (card.terms || []).forEach(function (t) { terms.appendChild(el("li", null, t)); });
      box.appendChild(terms);
      var list = el("ol", { class: "headlines" });
      (card.headlines || []).forEach(function (h) {
        var li = el("li");
        li.appendChild(el("div", null, h.title));
        li.appendChild(el("div", { class: "src" }, h.source + " · " + fmtDate(h.published_at)));
        list.appendChild(li);
      });
      box.appendChild(list);
    }
    box.appendChild(el("div", { class: "question" }, card.question || data.questions[card.unit] || data.questions.topic));
    var buttons = el("div", { class: "buttons" });
    [["yes", "Sí", "s"], ["no", "No", "n"], ["unsure", "No sé", "?"]].forEach(function (b) {
      var current = labels[card.card_id] && labels[card.card_id].label === b[0];
      var button = el("button", { "data-label": b[0], class: current ? "sel-" + b[0] : "" });
      button.textContent = b[1] + " ";
      button.appendChild(el("kbd", null, b[2]));
      button.addEventListener("click", function () { answer(b[0]); });
      buttons.appendChild(button);
    });
    box.appendChild(buttons);
    var given = labels[card.card_id];
    document.getElementById("status").textContent = given ? "Respuesta guardada: " + NAMES[given.label] : "";
  }
  function answer(label) {
    var card = cards[index];
    labels[card.card_id] = { label: label, labeled_at: new Date().toISOString() };
    if (index < cards.length - 1) index++;
    save();
    render();
  }
  function move(step) { index = Math.min(Math.max(0, index + step), cards.length - 1); save(); render(); }
  function nextOpen() {
    for (var k = 1; k <= cards.length; k++) {
      var j = (index + k) % cards.length;
      if (!labels[cards[j].card_id]) { index = j; save(); render(); return; }
    }
    document.getElementById("status").textContent = "Todas las tarjetas tienen respuesta.";
  }
  function exportLabels() {
    var rows = cards.filter(function (c) { return labels[c.card_id]; }).map(function (c) {
      var row = { card_id: c.card_id, unit: c.unit, label: labels[c.card_id].label, labeled_at: labels[c.card_id].labeled_at };
      if (c.unit === "item") row.item_id = c.item_id; else row.topic_id = c.topic_id;
      if (c.cutoff) row.cutoff = c.cutoff;
      return row;
    });
    var out = {
      schema_version: data.schema_version,
      labeler: labeler(),
      set_name: data.set_name,
      cards_hash: data.cards_hash,
      universe_hash: data.universe_hash,
      exported_at: new Date().toISOString(),
      cards: cards.length,
      labels: rows
    };
    var blob = new Blob([JSON.stringify(out, null, 2) + "\\n"], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "labels-" + data.set_name + "-" + labeler() + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    document.getElementById("status").textContent = "Exportadas " + rows.length + " etiquetas de " + cards.length + " tarjetas.";
  }
  document.getElementById("prev").addEventListener("click", function () { move(-1); });
  document.getElementById("next").addEventListener("click", function () { move(1); });
  document.getElementById("next-open").addEventListener("click", nextOpen);
  document.getElementById("export").addEventListener("click", exportLabels);
  document.getElementById("labeler").addEventListener("change", save);
  document.addEventListener("keydown", function (event) {
    if (event.target && event.target.tagName === "INPUT") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var key = event.key;
    if (key === "s" || key === "S") answer("yes");
    else if (key === "n" || key === "N") answer("no");
    else if (key === "?" || key === "¿" || key === "/") answer("unsure");
    else if (key === "ArrowLeft") move(-1);
    else if (key === "ArrowRight") move(1);
    else return;
    event.preventDefault();
  });
  render();
})();
</script>
</body>
</html>
`;
}
