import { create } from "zustand";
import {
  listCustomEditorThemes,
  onCustomEditorThemesChange,
  type CustomEditorTheme,
} from "./customEditorThemes";

type State = {
  customEditorThemes: CustomEditorTheme[];
};

export const useCustomEditorThemesStore = create<State>(() => ({
  customEditorThemes: [],
}));

// Auto-initialize once on first import. Safe to import in any window.
let initPromise: Promise<void> | null = null;

export function ensureCustomEditorThemesInit(): Promise<void> {
  if (!initPromise) {
    initPromise = listCustomEditorThemes().then((themes) => {
      useCustomEditorThemesStore.setState({ customEditorThemes: themes });
      void onCustomEditorThemesChange(() => {
        void listCustomEditorThemes().then((updated) => {
          useCustomEditorThemesStore.setState({ customEditorThemes: updated });
        });
      });
    });
  }
  return initPromise;
}
