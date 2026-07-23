import { useCallback, useEffect, useState } from "react";
import { AuthError, fetchIndex } from "@/remote/lib/api";
import type { ProjectMeta } from "@/remote/lib/types";

/// The session list only: titles and timestamps, no message bodies. This is the
/// single payload fetched on page load, and it is refetched only when the
/// watcher says the set of sessions actually changed.
export function useIndex() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const reload = useCallback(() => {
    fetchIndex()
      .then((next) => {
        setProjects(next);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setLoading(false);
        if (e instanceof AuthError) {
          setUnauthorized(true);
          return;
        }
        setError(e instanceof Error ? e.message : "failed to load sessions");
      });
  }, []);

  useEffect(reload, [reload]);

  return { projects, loading, error, unauthorized, reload };
}
