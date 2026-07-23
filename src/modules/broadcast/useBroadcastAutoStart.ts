import { useEffect, useRef } from "react";
import { useBroadcastStore } from "@/modules/broadcast/useBroadcastStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { BROADCAST_NTFY_SERVER_DEFAULT } from "@/modules/settings/store";

/// Starts broadcasting once per app launch when the preference is on. Deliberately
/// one-shot: turning the toggle off in settings must not be undone by a rerender.
export function useBroadcastAutoStart(): void {
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const prefs = usePreferencesStore();
  const init = useBroadcastStore((s) => s.init);
  const fired = useRef(false);

  useEffect(() => {
    if (!hydrated || fired.current) return;
    fired.current = true;
    void (async () => {
      await init();
      const store = useBroadcastStore.getState();
      if (!prefs.broadcastAutoStart || store.info) return;
      await store.start({
        port: prefs.broadcastPort,
        ntfy: {
          enabled: prefs.broadcastNtfyEnabled,
          server: prefs.broadcastNtfyServer || BROADCAST_NTFY_SERVER_DEFAULT,
          topic: prefs.broadcastNtfyTopic,
        },
      });
    })();
  }, [
    hydrated,
    init,
    prefs.broadcastAutoStart,
    prefs.broadcastNtfyEnabled,
    prefs.broadcastNtfyServer,
    prefs.broadcastNtfyTopic,
    prefs.broadcastPort,
  ]);
}
