// What a Careful or Quick run will do, drawn as its stages with the models'
// logos (the owner asked for icons instead of a line of names, 3 October
// 2026): read the question (two readers, then the reconciler), solve, then
// cross-check. Each logo carries its model's name as a tooltip and for
// screen readers. A stage the run leaves out is still drawn, greyed and
// marked "Skipped" (Quick reads and checks nothing - the owner wanted the
// same three stages there too).

import { ArrowRight, BookOpen, Brain, Calculator, Minus, Scale } from "lucide-react";
import { providerDisplayName, type ModelChoice } from "../../../shared/providers";
import { ProviderLogo } from "./provider-logo";

function Model({ choice }: { choice: ModelChoice }) {
  const name = providerDisplayName(choice.provider, choice.variant);
  return (
    <span
      title={name}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cs-line bg-cs-surface shadow-[0_1px_3px_var(--cs-shadow)]"
    >
      <ProviderLogo provider={choice.provider} className="h-5 w-5" />
      <span className="sr-only">{name}</span>
    </span>
  );
}

/** A stage this run leaves out: an empty slot where the models would be. */
function Skipped({ label = "Skipped · 略過" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-cs-ink-3">
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-cs-line"
      >
        <Minus className="h-3.5 w-3.5" />
      </span>
      {label}
    </span>
  );
}

function Stage({
  icon: Icon,
  label,
  chinese,
  off = false,
  offLabel,
  children,
}: {
  icon: typeof BookOpen;
  label: string;
  chinese: string;
  /** Left out of this run: drawn greyed, with "Skipped" (or `offLabel`) in place of models. */
  off?: boolean;
  offLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={`flex flex-col gap-1.5 ${off ? "opacity-60" : ""}`}>
      <span className="flex items-center gap-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-cs-ink-3">
        <Icon className={`h-3.5 w-3.5 ${off ? "text-cs-ink-3" : "text-cs-accent"}`} aria-hidden="true" />
        {label} · {chinese}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">{off ? <Skipped label={offLabel} /> : children}</span>
    </li>
  );
}

function Step() {
  return (
    // On a phone the stages stack, top to bottom, without the arrows.
    <li aria-hidden="true" className="hidden self-end pb-2 text-cs-ink-3 sm:block">
      <ArrowRight className="h-4 w-4" />
    </li>
  );
}

export function PresetFlow({
  readers,
  reconciler,
  solvers,
  effortLabel,
  judge,
}: {
  /** The reading check's two readers, or null when it is off. */
  readers: [ModelChoice, ModelChoice] | null;
  reconciler: ModelChoice;
  solvers: ModelChoice[];
  effortLabel: string;
  /** The cross-check's judge, or null when there is none. */
  judge: ModelChoice | null;
}) {
  return (
    <ol className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-3" aria-label="What this run does">
      <Stage icon={BookOpen} label="Read" chinese="讀題" off={!readers}>
        {readers ? (
          <>
            <Model choice={readers[0]} />
            <Model choice={readers[1]} />
            <ArrowRight className="h-3.5 w-3.5 text-cs-ink-3" aria-hidden="true" />
            <span className="sr-only">then reconciled by</span>
            <Model choice={reconciler} />
          </>
        ) : null}
      </Stage>
      <Step />
      <Stage icon={Calculator} label="Solve" chinese="解題">
        {solvers.length ? (
          solvers.map((choice) => <Model key={choice.provider} choice={choice} />)
        ) : (
          <span className="text-xs text-cs-ink-3">No solver available</span>
        )}
        <span
          title={`${effortLabel} thinking`}
          className="inline-flex items-center gap-1 rounded-full border border-cs-line-soft bg-cs-muted px-2 py-1 text-xs font-semibold text-cs-ink-2"
        >
          <Brain className="h-3.5 w-3.5 text-cs-accent" aria-hidden="true" />
          {effortLabel}
          <span className="sr-only"> thinking</span>
        </span>
      </Stage>
      <Step />
      {/* Without a judge set, the cross-check is still there - on a tap. */}
      <Stage icon={Scale} label="Check" chinese="核對" off={!judge} offLabel="When you tap it · 撳先做">
        {judge ? <Model choice={judge} /> : null}
      </Stage>
    </ol>
  );
}
