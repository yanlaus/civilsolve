// A section's heading - Solutions, Cross-check, Study notes - that stays at
// the top of the screen, right under the step bar, while the student is in
// that section, so they always know where they are (the owner's request,
// 11 October 2026). It sticks only within its own section and scrolls away
// with it. Its height is --cs-section-h (styles.css), so the solution tabs
// can stick right under it.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function StickyHeading({
  id,
  icon: Icon,
  title,
  chinese,
  iconClassName = "text-cs-accent",
  className = "",
}: {
  id?: string;
  icon: LucideIcon;
  title: ReactNode;
  chinese: string;
  iconClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={`sticky top-[var(--cs-journey-h,0px)] z-20 -mx-5 flex h-[var(--cs-section-h)] items-center bg-cs-page/95 px-5 backdrop-blur sm:-mx-6 sm:px-6 print:static ${className}`}
    >
      <h2
        id={id}
        className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap font-display text-xl font-bold text-cs-ink sm:text-2xl"
      >
        <Icon className={`h-5 w-5 shrink-0 self-center ${iconClassName}`} aria-hidden="true" />
        {title}
        <span className="truncate font-sans text-sm font-normal text-cs-ink-3 sm:text-base">{chinese}</span>
      </h2>
    </div>
  );
}
