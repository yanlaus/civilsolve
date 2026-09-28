// "Generate PDF": the server prints the answer (GET /api/pdf/:id,
// worker/pdf.ts) and the page offers the link - which replaced the browser's
// print dialog (the owner's call, 29 September 2026; on an iPhone printing
// to PDF was a trip through the share sheet). The PDF is made once, then
// opened from the link: iOS blocks a new tab opened after the wait, and
// the server keeps the file in its cache, so opening it costs nothing. If
// the server cannot make it - the month's allowance used up, the browser
// service down - printing from the browser is still there.

import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Loader2, Printer } from "lucide-react";
import { formatClock, useNow } from "@/lib/progress";

type PdfState =
  | { status: "idle" }
  | { status: "working"; startedAt: number }
  | { status: "ready"; url: string; copied?: boolean }
  | { status: "error"; message: string };

const DARK_BUTTON =
  "inline-flex items-center gap-2 rounded-cs bg-cs-ink font-semibold text-cs-surface transition disabled:cursor-not-allowed disabled:opacity-60";
const LIGHT_BUTTON =
  "inline-flex items-center gap-1.5 rounded-cs border border-cs-line bg-cs-surface font-semibold text-cs-ink-2 transition hover:border-cs-accent hover:text-cs-accent";

export function PdfButton({
  jobId,
  onPrint,
  small = false,
}: {
  /** The job that holds this answer on the server; null when it has none. */
  jobId: string | null;
  /** The browser's print dialog, for when the server cannot make the PDF. */
  onPrint: () => void;
  small?: boolean;
}) {
  const [state, setState] = useState<PdfState>({ status: "idle" });
  const now = useNow(state.status === "working");
  const size = small ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";
  const icon = small ? "h-3.5 w-3.5" : "h-4 w-4";

  async function generate() {
    if (!jobId) {
      setState({ status: "error", message: "This answer is not on the server, so it cannot be made into a PDF there." });
      return;
    }
    setState({ status: "working", startedAt: Date.now() });
    const url = `/api/pdf/${jobId}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        // Read to the end, so the server has cached the whole file.
        await response.arrayBuffer();
        setState({ status: "ready", url });
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setState({ status: "error", message: body?.error || `The server answered ${response.status}.` });
    } catch {
      setState({ status: "error", message: "Could not reach the server. Check the connection and try again." });
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(new URL(url, window.location.href).toString());
      setState({ status: "ready", url, copied: true });
    } catch {
      // No clipboard (an old browser, no permission): the link is still there to open.
    }
  }

  if (state.status === "ready") {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <a href={state.url} target="_blank" rel="noopener" className={`${DARK_BUTTON} ${size}`}>
          <ExternalLink className={icon} aria-hidden="true" />
          Open PDF
        </a>
        <button type="button" onClick={() => void copyLink(state.url)} className={`${LIGHT_BUTTON} ${size}`}>
          {state.copied ? <Check className={icon} aria-hidden="true" /> : <Copy className={icon} aria-hidden="true" />}
          {state.copied ? "Link copied" : "Copy link"}
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => void generate()}
        disabled={state.status === "working"}
        className={`${DARK_BUTTON} ${size}`}
        title="The server makes the PDF and gives you a link to it (kept 24 hours)"
      >
        {state.status === "working" ? (
          <Loader2 className={`${icon} animate-spin`} aria-hidden="true" />
        ) : (
          <Download className={icon} aria-hidden="true" />
        )}
        {state.status === "working"
          ? `Generating PDF... ${formatClock(now - state.startedAt)}`
          : state.status === "error"
            ? "Try again"
            : "Generate PDF"}
      </button>
      {state.status === "error" ? (
        <span className="flex flex-wrap items-center gap-2 text-xs text-cs-danger">
          <span>{state.message}</span>
          <button type="button" onClick={onPrint} className={`${LIGHT_BUTTON} px-2.5 py-1 text-xs`}>
            <Printer className="h-3.5 w-3.5" aria-hidden="true" />
            Print instead
          </button>
        </span>
      ) : null}
    </span>
  );
}
