import { create } from "zustand";

type SessionTabState = {
  map: Map<string, number>; // sessionId → tabId (runtime only, not persisted)
  setMapping: (sessionId: string, tabId: number) => void;
  clearByTabId: (tabId: number) => void;
  clearStaleTabIds: (activeTabIds: Set<number>) => void;
  getTabId: (sessionId: string) => number | undefined;
};

// Module-level singleton — survives component unmounts (e.g. sidebar panel switches).
// tabIds are runtime values that reset on every app launch, so no disk persistence.
export const useSessionTabStore = create<SessionTabState>((set, get) => ({
  map: new Map(),

  setMapping: (sessionId, tabId) =>
    set((s) => {
      const next = new Map(s.map);
      next.set(sessionId, tabId);
      return { map: next };
    }),

  clearByTabId: (tabId) =>
    set((s) => {
      const next = new Map(s.map);
      for (const [sid, tid] of next) {
        if (tid === tabId) next.delete(sid);
      }
      return { map: next };
    }),

  // Removes all entries whose tabId is NOT in activeTabIds in a single set()
  // call — avoids N Map copies and N subscriber notifications when many tabs close.
  clearStaleTabIds: (activeTabIds) =>
    set((s) => {
      let changed = false;
      const next = new Map(s.map);
      for (const [sid, tid] of next) {
        if (!activeTabIds.has(tid)) {
          next.delete(sid);
          changed = true;
        }
      }
      return changed ? { map: next } : s;
    }),

  getTabId: (sessionId) => get().map.get(sessionId),
}));
