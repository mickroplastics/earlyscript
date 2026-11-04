/**
 * Print figures of the Results space, drawn again from their data as standalone light SVGs with
 * fixed colours and inline attributes: page classes and CSS variables do not travel in an SVG.
 * Pure functions, so drawing, file names and `figuras.md` are tested without a browser.
 */

/** Logical width; the PNG doubles it to 1600 px. */
export const FIGURE_WIDTH = 800;
export const FIGURE_SCALE = 2;
/**
 * Density written into the PNG: 1600 px at 254 dpi is 16 cm, the text width of an A4 page with
 * 2,5 cm margins, so Word and LibreOffice place the image at that width without resizing.
 */
export const FIGURE_PNG_DPI = 254;

/** Fixed print colours; never CSS variables. Assisted wears blue, manual a neutral grey. */
export const FIGURE_COLORS = {
  background: "#ffffff",
  ink: "#0b0b0b",
  secondary: "#52514e",
  muted: "#6b6a65",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  whisker: "#0b0b0b",
  series: {
    primary: "#2a78d6",
    neutral: "#8f8e89",
    accent: "#d97b2b",
  },
} as const;

export type FigureSeriesColor = keyof typeof FIGURE_COLORS.series;

export const FIGURE_FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const FONT_SIZE = {
  title: 20,
  label: 15,
  value: 15,
  note: 13,
  provenance: 12,
  metric: 26,
} as const;

export interface FigureSeries {
  readonly key: string;
  readonly label: string;
  readonly color: FigureSeriesColor;
}

/** One bar: the median as the bar, the interquartile range as a whisker. */
export interface FigureBarRow {
  readonly series: string;
  /** Null draws a dashed line: the value was not recorded. */
  readonly value: number | null;
  readonly low?: number | null;
  readonly high?: number | null;
  /** Text at the end of the row, e.g. "26 min · RIC 24–28 min · n = 3". */
  readonly text: string;
}

export interface FigureBarGroup {
  readonly label: string;
  readonly rows: ReadonlyArray<FigureBarRow>;
  /** Muted sentence under the group, e.g. the difference of medians in words. */
  readonly note?: string;
}

export interface FigureAxis {
  readonly max: number;
  readonly ticks: ReadonlyArray<{ readonly value: number; readonly label: string }>;
}

export interface FigureBarsBody {
  readonly kind: "bars";
  readonly series: ReadonlyArray<FigureSeries>;
  readonly groups: ReadonlyArray<FigureBarGroup>;
  readonly axis: FigureAxis;
}

export interface FigureMetric {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  /** Series swatch beside the label, when the tile belongs to one. */
  readonly series?: string;
}

export interface FigureMetricsBody {
  readonly kind: "metrics";
  readonly series?: ReadonlyArray<FigureSeries>;
  readonly metrics: ReadonlyArray<FigureMetric>;
  /** Tiles per row; 4 by default. */
  readonly columns?: number;
}

export type FigureBody = (FigureBarsBody | FigureMetricsBody) & {
  /** Legend sentences after the series swatches, e.g. "Barra: mediana · trazo: RIC". */
  readonly notes?: ReadonlyArray<string>;
};

export interface FigureSpec {
  /** Lowercase slug; it names the file. */
  readonly id: string;
  readonly title: string;
  /** Figure caption for the report; goes to `figuras.md`, not into the image. */
  readonly caption: string;
  readonly body: FigureBody;
}

export interface FigureContext {
  /** Threads behind the page; null leaves the count out of the provenance line. */
  readonly threads: number | null;
  readonly exportedAt: Date;
}

export type FigureFormat = "png" | "svg";

/** Text width in px for a font size; the browser passes canvas `measureText`. */
export type MeasureText = (text: string, size: number, weight: number) => number;

/** Average glyph width of system sans-serif fonts; tests and the fallback use it. */
export const estimateTextWidth: MeasureText = (text, size, weight) =>
  text.length * size * (weight >= 600 ? 0.58 : 0.53);

/** `AAAA-MM-DD` of the local day: the day the operator sees on the clock. */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Lowercase ASCII slug: "Mediana por etapa" → "mediana-por-etapa". */
export function figureSlug(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "figura";
}

/** `figura-<id>-<AAAA-MM-DD>.png`; matches `EDITORIAL_FIGURE_FILE_NAME` of the contract. */
export function figureFileName(id: string, format: FigureFormat, date: Date): string {
  return `figura-${figureSlug(id)}-${localDay(date)}.${format}`;
}

export const FIGURES_INDEX_FILE = "figuras.md";

/** Name of the zip the web downloads for «Guardar todas las figuras». */
export function figuresZipName(date: Date): string {
  return `figuras-${localDay(date)}.zip`;
}

/** «Earlyscript · 7 hilos · 2026-11-04 · descriptivo, sin inferencia causal». */
export function provenanceText(context: FigureContext): string {
  return [
    "Earlyscript",
    context.threads === null
      ? null
      : `${context.threads} ${context.threads === 1 ? "hilo" : "hilos"}`,
    localDay(context.exportedAt),
    "descriptivo, sin inferencia causal",
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

const MINUTE_MS = 60_000;
const DURATION_STEPS_MIN = [0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 480];

/**
 * A duration axis from 0 with at most six steps of a round size (minutes or hours), ending at
 * or past `maxMs`; `format` writes each tick but zero, which is "0".
 */
export function durationAxis(maxMs: number, format: (ms: number) => string): FigureAxis {
  const max = Math.max(maxMs, MINUTE_MS);
  const stepMin =
    DURATION_STEPS_MIN.find((step) => max / (step * MINUTE_MS) <= 6) ??
    Math.ceil(max / MINUTE_MS / 6 / 60) * 60;
  const step = stepMin * MINUTE_MS;
  const end = Math.ceil(max / step - 1e-9) * step;
  const ticks: Array<{ value: number; label: string }> = [];
  for (let value = 0; value <= end + 1e-6; value += step) {
    ticks.push({ value, label: value === 0 ? "0" : format(value) });
  }
  return { max: end, ticks };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Greedy word wrap; a word longer than the line stays whole on its own line. */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  measure: MeasureText,
  weight = 400,
): ReadonlyArray<string> {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line.length === 0 ? word : `${line} ${word}`;
    if (line.length > 0 && measure(next, size, weight) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/**
 * Wraps on « · » first, so "n = 3" or "RIC 24–28 min" never splits; a segment wider than the
 * line falls back to words.
 */
export function wrapSegments(
  text: string,
  maxWidth: number,
  size: number,
  measure: MeasureText,
): ReadonlyArray<string> {
  const lines: string[] = [];
  let line = "";
  for (const segment of text.split(" · ")) {
    const next = line.length === 0 ? segment : `${line} · ${segment}`;
    if (measure(next, size, 400) <= maxWidth) {
      line = next;
      continue;
    }
    if (line.length > 0) lines.push(line);
    const pieces = wrapText(segment, maxWidth, size, measure);
    lines.push(...pieces.slice(0, -1));
    line = pieces.at(-1) ?? "";
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

const PAD = 40;
const LINE = 1.35;

interface Draw {
  readonly parts: string[];
  y: number;
}

function text(
  draw: Draw,
  x: number,
  y: number,
  value: string,
  options: {
    readonly size: number;
    readonly weight?: number;
    readonly fill?: string;
    readonly anchor?: "start" | "end" | "middle";
  },
) {
  const attributes = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-size="${options.size}"`,
    options.weight && options.weight !== 400 ? `font-weight="${options.weight}"` : null,
    `fill="${options.fill ?? FIGURE_COLORS.ink}"`,
    options.anchor && options.anchor !== "start" ? `text-anchor="${options.anchor}"` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
  draw.parts.push(`<text ${attributes}>${escapeXml(value)}</text>`);
}

/** Paragraph from `draw.y`: the first baseline sits one font size below; advances `y`. */
function paragraph(
  draw: Draw,
  x: number,
  maxWidth: number,
  value: string,
  measure: MeasureText,
  options: { readonly size: number; readonly weight?: number; readonly fill?: string },
) {
  const lines = wrapText(value, maxWidth, options.size, measure, options.weight);
  for (const line of lines) {
    draw.y += options.size * LINE;
    text(draw, x, draw.y - options.size * 0.3, line, options);
  }
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function seriesColor(series: ReadonlyArray<FigureSeries> | undefined, key: string | undefined) {
  const color = series?.find((entry) => entry.key === key)?.color;
  return color === undefined ? null : FIGURE_COLORS.series[color];
}

function swatch(draw: Draw, x: number, baseline: number, size: number, fill: string) {
  const side = Math.round(size * 0.72);
  draw.parts.push(
    `<rect x="${round(x)}" y="${round(baseline - side + 1)}" width="${side}" height="${side}" rx="2" fill="${fill}"/>`,
  );
  return side;
}

/** Series swatches, then the legend sentences, flowing on as many lines as needed. */
function legend(draw: Draw, body: FigureBody, measure: MeasureText) {
  const items: Array<{ readonly label: string; readonly color: string | null }> = [
    ...(body.series ?? []).map((entry) => ({
      label: entry.label,
      color: FIGURE_COLORS.series[entry.color],
    })),
    ...(body.notes ?? []).map((note) => ({ label: note, color: null })),
  ];
  if (items.length === 0) return;
  const size = FONT_SIZE.note;
  const lineHeight = size * 1.6;
  const right = FIGURE_WIDTH - PAD;
  let x = PAD;
  draw.y += lineHeight;
  for (const item of items) {
    const swatchWidth = item.color === null ? 0 : Math.round(size * 0.72) + 6;
    const width = swatchWidth + measure(item.label, size, 400);
    if (x > PAD && x + width > right) {
      x = PAD;
      draw.y += lineHeight;
    }
    const baseline = draw.y - size * 0.45;
    if (item.color !== null) swatch(draw, x, baseline, size, item.color);
    text(draw, x + swatchWidth, baseline, item.label, {
      size,
      fill: item.color === null ? FIGURE_COLORS.muted : FIGURE_COLORS.secondary,
    });
    x += width + 20;
  }
}

const SERIES_COLUMN = 154;
const TEXT_COLUMN = 250;
const COLUMN_GAP = 12;
const ROW_HEIGHT = 28;
const BAR_HEIGHT = 14;

function bars(draw: Draw, body: FigureBarsBody, measure: MeasureText) {
  const plotLeft = PAD + SERIES_COLUMN + COLUMN_GAP;
  const plotRight = FIGURE_WIDTH - PAD - TEXT_COLUMN - COLUMN_GAP;
  const plotWidth = plotRight - plotLeft;
  const max = body.axis.max > 0 ? body.axis.max : 1;
  const xOf = (value: number) => plotLeft + Math.min(1, Math.max(0, value / max)) * plotWidth;
  const size = FONT_SIZE.value;
  const lineHeight = size * 1.3;
  const marks: string[] = [];
  // Vertical extent of each group's bars: the grid runs behind the bars only, never through
  // the group labels or the notes.
  const bands: Array<readonly [number, number]> = [];
  // Grid and marks go in under the texts drawn below, once the height is known.
  const underneath = draw.parts.length;
  draw.y += 8;
  for (const group of body.groups) {
    draw.y += 6;
    paragraph(draw, PAD, FIGURE_WIDTH - 2 * PAD, group.label, measure, {
      size: FONT_SIZE.label,
      weight: 600,
    });
    draw.y += 2;
    const bandTop = draw.y;
    for (const row of group.rows) {
      // A row text that does not fit wraps under itself: nothing is cut in print.
      const lines = wrapSegments(row.text, TEXT_COLUMN, size, measure);
      const label = body.series.find((entry) => entry.key === row.series)?.label ?? row.series;
      const labelLines = wrapSegments(label, SERIES_COLUMN - 24, size, measure);
      const height = Math.max(
        ROW_HEIGHT,
        Math.max(lines.length, labelLines.length) * lineHeight + 8,
      );
      const center = draw.y + height / 2;
      const color = seriesColor(body.series, row.series) ?? FIGURE_COLORS.series.neutral;
      const baseline = center + size * 0.35;
      const side = swatch(draw, PAD, baseline, size, color);
      labelLines.forEach((line, index) =>
        text(
          draw,
          PAD + side + 6,
          baseline - ((labelLines.length - 1) * lineHeight) / 2 + index * lineHeight,
          line,
          { size, fill: FIGURE_COLORS.secondary },
        ),
      );
      if (row.value === null) {
        marks.push(
          `<line x1="${plotLeft}" x2="${plotRight}" y1="${round(center)}" y2="${round(center)}" stroke="${FIGURE_COLORS.axis}" stroke-width="1.5" stroke-dasharray="3 4"/>`,
        );
      } else {
        const width = Math.max(xOf(row.value) - plotLeft, row.value > 0 ? 2 : 0);
        marks.push(
          `<rect x="${plotLeft}" y="${round(center - BAR_HEIGHT / 2)}" width="${round(width)}" height="${BAR_HEIGHT}" rx="2" fill="${color}"/>`,
        );
        if (row.low != null && row.high != null && row.high > row.low) {
          marks.push(
            `<line x1="${round(xOf(row.low))}" x2="${round(xOf(row.high))}" y1="${round(center)}" y2="${round(center)}" stroke="${FIGURE_COLORS.whisker}" stroke-opacity="0.75" stroke-width="2.5" stroke-linecap="round"/>`,
          );
        }
      }
      const firstBaseline = baseline - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, index) => {
        text(draw, FIGURE_WIDTH - PAD - TEXT_COLUMN, firstBaseline + index * lineHeight, line, {
          size,
        });
      });
      draw.y += height;
    }
    bands.push([bandTop, draw.y]);
    if (group.note) {
      paragraph(draw, plotLeft, FIGURE_WIDTH - PAD - plotLeft, group.note, measure, {
        size: FONT_SIZE.note,
        fill: FIGURE_COLORS.muted,
      });
    }
    draw.y += 8;
  }
  const grid: string[] = [];
  for (const tick of body.axis.ticks) {
    const x = round(xOf(tick.value));
    const stroke = tick.value === 0 ? FIGURE_COLORS.axis : FIGURE_COLORS.grid;
    for (const [from, to] of bands) {
      grid.push(
        `<line x1="${x}" x2="${x}" y1="${round(from)}" y2="${round(to)}" stroke="${stroke}" stroke-width="1"/>`,
      );
    }
  }
  draw.parts.splice(underneath, 0, ...grid, ...marks);
  draw.y += FONT_SIZE.note * 1.1;
  for (const tick of visibleTicks(body.axis, xOf, measure)) {
    text(draw, xOf(tick.value), draw.y, tick.label, {
      size: FONT_SIZE.note,
      fill: FIGURE_COLORS.muted,
      anchor: "middle",
    });
  }
  draw.y += 4;
}

/**
 * The tick labels that fit side by side: every tick, else every second one, and so on, always
 * from zero. The grid keeps every line.
 */
function visibleTicks(axis: FigureAxis, xOf: (value: number) => number, measure: MeasureText) {
  const gap = 10;
  for (let stride = 1; stride < Math.max(2, axis.ticks.length); stride += 1) {
    const shown = axis.ticks.filter((_, index) => index % stride === 0);
    const fits = shown.every((tick, index) => {
      const previous = shown[index - 1];
      if (previous === undefined) return true;
      const half = (entry: typeof tick) => measure(entry.label, FONT_SIZE.note, 400) / 2;
      return xOf(previous.value) + half(previous) + gap <= xOf(tick.value) - half(tick);
    });
    if (fits) return shown;
  }
  return axis.ticks.slice(0, 1);
}

function metrics(draw: Draw, body: FigureMetricsBody, measure: MeasureText) {
  const columns = Math.max(1, Math.min(body.columns ?? 4, body.metrics.length));
  const gap = 24;
  const width = (FIGURE_WIDTH - 2 * PAD - gap * (columns - 1)) / columns;
  draw.y += 12;
  for (let start = 0; start < body.metrics.length; start += columns) {
    const row = body.metrics.slice(start, start + columns);
    const top = draw.y;
    let bottom = top;
    row.forEach((metric, index) => {
      const x = PAD + index * (width + gap);
      const cell: Draw = { parts: draw.parts, y: top };
      draw.parts.push(
        `<line x1="${round(x)}" x2="${round(x + width)}" y1="${round(top)}" y2="${round(top)}" stroke="${FIGURE_COLORS.grid}" stroke-width="1"/>`,
      );
      cell.y += 6;
      const color = seriesColor(body.series, metric.series);
      const labelX = color === null ? x : x + Math.round(FONT_SIZE.note * 0.72) + 6;
      const before = cell.y;
      paragraph(cell, labelX, x + width - labelX, metric.label, measure, {
        size: FONT_SIZE.note,
        fill: FIGURE_COLORS.secondary,
      });
      if (color !== null) {
        swatch(
          draw,
          x,
          before + FONT_SIZE.note * LINE - FONT_SIZE.note * 0.3,
          FONT_SIZE.note,
          color,
        );
      }
      cell.y += 4;
      paragraph(cell, x, width, metric.value, measure, { size: FONT_SIZE.metric, weight: 600 });
      if (metric.detail) {
        cell.y += 2;
        paragraph(cell, x, width, metric.detail, measure, {
          size: FONT_SIZE.note,
          fill: FIGURE_COLORS.muted,
        });
      }
      bottom = Math.max(bottom, cell.y);
    });
    draw.y = bottom + 18;
  }
}

/**
 * The figure as a standalone SVG document, 800 logical px wide: title, legend, the chart,
 * then the provenance line. Same input, same bytes.
 */
export function renderFigureSvg(
  spec: FigureSpec,
  context: FigureContext,
  measure: MeasureText = estimateTextWidth,
): string {
  const draw: Draw = { parts: [], y: PAD - 10 };
  paragraph(draw, PAD, FIGURE_WIDTH - 2 * PAD, spec.title, measure, {
    size: FONT_SIZE.title,
    weight: 600,
  });
  legend(draw, spec.body, measure);
  draw.y += 6;
  if (spec.body.kind === "bars") bars(draw, spec.body, measure);
  else metrics(draw, spec.body, measure);
  draw.y += 14;
  draw.parts.push(
    `<line x1="${PAD}" x2="${FIGURE_WIDTH - PAD}" y1="${round(draw.y)}" y2="${round(draw.y)}" stroke="${FIGURE_COLORS.grid}" stroke-width="1"/>`,
  );
  draw.y += 4;
  paragraph(draw, PAD, FIGURE_WIDTH - 2 * PAD, provenanceText(context), measure, {
    size: FONT_SIZE.provenance,
    fill: FIGURE_COLORS.muted,
  });
  const height = Math.ceil(draw.y + PAD - 16);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FIGURE_WIDTH}" height="${height}" viewBox="0 0 ${FIGURE_WIDTH} ${height}" font-family="${escapeXml(FIGURE_FONT)}">`,
    `<title>${escapeXml(spec.title)}</title>`,
    `<desc>${escapeXml(figureDescription(spec.body).join(" "))}</desc>`,
    `<rect width="${FIGURE_WIDTH}" height="${height}" fill="${FIGURE_COLORS.background}"/>`,
    ...draw.parts,
    "</svg>",
    "",
  ].join("\n");
}

/** Height in logical px, read back from the SVG root. */
export function svgHeight(svg: string): number {
  const match = /<svg[^>]*\sheight="(\d+)"/.exec(svg);
  return match ? Number(match[1]) : 0;
}

/** The data of the figure in sentences, for `figuras.md` and the SVG `<desc>`. */
export function figureDescription(body: FigureBody): ReadonlyArray<string> {
  if (body.kind === "bars") {
    return body.groups.map((group) => {
      const rows = group.rows
        .map((row) => {
          const label = body.series.find((entry) => entry.key === row.series)?.label ?? row.series;
          return `${label.toLowerCase()} ${row.text}`;
        })
        .join("; ");
      const note = group.note?.replace(/\.+$/, "");
      return `${group.label}: ${rows}.${note ? ` ${note}.` : ""}`;
    });
  }
  return body.metrics.map(
    (metric) => `${metric.label}: ${metric.value}${metric.detail ? ` (${metric.detail})` : ""}.`,
  );
}

export interface FigureIndexEntry {
  readonly spec: FigureSpec;
  readonly fileName: string;
}

/** `figuras.md`: one section per figure with its file, caption and data in words. */
export function figuresMarkdown(
  entries: ReadonlyArray<FigureIndexEntry>,
  context: FigureContext,
): string {
  const lines = [
    "# Figuras de Resultados",
    "",
    `Exportadas por Earlyscript el ${localDay(context.exportedAt)}${
      context.threads === null
        ? ""
        : ` sobre ${context.threads} ${context.threads === 1 ? "hilo cerrado" : "hilos cerrados"}`
    }. Son descriptivas, sin inferencia causal.`,
    "",
    "Cada imagen PNG mide 1600 px de ancho a 254 ppp, es decir 16 cm en el documento.",
  ];
  entries.forEach((entry, index) => {
    lines.push(
      "",
      `## Figura ${index + 1}. ${entry.spec.title}`,
      "",
      `Archivo: \`${entry.fileName}\``,
      "",
      `Pie: ${entry.spec.caption}`,
      "",
      "Datos:",
      "",
      ...figureDescription(entry.spec.body).map((line) => `- ${line}`),
    );
  });
  lines.push("", `Fuente: ${provenanceText(context)}.`, "");
  return lines.join("\n");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The PNG with a `pHYs` chunk of `dpi` right after `IHDR`, replacing one already there.
 * Anything that is not a PNG comes back unchanged.
 */
export function withPngDensity(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [png.subarray(0, 8)];
  const pixelsPerMetre = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(21);
  const physView = new DataView(phys.buffer);
  physView.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  physView.setUint32(8, pixelsPerMetre);
  physView.setUint32(12, pixelsPerMetre);
  phys[16] = 1; // unit: metre
  physView.setUint32(17, crc32(phys.subarray(4, 17)));
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > png.length) return png;
    if (type !== "pHYs") chunks.push(png.subarray(offset, end));
    if (type === "IHDR") chunks.push(phys);
    offset = end;
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Base64 in chunks, so a few megabytes never overflow the argument list of `fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
