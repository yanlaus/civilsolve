// "Generate PDF": the server prints the answer (GET /api/pdf/:id,
// worker/pdf.ts) and the page offers the link - which replaced the browser's
// print dialog (the owner's call, 29 September 2026; on an iPhone printing
// to PDF was a trip through the share sheet). The PDF is made once, then
// opened from the link: iOS blocks a new tab opened after the wait. The
// server keeps it for good in R2 (since 30 September 2026), so the link
// lasts; the page says so, or that it lasts only as long as the answer when
// the server's storage is full. If the server cannot make it - the month's
// allowance used up, the browser service down - printing from the browser
// is still there.
//
// "Send to WhatsApp" (4 October 2026, the owner's request, for an iPhone): a
// web page cannot open WhatsApp with a file attached, so the PDF goes
// through the share sheet (navigator.share with the file), where WhatsApp is
// one of the apps. iOS opens the sheet only straight from a tap - not after
// waiting for the server - so the page keeps the PDF it fetched and shares
// it the moment the button is tapped; when the tap that started it has
// expired by the time the PDF is made, the page asks for one more. A
// browser that cannot share files sends WhatsApp a link to the PDF instead.

import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Loader2, MessageCircle, Printer } from "lucide-react";
import { formatClock, useNow } from "@/lib/progress";

type PdfState =
  | { status: "idle" }
  /** `forWhatsApp`: started by the WhatsApp button, so it is shared once made. */
  | { status: "working"; startedAt: number; forWhatsApp: boolean }
  /**
   * `forever`: the server keeps the file for good; otherwise only while it
   * keeps the answer. `file`: the PDF itself, kept for the share sheet.
   * `nudge`: a word on sending it, after a share that could not open.
   */
  | { status: "ready"; url: string; forever: boolean; file: File | null; copied?: boolean; nudge?: string }
  | { status: "error"; message: string };

const DARK_BUTTON =
  "inline-flex items-center gap-2 rounded-cs bg-cs-ink font-semibold text-cs-surface transition disabled:cursor-not-allowed disabled:opacity-60";
const LIGHT_BUTTON =
  "inline-flex items-center gap-1.5 rounded-cs border border-cs-line bg-cs-surface font-semibold text-cs-ink-2 transition hover:border-cs-accent hover:text-cs-accent";
// WhatsApp's own green, fixed like the status colours (CLAUDE.md).
const WHATSAPP_BUTTON =
  "inline-flex items-center gap-1.5 rounded-cs border border-[#25D366] bg-cs-surface font-semibold text-[#128C7E] transition hover:bg-[#25D366] hover:text-white disabled:cursor-not-allowed disabled:opacity-60";
const WHATSAPP_BUTTON_STRONG =
  "inline-flex items-center gap-1.5 rounded-cs border border-[#25D366] bg-[#25D366] font-semibold text-white shadow-[0_0_0_4px_rgba(37,211,102,0.2)] transition hover:bg-[#1ebe5a]";

/** The file name the server gave the PDF. */
function fileNameOf(response: Response) {
  const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  return match?.[1] || "civilsolve.pdf";
}

/** Whether this browser can hand a file to the share sheet (iOS 15 and later, Android, Chrome on Windows...). */
function canShareFile(file: File | null): file is File {
  try {
    return Boolean(file && typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }));
  } catch {
    return false;
  }
}

/** A WhatsApp message with the PDF's link, for a browser that cannot share the file itself. */
function whatsAppLink(url: string) {
  const absolute = new URL(url, window.location.href).toString();
  return `https://wa.me/?text=${encodeURIComponent(`CivilSolve PDF: ${absolute}`)}`;
}

/**
 * Opens the share sheet with the PDF. Called first thing in a tap's handler:
 * iOS refuses it once the tap has gone stale ("blocked").
 */
async function shareFile(file: File): Promise<"shared" | "cancelled" | "blocked" | "failed"> {
  try {
    // The file alone: with text beside it, some apps take the text and drop the file.
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError") return "cancelled";
    if (name === "NotAllowedError") return "blocked";
    return "failed";
  }
}

const TAP_AGAIN = "The PDF is ready - tap WhatsApp again to open the share sheet, then pick WhatsApp.";

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

  async function generate(forWhatsApp: boolean) {
    if (!jobId) {
      setState({ status: "error", message: "This answer is not on the server, so it cannot be made into a PDF there." });
      return;
    }
    setState({ status: "working", startedAt: Date.now(), forWhatsApp });
    const url = `/api/pdf/${jobId}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        // Read to the end, so the server has cached the whole file - and
        // kept, so it can be shared without another wait.
        const bytes = await response.arrayBuffer();
        const file = new File([bytes], fileNameOf(response), { type: "application/pdf" });
        const ready = { status: "ready", url, forever: response.headers.get("x-pdf-kept") === "forever", file } as const;
        setState(ready);
        if (forWhatsApp) {
          if (!canShareFile(file)) {
            setState({ ...ready, nudge: "This browser cannot attach the file, so WhatsApp gets a link to the PDF." });
            return;
          }
          // Quick enough (a PDF made before), the tap still counts and the
          // sheet opens; otherwise one more tap.
          const outcome = await shareFile(file);
          if (outcome === "blocked" || outcome === "failed") setState({ ...ready, nudge: TAP_AGAIN });
        }
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
      setState((current) => (current.status === "ready" ? { ...current, copied: true } : current));
    } catch {
      // No clipboard (an old browser, no permission): the link is still there to open.
    }
  }

  async function sendToWhatsApp(file: File) {
    const outcome = await shareFile(file);
    setState((current) =>
      current.status !== "ready"
        ? current
        : outcome === "failed" || outcome === "blocked"
          ? { ...current, nudge: "The share sheet did not open. Open the PDF and send it from there, or copy the link." }
          : { ...current, nudge: undefined },
    );
  }

  if (state.status === "ready") {
    const shareable = canShareFile(state.file);
    return (
      <span className="inline-flex flex-col items-start gap-1.5">
        <span className="inline-flex flex-wrap items-center gap-2">
          <a href={state.url} target="_blank" rel="noopener" className={`${DARK_BUTTON} ${size}`}>
            <ExternalLink className={icon} aria-hidden="true" />
            Open PDF
          </a>
          {shareable ? (
            <button
              type="button"
              onClick={() => void sendToWhatsApp(state.file as File)}
              className={`${state.nudge ? WHATSAPP_BUTTON_STRONG : WHATSAPP_BUTTON} ${size}`}
              title="Opens the share sheet with the PDF - pick WhatsApp, then the chat"
            >
              <MessageCircle className={icon} aria-hidden="true" />
              {/* Short, like Open PDF beside it (the owner, 4 October 2026). */}
              WhatsApp
            </button>
          ) : (
            <a
              href={whatsAppLink(state.url)}
              target="_blank"
              rel="noopener"
              className={`${WHATSAPP_BUTTON} ${size}`}
              title="Opens WhatsApp with a message holding the PDF's link"
            >
              <MessageCircle className={icon} aria-hidden="true" />
              WhatsApp link
            </a>
          )}
          <button type="button" onClick={() => void copyLink(state.url)} className={`${LIGHT_BUTTON} ${size}`}>
            {state.copied ? <Check className={icon} aria-hidden="true" /> : <Copy className={icon} aria-hidden="true" />}
            {state.copied ? "Link copied" : "Copy link"}
          </button>
        </span>
        {state.nudge ? <span className="text-xs font-semibold text-[#128C7E]">{state.nudge}</span> : null}
        <span className="text-xs text-cs-ink-3">
          {state.forever
            ? "Saved on the server - the link keeps working."
            : "The server's PDF storage is full, so this link works only while the answer is kept (24 hours). Save the PDF to keep it."}
        </span>
      </span>
    );
  }

  const working = state.status === "working";
  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void generate(false)}
          disabled={working}
          className={`${DARK_BUTTON} ${size}`}
          title="The server makes the PDF, keeps it, and gives you a link to it"
        >
          {working && !state.forWhatsApp ? (
            <Loader2 className={`${icon} animate-spin`} aria-hidden="true" />
          ) : (
            <Download className={icon} aria-hidden="true" />
          )}
          {working && !state.forWhatsApp
            ? `Generating PDF... ${formatClock(now - state.startedAt)}`
            : state.status === "error"
              ? "Try again"
              : "Generate PDF"}
        </button>
        <button
          type="button"
          onClick={() => void generate(true)}
          disabled={working}
          className={`${WHATSAPP_BUTTON} ${size}`}
          title="Makes the PDF, then opens the share sheet with it - pick WhatsApp"
        >
          {working && state.forWhatsApp ? (
            <Loader2 className={`${icon} animate-spin`} aria-hidden="true" />
          ) : (
            <MessageCircle className={icon} aria-hidden="true" />
          )}
          {working && state.forWhatsApp
            ? `Preparing... ${formatClock(now - state.startedAt)}`
            : "WhatsApp"}
        </button>
      </span>
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
