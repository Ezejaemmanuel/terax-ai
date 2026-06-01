import { create } from "zustand";

export type ActiveFolder = {
  cwd: string;
  name: string;
  pinned: boolean;
};

type ActiveFolderState = {
  folders: ActiveFolder[];
  addFolder: (cwd: string, name: string) => void;
  removeFolder: (cwd: string) => void;
  pinFolder: (cwd: string) => void;
};

const PINNED_KEY = "terax.pinned-folders";

function loadPinned(): ActiveFolder[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate shape — drop any entry missing required string fields.
    return parsed.filter(
      (f): f is ActiveFolder =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as Record<string, unknown>).cwd === "string" &&
        typeof (f as Record<string, unknown>).name === "string",
    ).map((f) => ({ ...f, pinned: true })); // persisted entries are always pinned
  } catch {
    return [];
  }
}

function savePinned(folders: ActiveFolder[]) {
  try {
    localStorage.setItem(
      PINNED_KEY,
      JSON.stringify(folders.filter((f) => f.pinned)),
    );
  } catch {}
}

export const useActiveFolderStore = create<ActiveFolderState>((set) => ({
  // Pinned folders survive restarts; non-pinned start empty.
  folders: loadPinned(),

  addFolder: (cwd, name) =>
    set((s) => {
      if (s.folders.some((f) => f.cwd === cwd)) return s; // already present
      return { folders: [...s.folders, { cwd, name, pinned: false }] };
    }),

  removeFolder: (cwd) =>
    set((s) => {
      const next = s.folders.filter((f) => f.cwd !== cwd);
      savePinned(next);
      return { folders: next };
    }),

  pinFolder: (cwd) =>
    set((s) => {
      const next = s.folders.map((f) =>
        f.cwd === cwd ? { ...f, pinned: !f.pinned } : f,
      );
      savePinned(next);
      return { folders: next };
    }),
}));
