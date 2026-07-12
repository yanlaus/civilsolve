// Converts queued files into JPEG data URLs ready for the solve request.
// Images are downscaled on a canvas; PDFs are rasterized via pdf.js
// (dynamically imported so pdfjs-dist stays out of the main bundle).

const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.85;

export const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const ACCEPTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".pdf",
]);

export function getFileExtension(name: string) {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] || "";
}

export function isPdfFile(file: File) {
  return file.type === "application/pdf" || getFileExtension(file.name) === ".pdf";
}

export function isAcceptedUpload(file: File) {
  return (
    ACCEPTED_IMAGE_TYPES.has(file.type) ||
    file.type === "application/pdf" ||
    ACCEPTED_EXTENSIONS.has(getFileExtension(file.name))
  );
}

export async function imageFileToDataUrl(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      `${file.name} could not be decoded in the browser. Use JPEG, PNG, WebP, GIF, or PDF.`,
    );
  }

  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D context is unavailable in this browser.");
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

/** Converts all queued files (images + PDFs) into JPEG data URLs. */
export async function filesToImageDataUrls(files: File[]): Promise<string[]> {
  const results: string[] = [];
  for (const file of files) {
    if (isPdfFile(file)) {
      const { pdfToImageDataUrls } = await import("./pdf-to-images");
      results.push(...(await pdfToImageDataUrls(file)));
    } else {
      results.push(await imageFileToDataUrl(file));
    }
  }
  return results;
}
