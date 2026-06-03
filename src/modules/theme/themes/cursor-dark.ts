import type { Theme } from "../types";

const CURSOR_ANSI = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
] as const;

export const cursorDark: Theme = {
  id: "cursor-dark",
  name: "Cursor Dark",
  description: "Anysphere Dark — the default Cursor IDE theme.",
  editorTheme: { dark: "cursor-dark" },
  variants: {
    dark: {
      colors: {
        background: "#191919",
        foreground: "#d4d4d4",
        card: "#252526",
        cardForeground: "#d4d4d4",
        popover: "#252526",
        popoverForeground: "#d4d4d4",
        primary: "#4e9eff",
        primaryForeground: "#191919",
        secondary: "#2d2d2d",
        secondaryForeground: "#d4d4d4",
        muted: "#2d2d2d",
        mutedForeground: "#858585",
        accent: "#2d2d2d",
        accentForeground: "#d4d4d4",
        destructive: "#f44747",
        border: "rgba(255,255,255,0.08)",
        input: "rgba(255,255,255,0.10)",
        ring: "#4e9eff",
        sidebar: "#141414",
        sidebarForeground: "#d4d4d4",
        sidebarPrimary: "#4e9eff",
        sidebarPrimaryForeground: "#191919",
        sidebarAccent: "#2d2d2d",
        sidebarAccentForeground: "#d4d4d4",
        sidebarBorder: "rgba(255,255,255,0.06)",
        sidebarRing: "#4e9eff",
      },
      terminal: {
        background: "#191919",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        cursorAccent: "#191919",
        selection: "rgba(78,158,255,0.22)",
        ansi: CURSOR_ANSI,
      },
    },
  },
};
