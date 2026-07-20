import { create } from "zustand";
import type {
  AgentNotification,
  AgentSession,
  AgentStatus,
  LocalAgentState,
} from "../lib/types";

const MAX_NOTIFICATIONS = 50;

let notifSeq = 0;

type AgentStoreState = {
  sessions: Record<number, AgentSession>;
  /** Per-tab "last time this chat did something", keyed by tabId and kept after
   * the session is gone. The terminal list sorts on this so a chat you just
   * messaged moves to the top and STAYS there once the run ends — unlike the
   * session record, which `finish` deletes. */
  activityOrder: Record<number, number>;
  localAgent: LocalAgentState;
  notifications: AgentNotification[];
  start: (leafId: number, tabId: number, agent: string) => void;
  setStatus: (leafId: number, status: AgentStatus) => void;
  /** Restore the persisted per-tab activity order on startup. Merges rather
   * than replaces, so an agent that already reported in during boot keeps its
   * newer timestamp. */
  seedActivityOrder: (order: Record<number, number>) => void;
  /** Mark the current status as seen, so the row stops showing a dot until the
   * next status event. No-op if there's no session or it's already acknowledged. */
  acknowledge: (leafId: number) => void;
  finish: (leafId: number) => void;
  setLocalAgent: (state: LocalAgentState) => void;
  pushNotification: (
    n: Omit<AgentNotification, "id" | "at" | "read">,
  ) => void;
  markAllRead: () => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
};

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  activityOrder: {},
  localAgent: null,
  notifications: [],

  start: (leafId, tabId, agent) =>
    set((s) => {
      const now = Date.now();
      return {
        activityOrder: { ...s.activityOrder, [tabId]: now },
        sessions: {
          ...s.sessions,
          [leafId]: {
            leafId,
            tabId,
            agent,
            status: "working",
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
            acknowledged: false,
          },
        },
      };
    }),

  setStatus: (leafId, status) =>
    set((s) => {
      const prev = s.sessions[leafId];
      // Each status signal is a discrete hook event (working/attention/finished),
      // so even a same-status repeat (e.g. a second permission request) must
      // re-show the dot and bump recency — don't short-circuit on equal status.
      if (!prev) return s;
      const now = Date.now();
      return {
        activityOrder: { ...s.activityOrder, [prev.tabId]: now },
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            status,
            lastActivityAt: now,
            attentionSince: status === "waiting" ? now : null,
            // A new event always re-shows the dot until seen again.
            acknowledged: false,
          },
        },
      };
    }),

  seedActivityOrder: (order) =>
    set((s) => {
      const next = { ...s.activityOrder };
      for (const [tabId, at] of Object.entries(order)) {
        const id = Number(tabId);
        if (!(next[id] > at)) next[id] = at;
      }
      return { activityOrder: next };
    }),

  acknowledge: (leafId) =>
    set((s) => {
      const prev = s.sessions[leafId];
      // "working" is a live progress indicator, not a read-receipt — keep the
      // dot visible even on the terminal you're viewing. Only completed/awaiting
      // (the "you have something to look at" states) clear on open.
      if (!prev || prev.acknowledged || prev.status === "working") return s;
      return {
        sessions: { ...s.sessions, [leafId]: { ...prev, acknowledged: true } },
      };
    }),

  finish: (leafId) =>
    set((s) => {
      if (!s.sessions[leafId]) return s;
      const next = { ...s.sessions };
      delete next[leafId];
      return { sessions: next };
    }),

  setLocalAgent: (state) =>
    set((s) => {
      const a = s.localAgent;
      if (a === state) return s;
      if (a && state && a.status === state.status && a.agent === state.agent) {
        return s;
      }
      return { localAgent: state };
    }),

  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s;
      return { notifications: s.notifications.map((n) => ({ ...n, read: true })) };
    }),

  removeNotification: (id) =>
    set((s) => {
      const next = s.notifications.filter((n) => n.id !== id);
      return next.length === s.notifications.length ? s : { notifications: next };
    }),

  clearNotifications: () =>
    set((s) => (s.notifications.length === 0 ? s : { notifications: [] })),
}));
