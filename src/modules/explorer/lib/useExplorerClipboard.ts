import { create } from "zustand";

export type ClipboardMode = "copy" | "cut";

type ClipboardState = {
  /** Absolute paths placed on the clipboard. */
  entries: string[];
  /** `null` when the clipboard is empty. */
  mode: ClipboardMode | null;
  set: (entries: string[], mode: ClipboardMode) => void;
  clear: () => void;
};

/**
 * The explorer's internal cut/copy clipboard. Kept in a global store (rather
 * than component state) so a copy survives selection changes and re-mounts,
 * matching how a file-manager clipboard behaves.
 */
export const useExplorerClipboard = create<ClipboardState>((set) => ({
  entries: [],
  mode: null,
  set: (entries, mode) => set({ entries: [...entries], mode }),
  clear: () => set({ entries: [], mode: null }),
}));
