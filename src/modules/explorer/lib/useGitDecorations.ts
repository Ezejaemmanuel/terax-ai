import { CASE_INSENSITIVE_FS } from "@/lib/platform";
import type { SourceControlSummary } from "@/modules/source-control";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  buildDecorationMap,
  normalizePath,
  type GitDecoration,
} from "./gitDecoration";

export type GitDecorations = {
  decorationFor: (path: string) => GitDecoration | undefined;
  refreshGit: () => void;
};

/**
 * Exposes a per-path git decoration lookup for the file tree, driven by the
 * single app-wide {@link SourceControlSummary} that also feeds the Source
 * Control panel and the status-bar badge. Sharing that one instance means the
 * tree, panel, and badge always render the same snapshot — staging/committing
 * in the panel updates the tree without spawning a second `git status`
 * pipeline. The file-watcher refresh that keeps this snapshot live is wired in
 * {@link App} so it runs regardless of which sidebar view is mounted.
 */
export function useGitDecorations(
  sourceControl: SourceControlSummary,
): GitDecorations {
  const { status, refresh } = sourceControl;

  // Reuse decoration object identity for unchanged paths across refreshes, so
  // the memoized EntryRow can bail out instead of re-rendering every visible
  // row on each (debounced) status refresh.
  const prevDecorationsRef = useRef<Map<string, GitDecoration>>(new Map());
  const decorations = useMemo(() => {
    const next = status
      ? buildDecorationMap(status.repoRoot, status.changedFiles, CASE_INSENSITIVE_FS)
      : new Map<string, GitDecoration>();
    const prev = prevDecorationsRef.current;
    for (const [key, value] of next) {
      const old = prev.get(key);
      if (
        old &&
        old.status === value.status &&
        old.badge === value.badge &&
        old.isDir === value.isDir
      ) {
        next.set(key, old);
      }
    }
    prevDecorationsRef.current = next;
    return next;
  }, [status]);

  // Keep a stable ref to refresh so refreshGit's identity never changes as
  // refresh re-binds (it depends on contextPath). The file-watcher refresh
  // itself lives in App so it runs even when the explorer is unmounted.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const decorationFor = useCallback(
    (path: string): GitDecoration | undefined =>
      decorations.get(normalizePath(path, CASE_INSENSITIVE_FS)),
    [decorations],
  );

  const refreshGit = useCallback(() => {
    void refreshRef.current({ remote: "never" });
  }, []);

  return { decorationFor, refreshGit };
}
