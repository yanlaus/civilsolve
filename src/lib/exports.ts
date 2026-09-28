// The browser's print dialog: "Print instead", for when the server cannot
// make the PDF ("Generate PDF", worker/pdf.ts, since 29 September 2026 - it
// was the only way to a PDF before). The .tex download and "Open in
// Overleaf" were removed on 25 September 2026 - users only save PDFs.

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "solution"
  );
}

/**
 * Prints the currently mounted `.print-area` (see solution-panel) via the
 * browser's print dialog — "Save as PDF" produces the export.
 */
export function exportPdf(title: string) {
  const previousTitle = document.title;
  document.title = slugify(title);
  try {
    window.print();
  } finally {
    document.title = previousTitle;
  }
}
