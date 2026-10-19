// The usage page (/admin/usage, 19 October 2026, the owner's request): the
// server's usage log (worker/usage.ts) read in the app instead of the
// Cloudflare dashboard - totals, each day, each IP, each part of the page and
// model, and the latest tasks, each with its answer while the server still
// keeps it (24 hours) and its PDF if one was made. No password (the owner's
// call): anyone with the link can read it. Tap an IP or a question to see
// only its rows.
// Lazy-loaded by App.tsx on this path only, so the main page never carries it.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, FileDown, RefreshCw, X } from "lucide-react";
import { isProviderKey, providerDisplayName, type ModelVariant } from "../../shared/providers";
import { usagePartLabel, type UsageMetrics, type UsageReport } from "../../shared/usage-report";
import { AnswerViewer } from "@/components/usage/answer-viewer";
import { RETENTION_MS } from "@/lib/run-store";

type RecentRow = UsageReport["recent"][number];

/** Whether the row's answer is still in its job: a finished task, under 24 hours old. */
function answerKept(row: RecentRow, now: number) {
  return row.kind !== "pdf" && row.outcome === "done" && Boolean(row.jobId) && row.endedAt !== null && now - row.endedAt < RETENTION_MS;
}

/** The row's links: its stored answer and its PDF, each only when it exists. */
function AnswerLinks({ row, now, onView }: { row: RecentRow; now: number; onView: (row: RecentRow) => void }) {
  const view = answerKept(row, now);
  if (!view && !row.pdf) return <span className="text-cs-ink-3">–</span>;
  return (
    <span className="inline-flex items-center gap-2.5">
      {view ? (
        <button
          type="button"
          onClick={() => onView(row)}
          className="text-xs font-semibold text-cs-accent underline-offset-2 hover:underline"
          title="The answer, as the server keeps it for 24 hours after it finished"
        >
          View
        </button>
      ) : null}
      {row.pdf ? (
        <a
          href={`/api/pdf/${row.jobId}?existing`}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-0.5 text-xs font-semibold text-cs-accent underline-offset-2 hover:underline"
          title="The PDF the student had made, kept for good"
        >
          <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
          PDF
        </a>
      ) : null}
    </span>
  );
}

const RANGES = [
  { days: 1, label: "Last 24 hours" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "Everything" },
];

function formatTime(ms: number) {
  try {
    return new Date(ms).toLocaleString("en-HK", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

const count = (value: number | null | undefined) => (value ?? 0).toLocaleString("en-HK");

function modelName(provider: string | null, variant: string | null) {
  if (!provider) return "–";
  return isProviderKey(provider)
    ? providerDisplayName(provider, (variant ?? undefined) as ModelVariant | undefined)
    : provider;
}

// Status colours stay fixed, as elsewhere in the app.
const OUTCOME_STYLES: Record<string, string> = {
  done: "bg-[#e7f5ec] text-[#1e6b3a]",
  error: "bg-[#fdecea] text-[#a8321f]",
  timeout: "bg-[#fff1e6] text-[#b45309]",
  cancelled: "bg-[#eef0f2] text-[#4b5563]",
  running: "bg-[#e8effd] text-[#1d4ed8]",
  rejected: "bg-[#fef6e0] text-[#92400e]",
  "rate-limited": "bg-[#fef6e0] text-[#92400e]",
};

function Outcome({ value, error }: { value: string; error?: string | null }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${OUTCOME_STYLES[value] ?? OUTCOME_STYLES.cancelled}`}
      title={error ?? undefined}
    >
      {value}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-cs border border-cs-line bg-cs-surface px-3 py-2.5">
      <div className="text-xs text-cs-ink-3">{label}</div>
      <div className="mt-0.5 font-display text-2xl text-cs-ink tabular-nums">{count(value)}</div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-lg text-cs-ink">{title}</h2>
      {note ? <p className="mt-0.5 text-xs text-cs-ink-3">{note}</p> : null}
      <div className="mt-2 overflow-x-auto rounded-cs border border-cs-line bg-cs-surface">{children}</div>
    </section>
  );
}

function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty: boolean }) {
  return (
    <table className="w-full min-w-max border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-cs-line bg-cs-muted text-xs text-cs-ink-3">
          {head.map((cell) => (
            <th key={cell} className="whitespace-nowrap px-3 py-2 font-semibold">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="text-cs-ink-2">
        {empty ? (
          <tr>
            <td colSpan={head.length} className="px-3 py-4 text-center text-cs-ink-3">
              Nothing in this range.
            </td>
          </tr>
        ) : (
          children
        )}
      </tbody>
    </table>
  );
}

const cell = "whitespace-nowrap px-3 py-1.5 tabular-nums";
const row = "border-b border-cs-line-soft last:border-0";

function FilterButton({ label, onClick, title }: { label: string; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="font-mono text-xs text-cs-accent underline-offset-2 hover:underline"
    >
      {label}
    </button>
  );
}

function MetricCells({ metrics }: { metrics: UsageMetrics }) {
  return (
    <>
      <td className={cell}>{count(metrics.questions)}</td>
      <td className={cell}>{count(metrics.tasks)}</td>
      <td className={cell}>{count(metrics.modelCalls)}</td>
      <td className={cell}>{count(metrics.failed)}</td>
      <td className={cell}>{count(metrics.turnedAway)}</td>
    </>
  );
}

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const [ip, setIp] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<RecentRow | null>(null);

  useEffect(() => {
    document.title = "Usage log · CivilSolve";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.appendChild(robots);
    return () => robots.remove();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ days: String(days) });
    if (ip) query.set("ip", ip);
    if (question) query.set("question", question);
    try {
      const response = await fetch(`/api/admin/usage?${query}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as UsageReport & { error?: string };
      if (!response.ok) {
        setError(body.error ?? `The usage log could not be read (HTTP ${response.status}).`);
        return;
      }
      setReport(body);
    } catch {
      setError("The usage log could not be reached. Check the connection and refresh.");
    } finally {
      setLoading(false);
    }
  }, [days, ip, question]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="min-h-screen bg-cs-page px-4 pb-16 pt-5 text-cs-ink">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <a href="/" className="inline-flex items-center gap-1 text-xs text-cs-ink-3 hover:text-cs-accent">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              CivilSolve
            </a>
            <h1 className="font-display text-2xl text-cs-ink">Usage log · 使用紀錄</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Time range"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="rounded-cs border border-cs-line bg-cs-surface px-2 py-1.5 text-sm text-cs-ink"
            >
              {RANGES.map((range) => (
                <option key={range.days} value={range.days}>
                  {range.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-cs border border-cs-line bg-cs-surface px-2.5 py-1.5 text-sm text-cs-ink-2 hover:border-cs-accent disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </header>

        {ip || question ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-cs-ink-3">Showing only</span>
            {ip ? (
              <button
                type="button"
                onClick={() => setIp(null)}
                className="inline-flex items-center gap-1 rounded-full border border-cs-line bg-cs-surface px-2.5 py-0.5 font-mono text-xs"
              >
                IP {ip}
                <X className="h-3 w-3" aria-label="Clear" />
              </button>
            ) : null}
            {question ? (
              <button
                type="button"
                onClick={() => setQuestion(null)}
                className="inline-flex items-center gap-1 rounded-full border border-cs-line bg-cs-surface px-2.5 py-0.5 font-mono text-xs"
              >
                Question {question.slice(0, 8)}
                <X className="h-3 w-3" aria-label="Clear" />
              </button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 rounded-cs border border-[#f3c4bd] bg-[#fdecea] px-3 py-2 text-sm text-[#a8321f]">{error}</p>
        ) : null}

        {report ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="Questions 題目" value={report.totals.questions} />
              <Stat label="Users (IPs) 用戶" value={report.totals.users} />
              <Stat label="Tasks 任務" value={report.totals.tasks} />
              <Stat label="Model calls" value={report.totals.modelCalls} />
              <Stat label="Failed 失敗" value={report.totals.failed} />
              <Stat label="Turned away 拒絕" value={report.totals.turnedAway} />
              <Stat label="PDFs" value={report.totals.pdfs} />
            </div>
            <p className="mt-2 text-xs text-cs-ink-3">
              Updated {formatTime(report.generatedAt)}. Days are Hong Kong days. A question is one set of pages;
              model calls count every attempt, retry and fallback.
            </p>

            <Section title="Each day · 每日">
              <Table
                head={["Day", "Questions", "Users", "Tasks", "Model calls", "Failed", "Turned away"]}
                empty={!report.daily.length}
              >
                {report.daily.map((day) => (
                  <tr key={day.day} className={row}>
                    <td className={cell}>{day.day}</td>
                    <td className={cell}>{count(day.questions)}</td>
                    <td className={cell}>{count(day.users)}</td>
                    <td className={cell}>{count(day.tasks)}</td>
                    <td className={cell}>{count(day.modelCalls)}</td>
                    <td className={cell}>{count(day.failed)}</td>
                    <td className={cell}>{count(day.turnedAway)}</td>
                  </tr>
                ))}
              </Table>
            </Section>

            <Section title="Each IP · 每個 IP" note="Most model calls first. Tap an IP to see only its rows.">
              <Table
                head={["IP", "Country", "Questions", "Tasks", "Model calls", "Failed", "Turned away", "Last seen"]}
                empty={!report.byIp.length}
              >
                {report.byIp.map((entry) => (
                  <tr key={entry.ip ?? "none"} className={row}>
                    <td className={cell}>
                      {entry.ip ? (
                        <FilterButton label={entry.ip} title="Only this IP" onClick={() => setIp(entry.ip)} />
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className={cell}>{entry.country ?? "–"}</td>
                    <MetricCells metrics={entry} />
                    <td className={cell}>{formatTime(entry.lastSeen)}</td>
                  </tr>
                ))}
              </Table>
            </Section>

            <Section title="Each part and model · 每部分同 model" note="Tasks let through; average time is of the finished ones.">
              <Table
                head={["Part", "Model", "Tasks", "Model calls", "Done", "Failed", "Stopped", "Average time"]}
                empty={!report.byPart.length}
              >
                {report.byPart.map((part, index) => (
                  <tr key={index} className={row}>
                    <td className={cell}>{usagePartLabel(part.kind, part.detail)}</td>
                    <td className={cell}>
                      <span className="text-cs-ink">{modelName(part.provider, part.variant)}</span>
                      {part.model ? <span className="ml-1.5 text-xs text-cs-ink-3">{part.model}</span> : null}
                    </td>
                    <td className={cell}>{count(part.tasks)}</td>
                    <td className={cell}>{count(part.modelCalls)}</td>
                    <td className={cell}>{count(part.done)}</td>
                    <td className={cell}>{count(part.failed)}</td>
                    <td className={cell}>{count(part.cancelled)}</td>
                    <td className={cell}>{formatDuration(part.avgDoneMs)}</td>
                  </tr>
                ))}
              </Table>
            </Section>

            <Section
              title="Latest · 最近"
              note={`The latest ${report.recent.length} rows, newest first. Tap a question to see everything asked about it; hover an outcome for its error. View opens an answer while the server keeps it (24 hours after it finished); PDF is one the student had made. The question's pages are never kept on the server.`}
            >
              <Table
                head={["Time", "IP", "Part", "Model", "Calls", "Outcome", "Took", "Answer", "Question", "Pages"]}
                empty={!report.recent.length}
              >
                {report.recent.map((entry) => (
                  <tr key={entry.id} className={row}>
                    <td className={cell}>{formatTime(entry.startedAt)}</td>
                    <td className={cell}>
                      {entry.ip ? (
                        <FilterButton label={entry.ip} title="Only this IP" onClick={() => setIp(entry.ip)} />
                      ) : (
                        "–"
                      )}
                      {entry.country ? <span className="ml-1 text-xs text-cs-ink-3">{entry.country}</span> : null}
                    </td>
                    <td className={cell}>{usagePartLabel(entry.kind, entry.detail, entry.revision)}</td>
                    <td className={cell}>
                      <span className="text-cs-ink">{modelName(entry.provider, entry.variant)}</span>
                      {entry.effort ? <span className="ml-1.5 text-xs text-cs-ink-3">{entry.effort}</span> : null}
                    </td>
                    <td className={cell}>{entry.modelCalls ?? "–"}</td>
                    <td className={cell}>
                      <Outcome value={entry.outcome} error={entry.error} />
                    </td>
                    <td className={cell}>{formatDuration(entry.durationMs)}</td>
                    <td className={cell}>
                      <AnswerLinks row={entry} now={report.generatedAt} onView={setViewing} />
                    </td>
                    <td className={cell}>
                      {entry.question ? (
                        <FilterButton
                          label={entry.question.slice(0, 8)}
                          title="Everything asked about this question"
                          onClick={() => setQuestion(entry.question)}
                        />
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className={cell}>{entry.pages || "–"}</td>
                  </tr>
                ))}
              </Table>
            </Section>
          </>
        ) : loading ? (
          <p className="mt-6 text-sm text-cs-ink-3">Reading the usage log...</p>
        ) : null}
      </div>
      {viewing ? <AnswerViewer row={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
