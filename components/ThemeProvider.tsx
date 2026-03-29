"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "tiktok-ui-theme";

type Ctx = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  mounted: boolean;
};

const ThemeContext = createContext<Ctx | null>(null);

function applyClass(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    let next: Theme;
    if (stored === "dark" || stored === "light") next = stored;
    else next = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    applyClass(next);
    queueMicrotask(() => {
      setThemeState(next);
      setMounted(true);
    });
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
    applyClass(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const t = prev === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, t);
      applyClass(t);
      return t;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle, mounted }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
