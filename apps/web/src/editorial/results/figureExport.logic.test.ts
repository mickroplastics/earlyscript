import { EDITORIAL_FIGURE_FILE_NAME } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FIGURE_COLORS,
  bytesToBase64,
  crc32,
  durationAxis,
  escapeXml,
  figureDescription,
  figureFileName,
  figureSlug,
  figuresMarkdown,
  figuresZipName,
  localDay,
  provenanceText,
  renderFigureSvg,
  svgHeight,
  withPngDensity,
  wrapSegments,
  wrapText,
  estimateTextWidth,
  type FigureSpec,
} from "./figureExport.logic";
import { formatDuration } from "./results.logic";

const MINUTE = 60_000;
const DAY = new Date(2026, 10, 4, 23, 30);

const BARS: FigureSpec = {
  id: "etapas",
  title: "Mediana de tiempo activo por etapa",
  caption: "Mediana y RIC por etapa.",
  body: {
    kind: "bars",
    series: [
      { key: "assisted", label: "Asistido", color: "primary" },
      { key: "manual", label: "Manual", color: "neutral" },
    ],
    groups: [
      {
        label: "Escribir",
        rows: [
          {
            series: "assisted",
            value: 26 * MINUTE,
            low: 24 * MINUTE,
            high: 28 * MINUTE,
            text: "26 min · n = 3",
          },
          { series: "manual", value: null, text: "sin datos · n = 0" },
        ],
        note: "Mediana manual 24 min mayor (n = 3 y 3)",
      },
    ],
    axis: durationAxis(52 * MINUTE, formatDuration),
    notes: ["Barra: mediana"],
  },
};

const METRICS: FigureSpec = {
  id: "bandeja",
  title: "Bandeja <de> tendencias & más",
  caption: "Conteos independientes.",
  body: {
    kind: "metrics",
    metrics: [
      { label: "Leídas", value: "6", detail: "abiertas al menos una vez" },
      { label: "Descartadas", value: "2" },
    ],
  },
};

describe("file names", () => {
  it("names each figure by slug and local day, as the contract accepts", () => {
    expect(localDay(DAY)).toBe("2026-11-04");
    expect(figureSlug("Mediana por étapa / Manual")).toBe("mediana-por-etapa-manual");
    expect(figureSlug("***")).toBe("figura");
    const png = figureFileName("tiempos", "png", DAY);
    expect(png).toBe("figura-tiempos-2026-11-04.png");
    expect(figureFileName("Línea base", "svg", DAY)).toBe("figura-linea-base-2026-11-04.svg");
    expect(EDITORIAL_FIGURE_FILE_NAME.test(png)).toBe(true);
    expect(EDITORIAL_FIGURE_FILE_NAME.test("figuras.md")).toBe(true);
    expect(figuresZipName(DAY)).toBe("figuras-2026-11-04.zip");
  });

  it("writes the provenance line with or without the thread count", () => {
    expect(provenanceText({ threads: 7, exportedAt: DAY })).toBe(
      "Earlyscript · 7 hilos · 2026-11-04 · descriptivo, sin inferencia causal",
    );
    expect(provenanceText({ threads: 1, exportedAt: DAY })).toContain("· 1 hilo ·");
    expect(provenanceText({ threads: null, exportedAt: DAY })).toBe(
      "Earlyscript · 2026-11-04 · descriptivo, sin inferencia causal",
    );
  });
});

describe("durationAxis", () => {
  it("ends at a round step past the data, with at most six steps", () => {
    const axis = durationAxis(52 * MINUTE, formatDuration);
    expect(axis.max).toBe(60 * MINUTE);
    // formatDuration joins number and unit with a no-break space.
    expect(axis.ticks.map((tick) => tick.label)).toEqual([
      "0",
      "10\u00a0min",
      "20\u00a0min",
      "30\u00a0min",
      "40\u00a0min",
      "50\u00a0min",
      "1\u00a0h",
    ]);
    const long = durationAxis(101.5 * MINUTE, formatDuration);
    expect(long.max).toBe(120 * MINUTE);
    expect(long.ticks.at(-1)?.label).toBe("2\u00a0h");
    expect(durationAxis(0, formatDuration).max).toBe(MINUTE);
  });
});

describe("renderFigureSvg", () => {
  it("draws a standalone light SVG with fixed colours and no classes or variables", () => {
    const svg = renderFigureSvg(BARS, { threads: 6, exportedAt: DAY });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="800"')).toBe(true);
    expect(svg).toContain(`fill="${FIGURE_COLORS.background}"`);
    expect(svg).toContain(`fill="${FIGURE_COLORS.series.primary}"`);
    expect(svg).not.toMatch(/class=|var\(--|currentColor/);
    expect(svg).toContain(">Mediana de tiempo activo por etapa</text>");
    expect(svg).toContain(
      ">Earlyscript · 6 hilos · 2026-11-04 · descriptivo, sin inferencia causal</text>",
    );
    // The missing manual median is a dashed line, never a zero bar.
    expect(svg).toContain('stroke-dasharray="3 4"');
    expect(svg.match(/<rect [^>]*fill="#8f8e89"/g)?.length ?? 0).toBe(2); // legend + row swatch only
    expect(svgHeight(svg)).toBeGreaterThan(200);
    // Same input, same bytes.
    expect(renderFigureSvg(BARS, { threads: 6, exportedAt: DAY })).toBe(svg);
  });

  it("escapes text and lays out metric tiles", () => {
    const svg = renderFigureSvg(METRICS, { threads: null, exportedAt: DAY });
    expect(svg).toContain("Bandeja &lt;de&gt; tendencias &amp; más");
    expect(svg).not.toContain("<de>");
    expect(svg).toContain(">6</text>");
    expect(svg).toContain(">abiertas al menos una vez</text>");
    expect(escapeXml(`"a'`)).toBe("&quot;a&apos;");
  });

  it("wraps a long row text instead of cutting it and keeps axis labels apart", () => {
    const long = "1 h 40 min · RIC 1 h 39 min–1 h 42 min · n = 3";
    const svg = renderFigureSvg(
      {
        ...BARS,
        body: {
          ...BARS.body,
          kind: "bars",
          series: BARS.body.kind === "bars" ? BARS.body.series : [],
          groups: [
            { label: "Total", rows: [{ series: "manual", value: 100 * MINUTE, text: long }] },
          ],
          axis: durationAxis(101.5 * MINUTE, formatDuration),
        },
      },
      { threads: 6, exportedAt: DAY },
    );
    expect(svg).not.toContain("…");
    const rowLines = [...svg.matchAll(/<text x="510"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(rowLines.length).toBeGreaterThan(1);
    expect(rowLines.join(" · ")).toBe(long);
    // Seven ticks to two hours do not fit side by side: every second label is drawn.
    expect(svg).toContain(">40\u00a0min</text>");
    expect(svg).not.toContain(">20\u00a0min</text>");
  });

  it("wraps row texts on their separators before words", () => {
    expect(wrapSegments("45 min · RIC 42–53 min · n = 3", 180, 15, estimateTextWidth)).toEqual([
      "45 min · RIC 42–53 min",
      "n = 3",
    ]);
  });

  it("wraps long text on words", () => {
    const lines = wrapText("una frase bastante larga para partirla", 100, 13, estimateTextWidth);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("una frase bastante larga para partirla");
  });
});

describe("figuras.md", () => {
  it("lists each figure with its file, caption and data in words", () => {
    expect(figureDescription(BARS.body)).toEqual([
      "Escribir: asistido 26 min · n = 3; manual sin datos · n = 0. Mediana manual 24 min mayor (n = 3 y 3).",
    ]);
    const markdown = figuresMarkdown(
      [
        { spec: BARS, fileName: "figura-etapas-2026-11-04.png" },
        { spec: METRICS, fileName: "figura-bandeja-2026-11-04.png" },
      ],
      { threads: 6, exportedAt: DAY },
    );
    expect(markdown).toContain("## Figura 1. Mediana de tiempo activo por etapa");
    expect(markdown).toContain("Archivo: `figura-etapas-2026-11-04.png`");
    expect(markdown).toContain("Pie: Mediana y RIC por etapa.");
    expect(markdown).toContain("## Figura 2. Bandeja <de> tendencias & más");
    expect(markdown).toContain("- Leídas: 6 (abiertas al menos una vez).");
    expect(markdown).toContain("sobre 6 hilos cerrados");
    expect(markdown).not.toMatch(/ahorr|—/i);
  });
});

describe("bytes", () => {
  it("computes the PNG CRC", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  it("writes a pHYs chunk after IHDR and replaces an earlier one", () => {
    const chunk = (type: string, data: number[]) => {
      const body = [...new TextEncoder().encode(type), ...data];
      const crc = crc32(Uint8Array.from(body));
      const length = data.length;
      return [
        (length >>> 24) & 255,
        (length >>> 16) & 255,
        (length >>> 8) & 255,
        length & 255,
        ...body,
        (crc >>> 24) & 255,
        (crc >>> 16) & 255,
        (crc >>> 8) & 255,
        crc & 255,
      ];
    };
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const png = Uint8Array.from([
      ...signature,
      ...chunk(
        "IHDR",
        Array.from({ length: 13 }, () => 0),
      ),
      ...chunk("pHYs", [0, 0, 0, 1, 0, 0, 0, 1, 0]),
      ...chunk("IEND", []),
    ]);
    const out = withPngDensity(png, 254);
    const types: string[] = [];
    const view = new DataView(out.buffer);
    let offset = 8;
    while (offset < out.length) {
      types.push(String.fromCharCode(...out.subarray(offset + 4, offset + 8)));
      if (types.at(-1) === "pHYs") {
        expect(view.getUint32(offset + 8)).toBe(10_000); // 254 dpi in pixels per metre
        expect(out[offset + 16]).toBe(1);
        expect(view.getUint32(offset + 17)).toBe(crc32(out.subarray(offset + 4, offset + 17)));
      }
      offset += 12 + view.getUint32(offset);
    }
    expect(types).toEqual(["IHDR", "pHYs", "IEND"]);
    const notPng = Uint8Array.from([1, 2, 3]);
    expect(withPngDensity(notPng, 254)).toBe(notPng);
  });

  it("encodes base64 in chunks", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);
    const encoded = bytesToBase64(bytes);
    expect(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))).toEqual(bytes);
    expect(bytesToBase64(new TextEncoder().encode("hola"))).toBe("aG9sYQ==");
  });
});
