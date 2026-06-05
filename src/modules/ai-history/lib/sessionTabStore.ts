import { create } from "zustand";

type SessionTabState = {
  map: Map<string, number>;        // sessionId → tabId
  tabTitles: Map<number, string>;  // tabId → session title (for terminal list display)
  sessionIds: Map<number, string>; // tabId → bound Claude session id (for the badge)
  setMapping: (sessionId: string, tabId: number, sessionTitle: string) => void;
  setTabTitle: (tabId: number, title: string) => void;
  linkSession: (sessionId: string, tabId: number) => void;
  clearByTabId: (tabId: number) => void;
  clearStaleTabIds: (activeTabIds: Set<number>) => void;
  getTabId: (sessionId: string) => number | undefined;
  getSessionTitle: (tabId: number) => string | undefined;
};

// Module-level singleton — survives component unmounts (e.g. sidebar panel switches).
// tabIds are runtime values that reset on every app launch, so no disk persistence.
export const useSessionTabStore = create<SessionTabState>((set, get) => ({
  map: new Map(),
  tabTitles: new Map(),
  sessionIds: new Map(),

  setMapping: (sessionId, tabId, sessionTitle) =>
    set((s) => {
      const nextMap = new Map(s.map);
      nextMap.set(sessionId, tabId);
      const nextTitles = new Map(s.tabTitles);
      nextTitles.set(tabId, sessionTitle);
      return { map: nextMap, tabTitles: nextTitles };
    }),

  // Binds a discovered Claude session id to a tab (from the agent hook) without
  // touching the title. A tab hosts one session, so any other id pointing at
  // this tab is dropped first. Lets re-opening that chat switch to the running
  // terminal instead of spawning a duplicate.
  linkSession: (sessionId, tabId) =>
    set((s) => {
      if (s.map.get(sessionId) === tabId) return s;
      const nextMap = new Map(s.map);
      for (const [sid, tid] of nextMap) {
        if (tid === tabId) nextMap.delete(sid);
      }
      nextMap.set(sessionId, tabId);
      const nextIds = new Map(s.sessionIds);
      nextIds.set(tabId, sessionId);
      return { map: nextMap, sessionIds: nextIds };
    }),

  // Title-only update for tabs that have no Claude session id yet (new sessions,
  // manual launches). Keyed by tabId so the terminal list can show "Claude".
  setTabTitle: (tabId, title) =>
    set((s) => {
      if (s.tabTitles.get(tabId) === title) return s;
      const nextTitles = new Map(s.tabTitles);
      nextTitles.set(tabId, title);
      return { tabTitles: nextTitles };
    }),

  clearByTabId: (tabId) =>
    set((s) => {
      const nextMap = new Map(s.map);
      for (const [sid, tid] of nextMap) {
        if (tid === tabId) nextMap.delete(sid);
      }
      const nextTitles = new Map(s.tabTitles);
      nextTitles.delete(tabId);
      const nextIds = new Map(s.sessionIds);
      nextIds.delete(tabId);
      return { map: nextMap, tabTitles: nextTitles, sessionIds: nextIds };
    }),

  // Removes all entries whose tabId is NOT in activeTabIds in a single set()
  // call — avoids N Map copies and N subscriber notifications when many tabs close.
  clearStaleTabIds: (activeTabIds) =>
    set((s) => {
      let changed = false;
      const nextMap = new Map(s.map);
      const nextTitles = new Map(s.tabTitles);
      const nextIds = new Map(s.sessionIds);
      for (const [sid, tid] of nextMap) {
        if (!activeTabIds.has(tid)) {
          nextMap.delete(sid);
          nextTitles.delete(tid);
          nextIds.delete(tid);
          changed = true;
        }
      }
      return changed
        ? { map: nextMap, tabTitles: nextTitles, sessionIds: nextIds }
        : s;
    }),

  getTabId: (sessionId) => get().map.get(sessionId),
  getSessionTitle: (tabId) => get().tabTitles.get(tabId),
}));
