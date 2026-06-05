import { atomone } from "@uiw/codemirror-theme-atomone";
import { aura } from "@uiw/codemirror-theme-aura";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { gruvboxDark } from "@uiw/codemirror-theme-gruvbox-dark";
import { nord } from "@uiw/codemirror-theme-nord";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { xcodeDark, xcodeLight } from "@uiw/codemirror-theme-xcode";
import type { Extension } from "@codemirror/state";
import type { EditorThemeId } from "@/modules/settings/store";
import { cursorDarkTheme } from "./themes/cursor-dark";
import type { CustomEditorTheme } from "../customEditorThemes";
import { shikiThemeExtension } from "./shiki/shikiTheme";
import { shikiLangForPath } from "./shiki/highlighterManager";

export const EDITOR_THEME_EXT: Record<EditorThemeId, Extension> = {
  atomone,
  aura,
  copilot,
  "cursor-dark": cursorDarkTheme,
  "github-dark": githubDark,
  "github-light": githubLight,
  "gruvbox-dark": gruvboxDark,
  nord,
  "tokyo-night": tokyoNight,
  "xcode-dark": xcodeDark,
  "xcode-light": xcodeLight,
};

// Runtime cache for built custom (Shiki) theme extensions. Keyed by
// `${themeId}::${langId}` so the returned Extension keeps a STABLE identity
// across renders (react-codemirror only reconfigures its theme compartment when
// the identity changes) while still rebuilding when the file's language changes.
const customExtCache = new Map<string, Extension>();

export function getEditorThemeExtension(
  id: string,
  customThemes: CustomEditorTheme[],
  path?: string,
): Extension {
  if (Object.prototype.hasOwnProperty.call(EDITOR_THEME_EXT, id)) {
    return EDITOR_THEME_EXT[id as EditorThemeId];
  }
  const custom = customThemes.find((t) => t.id === id);
  if (!custom) return EDITOR_THEME_EXT.atomone;
  const langId = shikiLangForPath(path);
  const key = `${id}::${langId}`;
  let ext = customExtCache.get(key);
  if (!ext) {
    ext = shikiThemeExtension(custom, langId);
    customExtCache.set(key, ext);
  }
  return ext;
}

export function invalidateCustomEditorThemeCache(id: string): void {
  for (const key of [...customExtCache.keys()]) {
    if (key === id || key.startsWith(`${id}::`)) customExtCache.delete(key);
  }
}
