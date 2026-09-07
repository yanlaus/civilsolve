// Rasterizes PDF pages to JPEG data URLs in the browser with pdf.js.
// Loaded via dynamic import only when a PDF is actually submitted.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MAX_PDF_PAGES = 8;
const RENDER_SCALE = 1.5;
const JPEG_QUALITY = 0.85;

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Pages with at least this many extractable characters are treated as
// text-layer pages; sparser pages (scans, diagram-only) get rasterized.
const TEXT_LAYER_MIN_CHARS = 200;

export type PdfNotesPayload = {
  textParts: string[];
  imagePages: string[];
};

/**
 * Hybrid extraction for lecture notes: text-layer pages contribute text,
 * sparse pages are rasterized, capped at `maxImagePages` images.
 */
export async function pdfToNotesPayload(
  file: File,
  maxImagePages: number,
): Promise<PdfNotesPayload> {
  const data = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data });
  const document_ = await loadingTask.promise;

  try {
    const textParts: string[] = [];
    const imagePages: string[] = [];

    for (let pageNumber = 1; pageNumber <= document_.numPages; pageNumber += 1) {
      const page = await document_.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText.length >= TEXT_LAYER_MIN_CHARS) {
        textParts.push(`[${file.name}, page ${pageNumber}]\n${pageText}`);
        page.cleanup();
        continue;
      }

      if (imagePages.length >= maxImagePages) {
        page.cleanup();
        continue;
      }

      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas 2D context is unavailable in this browser.");
      }
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      imagePages.push(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      page.cleanup();
    }

    return { textParts, imagePages };
  } finally {
    await loadingTask.destroy();
  }
}

export async function pdfToImageDataUrls(file: File): Promise<string[]> {
  const data = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data });
  const document_ = await loadingTask.promise;

  try {
    const pageCount = Math.min(document_.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document_.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas 2D context is unavailable in this browser.");
      }
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      pages.push(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      page.cleanup();
    }

    if (!pages.length) {
      throw new Error(`${file.name} did not contain any renderable pages.`);
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
