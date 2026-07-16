// Converts uploaded lecture-notes files into the reference payload sent with
// solve requests: extracted text for text-layer PDF pages, rasterized images
// for scans/diagram pages and plain image files.

import { imageFileToDataUrl, isPdfFile } from "./attachments";
import {
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_TEXT,
} from "../../shared/stream-protocol";

export type LectureNotesPayload = {
  referenceText: string;
  referenceImages: string[];
};

export async function lectureNotesToPayload(files: File[]): Promise<LectureNotesPayload> {
  const textParts: string[] = [];
  const referenceImages: string[] = [];

  for (const file of files) {
    if (isPdfFile(file)) {
      const { pdfToNotesPayload } = await import("./pdf-to-images");
      const payload = await pdfToNotesPayload(
        file,
        MAX_REFERENCE_IMAGES - referenceImages.length,
      );
      textParts.push(...payload.textParts);
      referenceImages.push(...payload.imagePages);
    } else {
      if (referenceImages.length >= MAX_REFERENCE_IMAGES) {
        throw new Error(
          `Lecture notes are limited to ${MAX_REFERENCE_IMAGES} image pages. Remove some files or use text-based PDFs.`,
        );
      }
      referenceImages.push(await imageFileToDataUrl(file));
    }
  }

  let referenceText = textParts.join("\n\n");
  if (referenceText.length > MAX_REFERENCE_TEXT) {
    referenceText = `${referenceText.slice(0, MAX_REFERENCE_TEXT)}\n[Lecture notes truncated at ${MAX_REFERENCE_TEXT} characters.]`;
  }

  return { referenceText, referenceImages };
}
