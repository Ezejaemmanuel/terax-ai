import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowLeft01Icon,
  File01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiSessionDiffTab } from "@/modules/tabs/lib/useTabs";

type SessionFileChange = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified" | "unchanged";
};

type Props = {
  tab: AiSessionDiffTab;
  onClose: () => void;
};

function splitPath(p: string): { name: string; dir: string } {
  const parts = p.replace(/\\/g, "/").split("/");
  const name = parts.pop() ?? p;
  return { name, dir: parts.join("/") };
}

export const AiSessionDiffPane = memo(function AiSessionDiffPane({
  tab,
  onClose,
}: Props) {
  const [changes, setChanges] = useState<SessionFileChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const load = useCallback(async () => {
    const res = await invoke<SessionFileChange[]>("session_changes", {
      jsonlPath: tab.jsonlPath,
      cwd: tab.cwd,
    });
    if (cancelRef.current) return;
    setChanges(res);
    // Keep the current selection if it still exists, otherwise pick the first.
    setSelected((prev) =>
      prev && res.some((c) => c.path === prev)
        ? prev
        : (res[0]?.path ?? null),
    );
  }, [tab.jsonlPath, tab.cwd]);

  useEffect(() => {
    cancelRef.current = false;
    setLoading(true);
    setChanges([]);
    setSelected(null);
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

  // Live-refresh while the session is still running (new edits land in the JSONL).
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    win
      .listen<string>("ai:history_changed", (event) => {
        if (event.payload === "claude") void load();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [load]);

  const selectedChange = useMemo(
    () => changes.find((c) => c.path === selected) ?? null,
    [changes, selected],
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
          {/* File list sidebar */}
          <div className="w-64 shrink-0 overflow-y-auto border-r border-border/50 [scrollbar-gutter:stable]">
            {changes.map((c) => (
              <FileRow
                key={c.path}
                change={c}
                active={c.path === selected}
                onSelect={() => setSelected(c.path)}
              />
            ))}
          </div>

          {/* Inline diff */}
          <div className="min-w-0 flex-1 overflow-auto bg-background/60">
            {selectedChange ? (
              selectedChange.diff.trim() === "" ? (
                <p className="px-4 py-4 text-[11px] text-muted-foreground/60">
                  No net changes for this file in the session.
                </p>
              ) : (
                <DiffView diff={selectedChange.diff} />
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

// ── FileRow (sidebar entry) ──────────────────────────────────────────────────

const STATUS_ACCENT: Record<SessionFileChange["status"], string> = {
  added: "bg-emerald-500",
  deleted: "bg-red-500",
  modified: "bg-amber-500",
  unchanged: "bg-muted-foreground/30",
};

const FileRow = memo(function FileRow({
  change,
  active,
  onSelect,
}: {
  change: SessionFileChange;
  active: boolean;
  onSelect: () => void;
}) {
  const { name, dir } = splitPath(change.path);
  return (
    <button
      type="button"
      onClick={onSelect}
      title={change.path}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left transition-colors",
        active
          ? "border-primary bg-foreground/[0.06]"
          : "border-transparent hover:bg-foreground/[0.04]",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          STATUS_ACCENT[change.status],
        )}
        aria-hidden
      />
      <HugeiconsIcon
        icon={File01Icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground/60"
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] text-foreground/90">
          {name}
        </span>
        {dir && (
          <span className="block truncate text-[10px] text-muted-foreground/55">
            {dir}
          </span>
        )}
      </div>
      <span className="shrink-0 font-mono text-[9.5px] leading-tight">
        {change.additions > 0 && (
          <span className="text-emerald-400">+{change.additions}</span>
        )}
        {change.additions > 0 && change.deletions > 0 && " "}
        {change.deletions > 0 && (
          <span className="text-red-400">−{change.deletions}</span>
        )}
      </span>
    </button>
  );
});

// ── DiffView ─────────────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="min-w-full p-2 font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith("+++") || line.startsWith("---")) {
          return (
            <span key={i} className="block text-muted-foreground/70">
              {line}
            </span>
          );
        }
        if (line.startsWith("diff --git")) {
          return (
            <span key={i} className="block text-muted-foreground/50">
              {line}
            </span>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <span key={i} className="block text-blue-400/80">
              {line}
            </span>
          );
        }
        if (line.startsWith("+")) {
          return (
            <span key={i} className="block bg-emerald-500/10 text-emerald-400">
              {line}
            </span>
          );
        }
        if (line.startsWith("-")) {
          return (
            <span key={i} className="block bg-red-500/10 text-red-400">
              {line}
            </span>
          );
        }
        return (
          <span key={i} className="block text-foreground/70">
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}
