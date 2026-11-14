// The run's course subject (shared/subjects.ts), under the folded form: being
// identified, identified (by DeepSeek or picked by the student), or not -
// then the question is solved without a course guide.

import { GraduationCap, Loader2 } from "lucide-react";
import { subjectName, type SubjectKey } from "../../../shared/subjects";
import { outcomeSubject, type SubjectOutcome } from "@/lib/classify";

export function SubjectBadge({
  outcome,
  subject,
}: {
  /** How this page settled the subject; null for a run picked back up after a reload. */
  outcome: SubjectOutcome | null;
  /** The subject the run was sent with, from its saved body. */
  subject?: SubjectKey;
}) {
  const key = outcomeSubject(outcome) ?? subject;
  if (!outcome && !key) return null;

  let content: React.ReactNode;
  if (outcome?.status === "running") {
    content = (
      <>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cs-accent" aria-hidden="true" />
        <span>DeepSeek is identifying the subject · 分辨緊科目...</span>
      </>
    );
  } else if (outcome?.status === "unknown" || !key) {
    content = (
      <span>
        Subject not identified{outcome?.status === "unknown" ? ` (${outcome.message})` : ""} - solved without a
        course guide. · 分唔到科目，唔用課程指引。
      </span>
    );
  } else {
    const how =
      outcome?.status === "classified"
        ? `Picked by DeepSeek${outcome.result.confidence === "low" ? " (unsure)" : ""}${
            outcome.result.reason ? ` - ${outcome.result.reason}` : ""
          }`
        : outcome?.status === "picked"
          ? "Your pick"
          : "";
    content = (
      <>
        <span className="font-semibold text-cs-ink">{subjectName(key)}</span>
        {key === "other" ? <span className="text-xs text-cs-ink-3">No course guide</span> : null}
        {how ? <span className="text-xs text-cs-ink-3">{how}</span> : null}
        {outcome?.status === "classified" ? (
          <span className="text-xs text-cs-ink-3">
            Wrong? Pick the subject on the form and solve again. · 揀錯？喺表格揀返科目再解。
          </span>
        ) : null}
      </>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-cs border border-cs-line-soft bg-cs-surface px-4 py-2 text-sm text-cs-ink-2 print:hidden">
      <GraduationCap className="h-4 w-4 shrink-0 text-cs-accent" aria-hidden="true" />
      <span className="text-xs font-semibold uppercase tracking-wide text-cs-ink-3">Subject 科目</span>
      {content}
    </div>
  );
}
