import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { VsCodeThemeJson } from "./lib/vscodeTheme";

export type CustomEditorTheme = {
  id: string;
  name: string;
  rawJson: VsCodeThemeJson;
};

const STORE_KEY = "themes";
const EVENT = "terax://editor-themes-changed";

const store = new LazyStore("terax-editor-themes.json", { defaults: {}, autoSave: 200 });

export async function listCustomEditorThemes(): Promise<CustomEditorTheme[]> {
  const v = await store.get<CustomEditorTheme[]>(STORE_KEY);
  return Array.isArray(v) ? v : [];
}

export async function saveCustomEditorTheme(theme: CustomEditorTheme): Promise<void> {
  const current = await listCustomEditorThemes();
  const next = current.filter((t) => t.id !== theme.id).concat(theme);
  await store.set(STORE_KEY, next);
  await store.save();
  await emit(EVENT);
}

export async function deleteCustomEditorTheme(id: string): Promise<void> {
  const current = await listCustomEditorThemes();
  const next = current.filter((t) => t.id !== id);
  if (next.length === current.length) return;
  await store.set(STORE_KEY, next);
  await store.save();
  await emit(EVENT);
}

export async function onCustomEditorThemesChange(cb: () => void): Promise<UnlistenFn> {
  const unsubLocal = await store.onChange((key) => {
    if (key === STORE_KEY) cb();
  });
  const unsubEvent = await listen(EVENT, () => cb());
  return () => {
    unsubLocal();
    unsubEvent();
  };
}
