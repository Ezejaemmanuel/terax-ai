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
        background: "#181818",
        foreground: "#d6d6dd",
        card: "#222222",
        cardForeground: "#d6d6dd",
        popover: "#222222",
        popoverForeground: "#d6d6dd",
        primary: "#94c1fa",
        primaryForeground: "#181818",
        secondary: "#2a2a2a",
        secondaryForeground: "#d6d6dd",
        muted: "#2a2a2a",
        mutedForeground: "#6d6d6d",
        accent: "#2a2a2a",
        accentForeground: "#d6d6dd",
        destructive: "#f44747",
        border: "rgba(255,255,255,0.07)",
        input: "rgba(255,255,255,0.09)",
        ring: "#94c1fa",
        sidebar: "#181818",
        sidebarForeground: "#d6d6dd",
        sidebarPrimary: "#94c1fa",
        sidebarPrimaryForeground: "#181818",
        sidebarAccent: "#2a2a2a",
        sidebarAccentForeground: "#d6d6dd",
        sidebarBorder: "rgba(255,255,255,0.07)",
        sidebarRing: "#94c1fa",
      },
      terminal: {
        background: "#181818",
        foreground: "#d6d6dd",
        cursor: "#d6d6dd",
        cursorAccent: "#181818",
        selection: "rgba(22,55,97,0.6)",
        ansi: CURSOR_ANSI,
      },
    },
  },
};
