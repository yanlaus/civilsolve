// "Not right? Tell the model what to change": a fold under a solution, the
// reading under review, or the verdict, with the user's instructions and a
// Re-generate button. What is sent with them is the caller's business
// (use-solve.ts refineProvider / refineVerdict, use-interpret.ts revise); the
// hint says what that is, so nobody wonders what the model will see.

import { useState } from "react";
import { ChevronDown, MessageSquarePlus, RotateCw } from "lucide-react";
import { MAX_INSTRUCTIONS_LENGTH } from "../../../shared/stream-protocol";

export function RevisePanel({
  title,
  hint,
  placeholder,
  buttonLabel = "Re-generate",
  disabledReason,
  onSubmit,
}: {
  title: string;
  /** What goes back to the model with the instructions. */
  hint: string;
  placeholder: string;
  buttonLabel?: string;
  /** Set while re-generating cannot start, saying why. */
  disabledReason?: string;
  onSubmit: (instructions: string) => void;
}) {
  const [text, setText] = useState("");
  const wanted = text.trim();
  return (
    <details className="group rounded-cs border border-cs-line-soft bg-cs-surface print:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-semibold text-cs-accent">
        <MessageSquarePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-cs-ink-3 transition group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-cs-line-soft px-4 pb-4 pt-3">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          placeholder={placeholder}
          aria-label="Your instructions"
          className="w-full resize-y rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent focus:ring-4 focus:ring-cs-ring"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={Boolean(disabledReason) || !wanted}
            onClick={() => {
              onSubmit(wanted);
              setText("");
            }}
            className="cs-primary inline-flex items-center gap-2 rounded-cs bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            {buttonLabel}
          </button>
          <span className="min-w-0 flex-1 text-xs text-cs-ink-3">{disabledReason || hint}</span>
        </div>
      </div>
    </details>
  );
}

/** "Re-generated with your instructions: ..." over a re-generated version. */
export function RevisedWith({ instructions }: { instructions: string }) {
  return (
    <p className="mt-1 text-xs text-cs-ink-3">
      Re-generated with your instructions:{" "}
      <span className="italic text-cs-ink-2">&ldquo;{instructions}&rdquo;</span>
    </p>
  );
}

/** Why a re-generation left the previous version on the page. */
export function RevisionNotice({ message }: { message: string }) {
  return (
    <div className="rounded-cs border border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] px-4 py-2 text-sm text-[#a85a12] print:hidden">
      {message}
    </div>
  );
}
