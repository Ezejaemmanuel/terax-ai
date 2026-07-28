import { useEffect, useState } from "react";
import { fetchConfig } from "@/remote/lib/api";
import type { RemoteConfig } from "@/remote/lib/types";

/// Replies stay hidden until the server says otherwise, so an older host — or
/// one broadcasting read-only — never shows a composer that cannot send.
const READ_ONLY: RemoteConfig = {
  reply: { enabled: false, agents: [], maxLength: 0 },
};

/// Fetched once per page load. What the server permits only changes when the
/// broadcast restarts, which drops this page's connection anyway.
export function useConfig(): RemoteConfig {
  const [config, setConfig] = useState<RemoteConfig>(READ_ONLY);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch(() => {
        // Unreachable or unauthorized: useIndex surfaces both, and read-only is
        // the safe reading of a config we could not get.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
