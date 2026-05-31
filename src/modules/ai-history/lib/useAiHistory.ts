import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relativeTime } from "@/lib/relativeTime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AiSession = {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  jsonlPath: string;
};

export type AiProject = {
  name: string;
  fullPath: string;
  sessions: AiSession[];
};

type RawSession = { id: string; title: string; updated_at: string; cwd: string; jsonl_path: string };
type RawProject = { name: string; full_path: string; sessions: RawSession[] };

function toProject(raw: RawProject): AiProject {
  return {
    name: raw.name,
    fullPath: raw.full_path,
    sessions: raw.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updated_at,
      cwd: s.cwd,
      jsonlPath: s.jsonl_path,
    })),
  };
}

export { relativeTime };

const SESSIONS_INITIAL = 6;

export function useAiHistory(tool: "claude" | "codex") {
  const [projects, setProjects] = useState<AiProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const loadedTool = useRef<string | null>(null);

  useEffect(() => {
    // Reset state when tool changes
    setLoading(true);
    setError(null);
    setSearch("");
    setCollapsed(new Set());
    setExpanded(new Set());
    loadedTool.current = tool;

    const command = tool === "claude" ? "ai_history_claude" : "ai_history_codex";
    invoke<RawProject[]>(command)
      .then((raw) => {
        if (loadedTool.current !== tool) return; // stale
        setProjects(raw.map(toProject));
        setLoading(false);
      })
      .catch((err) => {
        if (loadedTool.current !== tool) return;
        setError(String(err));
        setLoading(false);
      });
  }, [tool]);

  // Silent background refresh — no loading spinner, just updates the list.
  const refreshProjects = useCallback(() => {
    const command = tool === "claude" ? "ai_history_claude" : "ai_history_codex";
    invoke<RawProject[]>(command)
      .then((raw) => setProjects(raw.map(toProject)))
      .catch(() => {});
  }, [tool]);

  // Start the backend recursive watcher once per tool and re-fetch on changes.
  useEffect(() => {
    void invoke("ai_history_watch", { tool }).catch(() => {});

    const win = getCurrentWebviewWindow();
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;
    win
      .listen<string>("ai:history_changed", (event) => {
        if (event.payload === tool) refreshProjects();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenFn = fn;
      });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [tool, refreshProjects]);

  const filtered = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects
      .map((p) => ({
        ...p,
        sessions: p.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.sessions.length > 0);
  }, [projects, search]);

  const toggleCollapse = useCallback((projectPath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectPath)) next.delete(projectPath);
      else next.add(projectPath);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((projectPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(projectPath)) next.delete(projectPath);
      else next.add(projectPath);
      return next;
    });
  }, []);

  const visibleSessions = useCallback(
    (project: AiProject) => {
      const isExpanded = expanded.has(project.fullPath);
      return isExpanded ? project.sessions : project.sessions.slice(0, SESSIONS_INITIAL);
    },
    [expanded],
  );

  const hiddenCount = useCallback(
    (project: AiProject) => {
      if (expanded.has(project.fullPath)) return 0;
      return Math.max(0, project.sessions.length - SESSIONS_INITIAL);
    },
    [expanded],
  );

  return {
    projects: filtered,
    loading,
    error,
    search,
    setSearch,
    collapsed,
    toggleCollapse,
    toggleExpand,
    visibleSessions,
    hiddenCount,
    SESSIONS_INITIAL,
  };
}
