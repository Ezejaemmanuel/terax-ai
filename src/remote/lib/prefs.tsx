import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const KEY_ACCORDIONS = "terax-remote-accordions-open";
const KEY_THEME = "terax-remote-theme";

export type RemoteTheme = "light" | "dark";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
  } catch {
    // private mode / blocked storage
  }
  return fallback;
}

function readTheme(): RemoteTheme {
  try {
    const stored = localStorage.getItem(KEY_THEME);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export interface RemotePrefs {
  accordionsOpen: boolean;
  setAccordionsOpen: (value: boolean) => void;
  theme: RemoteTheme;
  setTheme: (value: RemoteTheme) => void;
  toggleTheme: () => void;
}

const Ctx = createContext<RemotePrefs | null>(null);

export function RemotePrefsProvider({ children }: { children: ReactNode }) {
  // Open by default: on a phone a closed tool stack hides the run.
  const [accordionsOpen, setAccordionsOpenState] = useState(() =>
    readBool(KEY_ACCORDIONS, true),
  );
  const [theme, setThemeState] = useState<RemoteTheme>(readTheme);

  const setAccordionsOpen = useCallback((value: boolean) => {
    setAccordionsOpenState(value);
    try {
      localStorage.setItem(KEY_ACCORDIONS, value ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);

  const setTheme = useCallback((value: RemoteTheme) => {
    setThemeState(value);
    document.documentElement.classList.toggle("dark", value === "dark");
    document.documentElement.style.backgroundColor =
      value === "dark" ? "#0a0a0a" : "#ffffff";
    try {
      localStorage.setItem(KEY_THEME, value);
    } catch {
      // ignore
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  const value = useMemo(
    () => ({
      accordionsOpen,
      setAccordionsOpen,
      theme,
      setTheme,
      toggleTheme,
    }),
    [accordionsOpen, setAccordionsOpen, theme, setTheme, toggleTheme],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRemotePrefs(): RemotePrefs {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useRemotePrefs requires RemotePrefsProvider");
  }
  return ctx;
}
