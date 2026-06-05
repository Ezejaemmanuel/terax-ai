// Lazy, singleton Shiki highlighter used ONLY for user-imported VSCode themes.
// Built-in editor themes keep using the synchronous @uiw/codemirror-theme-*
// (Lezer) path — Shiki (Oniguruma WASM + TextMate grammars) is loaded on demand
// the first time a custom theme is actually rendered, so users who never import
// a theme never pay for it.
import type { Highlighter, ThemedToken } from "shiki";
import type { CustomEditorTheme } from "../../customEditorThemes";

let highlighter: Highlighter | null = null;
let creating: Promise<Highlighter> | null = null;
const loadedThemes = new Set<string>();
const loadedLangs = new Set<string>();
// Languages Shiki failed to load (unsupported id) — tokenized as plaintext.
const failedLangs = new Set<string>();

async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (!creating) {
    // Dynamic import: the Shiki engine (Oniguruma WASM + grammar registry) is
    // only pulled in the first time a user-imported theme is actually rendered.
    creating = import("shiki")
      .then(({ createHighlighter }) =>
        createHighlighter({ themes: [], langs: [] }),
      )
      .then((h) => {
        highlighter = h;
        return h;
      });
  }
  return creating;
}

/** Map a file path to a Shiki bundled-language id. Returns "plaintext" when unknown. */
export function shikiLangForPath(path: string | null | undefined): string {
  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  py: "python",
  rs: "rust",
  go: "go",
  php: "php",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  dockerfile: "docker",
};

/** True when the highlighter, theme and language are all loaded → tokenize is sync. */
export function isReady(themeName: string, langId: string): boolean {
  if (!highlighter || !loadedThemes.has(themeName)) return false;
  return langId === "plaintext" || loadedLangs.has(langId) || failedLangs.has(langId);
}

/** Ensure the highlighter, a theme and a language are loaded. Idempotent. */
export async function ensure(theme: CustomEditorTheme, langId: string): Promise<void> {
  const h = await getHighlighter();
  if (!loadedThemes.has(theme.id)) {
    // Register under the theme's stable id so two imports can't collide on name.
    const json = { ...theme.rawJson, name: theme.id };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await h.loadTheme(json as any);
      loadedThemes.add(theme.id);
    } catch {
      /* malformed theme — leave unloaded; tokenize() will bail */
    }
  }
  if (langId !== "plaintext" && !loadedLangs.has(langId) && !failedLangs.has(langId)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await h.loadLanguage(langId as any);
      loadedLangs.add(langId);
    } catch {
      failedLangs.add(langId);
    }
  }
}

/** Synchronous tokenize. Returns null if not yet ready. */
export function tokenize(
  code: string,
  langId: string,
  themeName: string,
): ThemedToken[][] | null {
  if (!highlighter || !loadedThemes.has(themeName)) return null;
  const lang = loadedLangs.has(langId) ? langId : "plaintext";
  try {
    return highlighter.codeToTokens(code, {
      // lang/theme are dynamic ids registered at runtime; Shiki's static union
      // types don't cover them.
      lang: lang as Parameters<typeof highlighter.codeToTokens>[1]["lang"],
      theme: themeName,
      includeExplanation: false,
    }).tokens;
  } catch {
    return null;
  }
}
