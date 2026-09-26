import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Palette } from "lucide-react";
import { THEMES, useTheme, type ThemeId } from "@/components/theme-provider";

/** A miniature of the theme, drawn with its own tokens (data-theme scopes them). */
function ThemeSwatch({ id }: { id: ThemeId }) {
  return (
    <span
      data-theme={id}
      aria-hidden="true"
      className="relative block h-9 w-12 shrink-0 overflow-hidden rounded-cs border border-cs-line bg-cs-page"
    >
      <span className="absolute left-1.5 top-1.5 h-4 w-7 rounded-cs border border-cs-line-soft bg-cs-surface" />
      <span className="absolute bottom-1.5 right-1.5 h-3 w-3 rounded-full bg-cs-accent" />
      <span className="absolute bottom-2 left-1.5 h-1 w-4 rounded-full bg-cs-ink-3" />
    </span>
  );
}

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const current = THEMES.find((option) => option.id === theme) ?? THEMES[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative print:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="theme-options"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-cs border border-cs-line bg-cs-surface px-3 py-1.5 text-xs font-semibold text-cs-ink-2 shadow-[0_1px_3px_var(--cs-shadow)] transition hover:border-cs-accent hover:text-cs-accent"
      >
        <Palette className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          <span className="hidden sm:inline">Theme: </span>
          {current.label}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          id="theme-options"
          role="group"
          aria-label="Theme"
          className="absolute right-0 z-30 mt-2 w-[min(18rem,calc(100vw-2.5rem))] rounded-cs-lg border border-cs-line bg-cs-surface p-1.5 shadow-[0_10px_30px_var(--cs-shadow)]"
        >
          {THEMES.map((option) => {
            const active = option.id === theme;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setTheme(option.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-cs px-2.5 py-2 text-left transition hover:bg-cs-muted ${
                  active ? "bg-cs-muted" : ""
                }`}
              >
                <ThemeSwatch id={option.id} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-cs-ink">{option.label}</span>
                  <span className="block text-xs text-cs-ink-3">{option.description}</span>
                </span>
                {active ? (
                  <Check className="h-4 w-4 shrink-0 text-cs-accent" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
