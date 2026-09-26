import { createContext, useContext, useEffect, useState } from "react";

// Every theme is light: the owner ruled out a dark theme. The colours live in
// styles.css under [data-theme="..."]; this only picks one.
export type ThemeId = "classic" | "slate" | "graphite" | "unicorn";

export const THEMES: Array<{ id: ThemeId; label: string; description: string }> = [
  { id: "classic", label: "Classic", description: "Warm drafting paper, copper accent" },
  { id: "slate", label: "Slate", description: "Cool grey with engineering blue" },
  { id: "graphite", label: "Graphite", description: "Neutral grey, deep teal, square edges" },
  { id: "unicorn", label: "Unicorn", description: "Gundam-inspired white armour and gold" },
];

const DEFAULT_THEME: ThemeId = "classic";
const STORAGE_KEY = "civilsolve-theme";

function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme;
}

type ThemeProviderState = {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = (next: ThemeId) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    setThemeState(next);
  };

  return (
    <ThemeProviderContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
