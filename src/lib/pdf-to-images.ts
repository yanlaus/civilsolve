// Rasterizes PDF pages to JPEG data URLs in the browser with pdf.js.
// Loaded via dynamic import only when a PDF is actually submitted.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MAX_PDF_PAGES = 8;
const RENDER_SCALE = 1.5;
const JPEG_QUALITY = 0.85;

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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
