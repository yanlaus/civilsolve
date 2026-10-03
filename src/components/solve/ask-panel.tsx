// "Ask about this step · 問呢一步" under a solution (3 October 2026): a
// student's questions about it, and the answers, as a thread - one per
// solver's solution (hooks/use-ask.ts). A question can quote a step: the
// "Ask about this step" buttons beside the steps put it here. Unlike
// "Re-generate", nothing is rewritten: the model explains what was asked.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, MessageCircleQuestion, RotateCw, Send, X } from "lucide-react";
import { EFFORT_KEYS, type EffortKey } from "../../../shared/prompt";
import {
  choiceKey,
  MODEL_CHOICES,
  parseChoice,
  providerDisplayName,
  type ModelChoice,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import type { ProviderArtifact } from "../../../shared/solution";
import type { SolutionStep } from "../../../shared/steps";
import type { AskThreads, AskWriter } from "@/hooks/use-ask";
import { effortBand } from "@/lib/effort-band";
import { prefersReducedMotion } from "@/lib/journey";
import type { Progress } from "@/lib/progress";
import MathProse from "./math-prose";
import { MathTitle } from "./math-title";
import { ERROR_BOX, ProgressBox, STOPPED_BOX, TIMEOUT_BOX } from "./task-status";

const SELECT_CLASS =
  "mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent disabled:opacity-50";

export function AskPanel({
  provider,
  label,
  solution,
  version,
  threads,
  progress,
  now,
  defaultModel,
  providerStatus,
  disabledReason,
  step,
  stepPickedAt,
  onClearStep,
  onAsk,
  onStop,
}: {
  provider: ProviderKey;
  /** The solver's name, as its tab shows it. */
  label: string;
  solution: ProviderArtifact;
  /** The solution's version on the page, to tell which answers are about an earlier one. */
  version: number;
  threads: AskThreads;
  progress: Record<string, Progress>;
  now: number;
  /** The model that wrote the solution: who answers unless the student picks another. */
  defaultModel: ModelChoice;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  /** Why a question cannot be sent now; undefined when it can. */
  disabledReason?: string;
  /** The step a question will quote, when one was picked. */
  step: SolutionStep | null;
  /** When the step was picked: each pick brings the question box into view. */
  stepPickedAt?: number;
  onClearStep: () => void;
  onAsk: (question: string, writer: AskWriter, step?: SolutionStep) => void;
  onStop: (id: string) => void;
}) {
  const thread = threads[provider] ?? [];
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [modelPick, setModelPick] = useState<ModelChoice | null>(null);
  const [effortPick, setEffortPick] = useState<EffortKey>("medium");
  const box = useRef<HTMLTextAreaElement>(null);
  const configured = (key: ProviderKey) => (providerStatus ? providerStatus[key]?.configured !== false : true);
  const model = modelPick ?? defaultModel;
  const { inBand, clamp } = effortBand(providerStatus?.[model.provider]);
  const effort = clamp(effortPick);

  // A new question (or one picked back up after a reload) opens the fold.
  useEffect(() => {
    if (thread.length) setOpen(true);
  }, [thread.length]);

  // A step picked from beside the working opens the fold and takes the
  // student to the question box, in the middle of the screen, ready to type -
  // a focus alone left it at the screen's edge, or out of sight under a long
  // solution (the owner, 3 October 2026).
  useEffect(() => {
    if (!step) return;
    setOpen(true);
    const frame = requestAnimationFrame(() => {
      const element = box.current;
      if (!element) return;
      element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [step, stepPickedAt]);

  const send = () => {
    if (!question.trim() || disabledReason) return;
    onAsk(question, { provider: model.provider, variant: model.variant, effort }, step ?? undefined);
    setQuestion("");
    onClearStep();
  };

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
      className="group mb-3 rounded-cs border border-cs-line-soft bg-cs-surface"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-cs-ink">
        <MessageCircleQuestion className="h-4 w-4 text-cs-accent" aria-hidden="true" />
        唔明？問吓 · Ask about this solution
        {thread.length ? (
          <span className="text-xs font-normal text-cs-ink-3">
            {thread.length} question{thread.length === 1 ? "" : "s"}
          </span>
        ) : null}
        <ChevronDown className="ml-auto h-4 w-4 text-cs-ink-3 transition group-open:rotate-180" aria-hidden="true" />
      </summary>

      <div className="space-y-3 border-t border-cs-line-soft px-4 py-3">
        {thread.map((turn) => (
          <div key={turn.id} className="space-y-2">
            <div className="ml-auto max-w-[90%] rounded-cs bg-cs-muted px-3 py-2 text-sm text-cs-ink">
              {turn.step ? (
                <div className="mb-1 text-xs font-semibold text-cs-ink-3">
                  About: <MathTitle text={turn.step.title} />
                </div>
              ) : null}
              <div className="whitespace-pre-wrap">{turn.question}</div>
            </div>
            {turn.status === "done" ? (
              <div className="rounded-cs border border-cs-line-soft px-3 py-1">
                <MathProse source={turn.answer ?? ""} chinese={/[一-鿿]/.test(turn.answer ?? "")} />
                <div className="pb-1 text-[0.7rem] text-cs-ink-3">
                  {providerDisplayName(turn.writer.provider, turn.writer.variant)}
                  {turn.model ? ` · ${turn.model}` : ""}
                  {turn.version !== version ? " · about an earlier version of this solution" : ""}
                </div>
              </div>
            ) : turn.status === "error" ? (
              <div
                className={`rounded-cs border px-3 py-2 text-sm ${
                  turn.stopped ? STOPPED_BOX : turn.timedOut ? TIMEOUT_BOX : ERROR_BOX
                }`}
              >
                {turn.message}
                {!disabledReason ? (
                  <button
                    type="button"
                    onClick={() =>
                      onAsk(turn.question, turn.writer, turn.step ? { ...turn.step } : undefined)
                    }
                    className="ml-2 inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Ask again
                  </button>
                ) : null}
              </div>
            ) : (
              <ProgressBox
                now={now}
                progress={progress[turn.id]}
                line={
                  turn.status === "streaming"
                    ? `${providerDisplayName(turn.writer.provider, turn.writer.variant)} is answering... ${(turn.charsReceived ?? 0).toLocaleString()} characters.`
                    : (turn.message ?? "Waiting...")
                }
                onStop={() => onStop(turn.id)}
                stopTitle="Stop this answer"
              />
            )}
          </div>
        ))}

        {step ? (
          <div className="flex items-start gap-2 rounded-cs border border-cs-accent bg-cs-muted px-3 py-2 text-xs text-cs-ink-2">
            <span className="min-w-0 flex-1">
              <span className="font-semibold">Asking about:</span> <MathTitle text={step.title} />
            </span>
            <button type="button" onClick={onClearStep} aria-label="Ask about the whole solution instead">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        <textarea
          ref={box}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              send();
            }
          }}
          rows={3}
          maxLength={2000}
          aria-label={`Your question about ${label}'s solution`}
          // Plain words: a placeholder is not typeset, so $F_x$ showed as typed.
          placeholder="e.g. 點解水平方向嘅力係負數？ / Why is the pressure force added here?"
          className="w-full resize-y rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent focus:ring-4 focus:ring-cs-ring"
        />
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="block text-xs text-cs-ink-3">
            Answered by
            <select
              value={choiceKey(model)}
              onChange={(event) => {
                const next = parseChoice(event.target.value);
                if (next) setModelPick(next);
              }}
              className={SELECT_CLASS}
            >
              {MODEL_CHOICES.filter((choice) => configured(choice.provider)).map((choice) => (
                <option key={choiceKey(choice)} value={choiceKey(choice)}>
                  {providerDisplayName(choice.provider, choice.variant)}
                  {choiceKey(choice) === choiceKey(defaultModel) ? " (wrote this solution)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-cs-ink-3">
            Thinking
            <select
              value={effort}
              onChange={(event) => setEffortPick(event.target.value as EffortKey)}
              className={SELECT_CLASS}
            >
              {EFFORT_KEYS.map((key) => (
                <option key={key} value={key} disabled={!inBand(key)}>
                  {key.charAt(0).toUpperCase() + key.slice(1)}
                  {key === "medium" ? " (default)" : ""}
                  {inBand(key) ? "" : " - not offered"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={send}
            disabled={!question.trim() || Boolean(disabledReason)}
            className="cs-primary inline-flex items-center justify-center gap-2 rounded-cs bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Ask · 問
          </button>
        </div>
        <p className="text-[0.7rem] text-cs-ink-3">
          {disabledReason ??
            "One model call per question. Ask in Chinese and it answers in Cantonese; in English, in English. The solution itself is not changed."}
        </p>
      </div>
    </details>
  );
}
