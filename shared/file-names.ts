// What a solution's PDF is called (19 October 2026, the owner's request):
// its date, the model, the problem and "Solution" - a solver's solution and
// the cross-check's verified one alike, never "verified answer":
// 2026-10-19_deepseek-v4.1-flash_Simply-supported-beam-reactions_Solution.pdf
// The server names the PDFs it makes (worker/pdf.ts) and the page names
// "Print instead" the same way.

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The day `ms` falls on in Hong Kong (no daylight saving, so a fixed offset is exact). */
export function hongKongDate(ms: number) {
  return new Date(ms + HONG_KONG_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * One part of a file name: its letters, digits and dots, words joined by
 * hyphens, case kept - LaTeX commands ("\circ") dropped, and anything else
 * (spaces, $, Chinese) turned into a hyphen - at most `max` characters.
 */
export function fileNamePart(value: string, max: number) {
  return value
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[^A-Za-z0-9.]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, max)
    .replace(/[-.]+$/, "");
}

/** A solution's file name, without ".pdf": date, model, problem, "Solution" - a part left out when unknown. */
export function solutionFileName({ at, model, problem }: { at: number; model?: string; problem?: string }) {
  return [hongKongDate(at), fileNamePart(model ?? "", 40), fileNamePart(problem ?? "", 60), "Solution"]
    .filter(Boolean)
    .join("_");
}
