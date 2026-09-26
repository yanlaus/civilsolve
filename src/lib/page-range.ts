// Which pages of an uploaded PDF to send, as the user types them: "" or
// "all" for every page, otherwise pages and ranges such as "1-3, 5, 8-".

export type PageSelection = { pages: number[] } | { error: string };

/**
 * Parses `spec` against a document of `pageCount` pages. Pages come back
 * sorted and without repeats; an empty spec means every page.
 */
export function parsePageSpec(spec: string, pageCount: number): PageSelection {
  const trimmed = spec.trim().toLowerCase();
  if (!trimmed || trimmed === "all") {
    return { pages: Array.from({ length: pageCount }, (_, index) => index + 1) };
  }

  const pages = new Set<number>();
  // "1 - 3" and "1–3" read as "1-3" before the list is split on spaces.
  const tokens = trimmed.replace(/\s*[-–]\s*/g, "-").split(/[\s,;]+/).filter(Boolean);
  for (const token of tokens) {
    const match = token.match(/^(\d+)(?:-(\d*))?$/);
    if (!match) return { error: `"${token}" is not a page or a range like 2-5.` };
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : match[2] === "" ? pageCount : Number(match[2]);
    if (from < 1 || to < from) return { error: `"${token}" is not a valid range.` };
    if (to > pageCount) {
      return { error: `Page ${to} does not exist - this PDF has ${pageCount} page${pageCount === 1 ? "" : "s"}.` };
    }
    for (let page = from; page <= to; page += 1) pages.add(page);
  }

  if (!pages.size) return { error: "Choose at least one page." };
  return { pages: [...pages].sort((a, b) => a - b) };
}
