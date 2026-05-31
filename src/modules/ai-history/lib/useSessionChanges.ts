import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useState, useEffect, useCallback, useRef } from "react";
import type { AiSession } from "./useAiHistory";

export type SessionChangesState = {
  files: string[];
  hasGit: boolean | null;
  loading: boolean;
  initGit: () => Promise<void>;
  getDiff: (filePath: string) => Promise<string>;
  refresh: () => void;
};

export function useSessionChanges(
  session: AiSession | null,
  tool: "claude" | "codex",
): SessionChangesState {
  const [files, setFiles] = useState<string[]>([]);
  const [hasGit, setHasGit] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  // Generation counter — incremented on each load() call so a slow earlier
  // response can detect it's stale and not overwrite newer state.
  const genRef = useRef(0);

  const load = useCallback(async () => {
    if (!session) return;
    const gen = ++genRef.current;
    setLoading(true);
    try {
      const [changedFiles, gitOk] = await Promise.all([
        // Pass the known JSONL path directly — no directory scan needed.
        invoke<string[]>("session_changed_files", {
          jsonlPath: session.jsonlPath,
        }),
        invoke<boolean>("session_check_git", { cwd: session.cwd }),
      ]);
      if (gen !== genRef.current) return; // stale — a newer load() completed first
      setFiles(changedFiles);
      setHasGit(gitOk);
    } catch {
      // leave previous state on error
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    setFiles([]);
    setHasGit(null);
    void load();
  }, [load]);

  // Re-fetch only when this session's tool changes (not on unrelated tools' events).
  useEffect(() => {
    if (!session) return;
    const win = getCurrentWebviewWindow();
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    win
      .listen<string>("ai:history_changed", (event) => {
        if (event.payload === tool) void load();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenFn = fn;
      });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [session, tool, load]);

  const initGit = useCallback(async () => {
    if (!session) return;
    await invoke("session_git_init", { cwd: session.cwd });
    setHasGit(true);
  }, [session]);

  const getDiff = useCallback(
    async (filePath: string): Promise<string> => {
      if (!session) return "";
      return invoke<string>("session_file_diff", {
        cwd: session.cwd,
        filePath,
      });
    },
    [session],
  );

  return { files, hasGit, loading, initGit, getDiff, refresh: load };
}
