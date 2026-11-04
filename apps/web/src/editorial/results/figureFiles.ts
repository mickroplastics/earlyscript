import {
  FIGURE_FONT,
  FIGURE_PNG_DPI,
  FIGURE_SCALE,
  FIGURE_WIDTH,
  FIGURES_INDEX_FILE,
  estimateTextWidth,
  figureFileName,
  figuresMarkdown,
  renderFigureSvg,
  svgHeight,
  withPngDensity,
  type FigureContext,
  type FigureFormat,
  type FigureSpec,
  type MeasureText,
} from "./figureExport.logic";

/** One file ready to save: a figure image or the `figuras.md` index. */
export interface FigureFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

/** Text widths from the browser's own fonts, so wrapping matches what the image draws. */
function canvasMeasure(): MeasureText {
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) return estimateTextWidth;
  return (text, size, weight) => {
    context.font = `${weight} ${size}px ${FIGURE_FONT}`;
    return context.measureText(text).width;
  };
}

/** The SVG drawn on a white canvas at 2x: 1600 px wide, with its print density set. */
async function rasterize(svg: string): Promise<Uint8Array> {
  const height = svgHeight(svg);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const image = new Image();
  image.src = url;
  let png: Blob | null;
  try {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = FIGURE_WIDTH * FIGURE_SCALE;
    canvas.height = height * FIGURE_SCALE;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D is not available.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  URL.revokeObjectURL(url);
  if (png === null) throw new Error("The canvas gave no PNG.");
  return withPngDensity(new Uint8Array(await png.arrayBuffer()), FIGURE_PNG_DPI);
}

export async function figureFile(
  spec: FigureSpec,
  context: FigureContext,
  format: FigureFormat,
): Promise<FigureFile> {
  const svg = renderFigureSvg(spec, context, canvasMeasure());
  const name = figureFileName(spec.id, format, context.exportedAt);
  if (format === "svg") {
    return { name, type: "image/svg+xml", bytes: new TextEncoder().encode(svg) };
  }
  return { name, type: "image/png", bytes: await rasterize(svg) };
}

/** Every figure as PNG, in page order, plus `figuras.md` with captions and data in words. */
export async function allFigureFiles(
  specs: ReadonlyArray<FigureSpec>,
  context: FigureContext,
): Promise<ReadonlyArray<FigureFile>> {
  const images: FigureFile[] = [];
  for (const spec of specs) images.push(await figureFile(spec, context, "png"));
  const index = figuresMarkdown(
    specs.map((spec, position) => ({ spec, fileName: images[position]!.name })),
    context,
  );
  return [
    ...images,
    { name: FIGURES_INDEX_FILE, type: "text/markdown", bytes: new TextEncoder().encode(index) },
  ];
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Browser download: one file as is, several in a zip named `zipName`. Returns what was saved. */
export async function downloadFigureFiles(
  files: ReadonlyArray<FigureFile>,
  zipName: string,
): Promise<string> {
  if (files.length === 1) {
    const [file] = files;
    download(new Blob([file!.bytes as Uint8Array<ArrayBuffer>], { type: file!.type }), file!.name);
    return file!.name;
  }
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.bytes);
  download(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), zipName);
  return zipName;
}
