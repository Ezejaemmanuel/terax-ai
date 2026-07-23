import { create } from "zustand";
import {
  broadcastStart,
  broadcastStatus,
  broadcastStop,
  emitBroadcastChanged,
  onBroadcastChanged,
  type BroadcastConfig,
  type BroadcastInfo,
} from "@/modules/broadcast/api";

type State = {
  info: BroadcastInfo | null;
  busy: boolean;
  error: string | null;
  hydrated: boolean;
  /** Idempotent: safe to call from every window. */
  init: () => Promise<void>;
  start: (config: BroadcastConfig) => Promise<void>;
  stop: () => Promise<void>;
};

let initialized = false;

export const useBroadcastStore = create<State>((set) => ({
  info: null,
  busy: false,
  error: null,
  hydrated: false,

  init: async () => {
    if (initialized) return;
    initialized = true;
    try {
      set({ info: await broadcastStatus(), hydrated: true });
    } catch {
      set({ hydrated: true });
    }
    void onBroadcastChanged((info) => set({ info }));
  },

  start: async (config) => {
    set({ busy: true, error: null });
    try {
      const info = await broadcastStart(config);
      set({ info, busy: false });
      await emitBroadcastChanged(info);
    } catch (e) {
      set({
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  stop: async () => {
    set({ busy: true, error: null });
    try {
      await broadcastStop();
      set({ info: null, busy: false });
      await emitBroadcastChanged(null);
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
