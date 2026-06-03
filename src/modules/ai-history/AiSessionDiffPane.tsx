import { cn } from "@/lib/utils";
import { CASE_INSENSITIVE_FS } from "@/lib/platform";
import {
  fileIconUrl,
  folderIconUrl,
} from "@/modules/explorer/lib/iconResolver";
import {
  basename,
  dirname,
  flattenFileTree,
  statusBadgeClass,
} from "@/modules/source-control/lib/fileTree";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  File02Icon,
  FolderTreeIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiSessionDiffTab } from "@/modules/tabs/lib/useTabs";
import { SessionDiffEditor } from "./SessionDiffEditor";

type SessionStatus = "added" | "deleted" | "modified" | "unchanged";

type SessionFileChange = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  status: SessionStatus;
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
};

type Props = {
  tab: AiSessionDiffTab;
  onClose: () => void;
};

const VIEW_MODE_KEY = "terax.session-diff.viewMode";
type ViewMode = "list" | "tree";

// Map the session status to the single-letter git code used by statusBadgeClass.
const STATUS_CODE: Record<SessionStatus, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  unchanged: "",
};

export const AiSessionDiffPane = memo(function AiSessionDiffPane({
  tab,
  onClose,
}: Props) {
  const [changes, setChanges] = useState<SessionFileChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      if (v === "list" || v === "tree") return v;
    } catch {
      /* ignore */
    }
    return "tree";
  });
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );

  const load = useCallback(async () => {
    const res = await invoke<SessionFileChange[]>("session_changes", {
      jsonlPath: tab.jsonlPath,
      cwd: tab.cwd,
    });
    if (cancelRef.current) return;
    setChanges(res);
  }, [tab.jsonlPath, tab.cwd]);

  useEffect(() => {
    cancelRef.current = false;
    setLoading(true);
    setChanges([]);
    setSelected(null);
    setCollapsedFolders(new Set());
    load()
      .catch(() => {
        if (!cancelRef.current) setChanges([]);
      })
      .finally(() => {
        if (!cancelRef.current) setLoading(false);
      });
    return () => {
      cancelRef.current = true;
    };
  }, [load]);

  // Live-refresh while the session is still running (new edits land in the
  // JSONL). Debounced so a burst of writes triggers one reload, not dozens —
  // each reload spawns git, so unbounded refresh would hammer the backend.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    win
      .listen<string>("ai:history_changed", (event) => {
        if (event.payload !== tab.tool) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void load();
        }, 350);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [load, tab.tool]);

  // Session file paths are absolute (e.g. C:\Users\…\src\file.ts). Display them
  // relative to the session cwd so the tree is rooted at the project instead of
  // exploding into drive-letter / home-directory folders. `path` becomes the
  // relative path used for grouping, selection, and the diff; absolute paths
  // outside cwd keep their full path (still unique).
  const relChanges = useMemo(() => {
    const root = tab.cwd.replace(/\\/g, "/").replace(/\/$/, "");
    const prefix = `${root}/`;
    return changes.map((c) => {
      const abs = c.path.replace(/\\/g, "/");
      const head = abs.slice(0, prefix.length);
      const inCwd = CASE_INSENSITIVE_FS
        ? head.toLowerCase() === prefix.toLowerCase()
        : head === prefix;
      return { ...c, path: inCwd ? abs.slice(prefix.length) : abs };
    });
  }, [changes, tab.cwd]);

  // Keep the current selection if it still exists, otherwise pick the first.
  // Runs after each (live) reload, in the same relative-path space as the tree.
  useEffect(() => {
    setSelected((prev) =>
      prev && relChanges.some((c) => c.path === prev)
        ? prev
        : (relChanges[0]?.path ?? null),
    );
  }, [relChanges]);

  const selectedChange = useMemo(
    () => relChanges.find((c) => c.path === selected) ?? null,
    [relChanges, selected],
  );

  const totals = useMemo(
    () =>
      changes.reduce(
        (acc, c) => {
          acc.add += c.additions;
          acc.del += c.deletions;
          return acc;
        },
        { add: 0, del: 0 },
      ),
    [changes],
  );

  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next = prev === "list" ? "tree" : "list";
      try {
        localStorage.setItem(VIEW_MODE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const nodes = useMemo(
    () =>
      viewMode === "tree"
        ? flattenFileTree(relChanges, collapsedFolders)
        : relChanges.map((entry) => ({ kind: "file" as const, entry, depth: 0 })),
    [relChanges, collapsedFolders, viewMode],
  );

  const shortPath = tab.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/");

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 bg-card/60 px-4 py-2">
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={13} strokeWidth={2} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-foreground/90">
            {tab.title}
          </p>
          <p className="truncate text-[10.5px] text-muted-foreground/60">
            {shortPath}
          </p>
        </div>
        {!loading && changes.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 text-[10.5px]">
            <span className="text-muted-foreground/60">
              {changes.length} {changes.length === 1 ? "file" : "files"}
            </span>
            <span className="font-mono text-emerald-400">+{totals.add}</span>
            <span className="font-mono text-red-400">−{totals.del}</span>
          </div>
        )}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-muted-foreground">
          <HugeiconsIcon
            icon={Loading03Icon}
            size={14}
            strokeWidth={1.75}
            className="animate-spin"
          />
          Loading changed files…
        </div>
      ) : changes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
          No file changes recorded for this session.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* File list / tree sidebar */}
          <div className="flex w-60 shrink-0 flex-col border-r border-border/50">
            <div className="flex h-7 shrink-0 items-center justify-between px-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
                Changed files
              </span>
              <button
                type="button"
                onClick={toggleViewMode}
                aria-label={
                  viewMode === "list"
                    ? "Switch to tree view"
                    : "Switch to list view"
                }
                title={viewMode === "list" ? "Tree view" : "List view"}
                className={cn(
                  "inline-flex size-5 items-center justify-center rounded transition-colors",
                  "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                  viewMode === "tree" && "bg-foreground/[0.06] text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={viewMode === "list" ? FolderTreeIcon : File02Icon}
                  size={12}
                  strokeWidth={1.8}
                />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
              {nodes.map((node) =>
                node.kind === "folder" ? (
                  <FolderRow
                    key={`folder:${node.path}`}
                    name={node.name}
                    depth={node.depth}
                    count={node.childCount}
                    collapsed={collapsedFolders.has(node.path)}
                    onToggle={() => toggleFolder(node.path)}
                  />
                ) : (
                  <FileRow
                    key={node.entry.path}
                    change={node.entry}
                    depth={viewMode === "tree" ? node.depth : 0}
                    showDir={viewMode === "list"}
                    active={node.entry.path === selected}
                    onSelect={() => setSelected(node.entry.path)}
                  />
                ),
              )}
            </div>
          </div>

          {/* Diff — rendered at normal editor size, like Source Control. */}
          <div className="min-w-0 flex-1 overflow-hidden bg-background/60">
            {selectedChange ? (
              selectedChange.status === "unchanged" ? (
                <p className="px-4 py-4 text-[11px] text-muted-foreground/60">
                  No net changes for this file in the session.
                </p>
              ) : (
                <SessionDiffEditor
                  key={selectedChange.path}
                  path={selectedChange.path}
                  originalContent={selectedChange.originalContent}
                  modifiedContent={selectedChange.modifiedContent}
                  isBinary={selectedChange.isBinary}
                  fallbackPatch={selectedChange.diff}
                />
              )
            ) : (
              <p className="px-4 py-4 text-[11px] text-muted-foreground/60">
                Select a file to view its diff.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ── FolderRow ────────────────────────────────────────────────────────────────

const FolderRow = memo(function FolderRow({
  name,
  depth,
  count,
  collapsed,
  onToggle,
}: {
  name: string;
  depth: number;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{ paddingLeft: `${6 + depth * 12}px` }}
      className="flex h-6 w-full items-center gap-1.5 pr-2 text-left transition-colors hover:bg-foreground/[0.04]"
    >
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        size={9}
        strokeWidth={2.4}
        className={cn(
          "shrink-0 text-muted-foreground/60 transition-transform duration-100",
          !collapsed && "rotate-90",
        )}
      />
      <img src={folderIconUrl(name, !collapsed)} alt="" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/85">
        {name}
      </span>
      <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/50">
        {count}
      </span>
    </button>
  );
});

// ── FileRow ──────────────────────────────────────────────────────────────────

const FileRow = memo(function FileRow({
  change,
  depth,
  showDir,
  active,
  onSelect,
}: {
  change: SessionFileChange;
  depth: number;
  showDir: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const name = basename(change.path);
  const dir = dirname(change.path);
  const code = STATUS_CODE[change.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      title={change.path}
      style={{ paddingLeft: `${6 + depth * 12}px` }}
      className={cn(
        "flex h-7 w-full items-center gap-1.5 border-l-2 pr-2 text-left transition-colors",
        active
          ? "border-primary bg-foreground/[0.06]"
          : "border-transparent hover:bg-foreground/[0.04]",
      )}
    >
      <img src={fileIconUrl(name)} alt="" className="size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-[11px] text-foreground/90">{name}</span>
        {showDir && dir && (
          <span className="min-w-0 flex-1 truncate text-[9.5px] text-muted-foreground/50">
            {dir}
          </span>
        )}
      </div>
      <span className="shrink-0 font-mono text-[9px] leading-tight">
        {change.additions > 0 && (
          <span className="text-emerald-400">+{change.additions}</span>
        )}
        {change.additions > 0 && change.deletions > 0 && " "}
        {change.deletions > 0 && (
          <span className="text-red-400">−{change.deletions}</span>
        )}
      </span>
      {code && (
        <span
          className={cn(
            "w-3 shrink-0 text-center text-[10px] font-semibold leading-none",
            statusBadgeClass(code),
          )}
          aria-hidden
        >
          {code}
        </span>
      )}
    </button>
  );
});
