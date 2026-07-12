// Client-side solution exports: print-to-PDF, .tex download, Overleaf.
// The old server compiled PDFs with pdflatex; on Cloudflare the browser
// does the work instead.

import { buildLatexDocument, type ProviderArtifact } from "../../shared/solution";

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

export function exportTex(artifact: ProviderArtifact) {
  const source = buildLatexDocument(artifact.latexBody);
  const blob = new Blob([source], { type: "application/x-tex" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(artifact.title)}.tex`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Opens the solution's LaTeX source as a new Overleaf project. */
export function openInOverleaf(artifact: ProviderArtifact) {
  const source = buildLatexDocument(artifact.latexBody);
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "https://www.overleaf.com/docs";
  form.target = "_blank";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "encoded_snip";
  input.value = encodeURIComponent(source);
  form.append(input);
  document.body.append(form);
  form.submit();
  form.remove();
}
